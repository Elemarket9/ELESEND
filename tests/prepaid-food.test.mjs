import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {restaurantOrderService} from '../services/api/restaurant-orders.mjs';
import {checkoutService} from '../services/api/checkout.mjs';
import {digitalDeliveryCompleted} from '../services/api/checkout-accounting.mjs';
import {foodDispatchAllowed} from '../services/api/food-payment.mjs';
import {notificationWorker} from '../services/api/notifications.mjs';
import {moneyOperations} from '../services/api/money-operations.mjs';
import {restaurantService} from '../services/api/restaurant.mjs';
import {financeService,balance,journal,postCashCommission} from '../services/api/finance.mjs';
import {backgroundJobs} from '../services/api/background-jobs.mjs';
import {dispatchEngine} from '../services/api/dispatch.mjs';
import {platform as platformService} from '../services/api/platform.mjs';
import {paymentWebhook} from '../services/api/payment-provider.mjs';
import {commissionEngine} from '../services/api/commission-engine.mjs';
import {
 getGhanaWeekKey,
 evaluateRiderWeeklyEligibility,
 getRiderWeeklyBalance,
 getRiderWeeklyHistory,
 getRiderWeeklySummary,
 getAdminSettlementOverview,
 updateWeeklySettlementSettings
} from '../services/api/weekly-settlement.mjs';

const url=process.env.TEST_DATABASE_URL;
test('prepaid food database controls',{skip:!url},async t=>{
 assert.match(new URL(url).pathname,/^\/elesend_test/,'Requires dedicated test database');
 const root=database(url);
 try{
  await migrate(root);
  async function fixture(fn){
   const c=await root.pool.connect();await c.query('BEGIN');
   let savepoint=0;
   const db={query:(...a)=>c.query(...a),async tx(f){const name='case_'+(++savepoint);await c.query('SAVEPOINT '+name);try{const result=await f(c);await c.query('RELEASE SAVEPOINT '+name);return result;}catch(e){await c.query('ROLLBACK TO SAVEPOINT '+name);throw e;}}};
   try{
    const customer=randomUUID(),owner=randomUUID(),restaurant=randomUUID(),item=randomUUID(),policy=randomUUID();
    for(const [id,kind] of [[customer,'customer'],[owner,'business']])await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'test-only',$3,now())",[id,'+2332'+String(randomInt(10000000,99999999)),kind]);
    await c.query('UPDATE pricing_policies SET active=false');
    await c.query("INSERT INTO pricing_policies(id,base_minor,per_km_minor,commission_bps,vehicle) VALUES($1,1000,100,1300,'motorcycle')",[policy]);
    await c.query("INSERT INTO restaurants(id,owner_id,name,phone,address,latitude,longitude,status) VALUES($1,$2,'Test Kitchen','+233241234567','Test Kitchen Address',5.60,-0.18,'approved')",[restaurant,owner]);
    await c.query("INSERT INTO menu_items(id,restaurant_id,name,price_minor) VALUES($1,$2,'Test food',5000)",[item,restaurant]);
    await c.query("UPDATE checkout_method_policies SET enabled=true WHERE method='MOMO'");
    const actor={id:customer,kind:'customer'},kitchen={id:owner,kind:'business'};
    const input={restaurantId:restaurant,items:[{itemId:item,quantity:1,options:[]}],deliveryAddress:'Test destination',deliveryLatitude:5.61,deliveryLongitude:-0.19,customerPhone:'0241234567'};
    const food=restaurantOrderService(db,{routing:{route:async()=>({distanceMeters:2000,durationSeconds:300})}});
    const key=randomUUID();
    const order=await food.createFoodOrder(actor,input,{paymentMethod:'MOMO',idempotencyKey:key});
    let receipt;
    const provider={name:'fixture',methods:['MOMO'],allowedCheckoutHosts:['checkout.test'],createCheckout:async x=>({reference:x.reference,checkoutUrl:'https://checkout.test/pay'}),verifyPayment:async()=>receipt,parseVerifiedWebhook:async()=>receipt};
    const checkout=checkoutService(db,{provider});
    const pay=async(amount=Number(order.total_minor))=>{
     const intent=await checkout.initiate(actor,order.shipment_id,{idempotencyKey:randomUUID()});
     receipt={reference:intent.reference,status:'success',amountMinor:amount,currency:'GHS',channel:'mobile_money',eventId:'evt_'+randomUUID()};
     return checkout.webhook(Buffer.from('{}'),{});
    };
    const setReceipt=value=>{receipt=value;};
    async function admins(){const actors=[];for(let i=0;i<2;i++){const id=randomUUID();await c.query("INSERT INTO users(id,phone,password_hash,kind) VALUES($1,$2,'fixture','admin')",[id,'+2332'+String(randomInt(10000000,99999999))]);await c.query("INSERT INTO permissions(user_id,permission) VALUES($1,'finance:configure'),($1,'finance:approve'),($1,'verification:write')",[id]);actors.push({id,kind:'admin'});}return actors;}
    await fn({db,c,food,checkout,actor,kitchen,input,order,key,pay,setReceipt,provider,admins});
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
   }finally{await c.query('ROLLBACK');c.release();}
  }
  await t.test('market suspension blocks food quotations and new orders',()=>fixture(async({food,actor,input,c})=>{
   await c.query("UPDATE service_markets SET service_enabled=false WHERE country_code='GH'");
   await assert.rejects(food.quoteFoodOrder(actor,input),/administratively paused/);
   await assert.rejects(food.createFoodOrder(actor,input,{paymentMethod:'MOMO',idempotencyKey:randomUUID()}),/administratively paused/);
  }));
  await t.test('cash rejected, retry idempotent and unpaid kitchen blocked',()=>fixture(async({food,actor,kitchen,input,order,key,db})=>{
   await assert.rejects(food.createFoodOrder(actor,input,{paymentMethod:'CASH',idempotencyKey:randomUUID()}),/upfront/);
   assert.equal((await food.createFoodOrder(actor,input,{paymentMethod:'MOMO',idempotencyKey:key})).id,order.id);
   await assert.rejects(food.createFoodOrder(actor,{...input,deliveryAddress:'Different destination'},{paymentMethod:'MOMO',idempotencyKey:key}),/Idempotency/);
   await assert.rejects(food.acceptOrder(kitchen,order.id),/paid upfront/);
   assert.equal(await foodDispatchAllowed(db,order.shipment_id),false);
  }));
  await t.test('full upfront charge and duplicate callback; kitchen explicitly releases dispatch',()=>fixture(async({db,c,food,kitchen,order,pay,checkout})=>{
   const result=await pay();assert.equal(result.status,'confirmed');
   assert.equal((await checkout.webhook(Buffer.from('{}'),{})).duplicate,true);
   const shipment=(await c.query('SELECT * FROM shipments WHERE id=$1',[order.shipment_id])).rows[0];
   assert.equal(shipment.paid,true);
   assert.equal(await foodDispatchAllowed(db,order.shipment_id),false);
   await food.acceptOrder(kitchen,order.id,{estimatedPrepMinutes:20});
   assert.equal(await foodDispatchAllowed(db,order.shipment_id),true);
   await food.startPreparing(kitchen,order.id);
   await food.markReadyForPickup(kitchen,order.id);
  }));
  await t.test('underpayment never pays or releases the order',()=>fixture(async({c,order,pay})=>{
   assert.equal((await pay(Number(order.total_minor)-1)).status,'refund_review');
   assert.equal((await c.query('SELECT paid FROM shipments WHERE id=$1',[order.shipment_id])).rows[0].paid,false);
  }));
  await t.test('food and delivery liability clears into rider, restaurant and commission accounts',()=>fixture(async({c,order,pay})=>{
   await pay();
   const shipment=(await c.query('SELECT * FROM shipments WHERE id=$1',[order.shipment_id])).rows[0];
   await digitalDeliveryCompleted(c,shipment);
   await digitalDeliveryCompleted(c,shipment);
   const lines=(await c.query(`SELECT account,sum(CASE WHEN side='credit' THEN amount_minor ELSE -amount_minor END)::bigint AS net FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 GROUP BY account`,[shipment.id])).rows;
   const accounts=Object.fromEntries(lines.map(x=>[x.account,Number(x.net)]));
   assert.equal(accounts.customer_delivery_liability,0);
   assert.equal(accounts.restaurant_payable,4500);
   assert.equal(accounts.platform_food_commission_revenue,500);
  }));
  await t.test('paid rejection moves full amount into refund review exactly once',()=>fixture(async({c,food,kitchen,order,pay})=>{
   await pay();await food.rejectOrder(kitchen,order.id,{reason:'Kitchen unavailable'});
   const refund=(await c.query('SELECT * FROM checkout_refund_requests WHERE shipment_id=$1',[order.shipment_id])).rows[0];
   assert.equal(Number(refund.amount_minor),Number(order.total_minor));
   assert.equal(refund.status,'pending_review');
   assert.equal((await c.query('SELECT state FROM shipments WHERE id=$1',[order.shipment_id])).rows[0].state,'CANCELLED');
  }));
  await t.test('cancellation before provider success becomes unapplied refund evidence',()=>fixture(async({food,actor,order,checkout,setReceipt,c})=>{
   const intent=await checkout.initiate(actor,order.shipment_id,{idempotencyKey:randomUUID()});
   await food.cancelOrder(actor,order.id);
   setReceipt({reference:intent.reference,status:'success',amountMinor:Number(order.total_minor),currency:'GHS',channel:'mobile_money',eventId:'late_'+randomUUID()});
   assert.equal((await checkout.webhook(Buffer.from('{}'),{})).status,'refund_review');
   assert.equal((await c.query('SELECT state FROM shipments WHERE id=$1',[order.shipment_id])).rows[0].state,'CANCELLED');
  }));
  await t.test('forged paid flags cannot bypass database kitchen and dispatch guards',()=>fixture(async({db,c,order})=>{
   await assert.rejects(db.tx(c=>c.query("UPDATE food_orders SET payment_status='PAID' WHERE id=$1",[order.id])),/Verified full food payment/);
   await assert.rejects(db.tx(c=>c.query("UPDATE shipments SET paid=true,state='RIDER_ASSIGNED' WHERE id=$1",[order.shipment_id])),/Food assignment requires/);
   assert.equal((await c.query('SELECT state FROM food_orders WHERE id=$1',[order.id])).rows[0].state,'SUBMITTED');
  }));
  await t.test('paid customer cancellation creates full refund liability',()=>fixture(async({c,food,actor,order,pay})=>{
   await pay();await food.cancelOrder(actor,order.id);
   const balance=(await c.query(`SELECT sum(CASE WHEN side='credit' THEN amount_minor ELSE -amount_minor END)::bigint AS net FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 AND account='customer_refund_liability'`,[order.shipment_id])).rows[0];
   assert.equal(Number(balance.net),Number(order.total_minor));
  }));
  await t.test('notification failure retries without falsely marking sent',()=>fixture(async({db,c,actor})=>{
   const id='test:'+randomUUID();
   await c.query("INSERT INTO notification_jobs(id,recipient_id,kind,payload,available_at) VALUES($1,$2,'test','{}','-infinity')",[id,actor.id]);
   const failing=notificationWorker(db,{transport:{send:async()=>{throw Error('provider unavailable');}}});
   await failing.tick();
   let job=(await c.query('SELECT * FROM notification_jobs WHERE id=$1',[id])).rows[0];
   assert.equal(job.state,'pending');assert.equal(job.attempts,1);assert.equal(job.sent_at,null);
   await c.query("UPDATE notification_jobs SET available_at='-infinity' WHERE id=$1",[id]);
   const working=notificationWorker(db,{transport:{send:async()=>({accepted:true,messageId:'receipt-'+id})}});
   await working.tick();
   job=(await c.query('SELECT * FROM notification_jobs WHERE id=$1',[id])).rows[0];
   assert.equal(job.state,'sent');assert.equal(job.attempts,2);assert.ok(job.sent_at);
  }));
  await t.test('missing payer email fails before a payment intent is created',()=>fixture(async({c,checkout,actor,order,provider})=>{
   provider.payerFields=['email'];
   await assert.rejects(checkout.initiate(actor,order.shipment_id,{idempotencyKey:randomUUID()}),/email/);
   assert.equal((await c.query('SELECT count(*)::int AS count FROM shipment_checkout_intents WHERE shipment_id=$1',[order.shipment_id])).rows[0].count,0);
   await checkout.initiate(actor,order.shipment_id,{idempotencyKey:randomUUID(),email:'buyer@example.test'});
  }));
  await t.test('definitive no-charge rejection allows retry; uncertain outcomes remain protected',()=>fixture(async({c,checkout,actor,order,provider})=>{
   const create=provider.createCheckout;
   provider.createCheckout=async()=>{throw Object.assign(Error('invalid payer'),{status:400,definitiveNoCharge:true});};
   await assert.rejects(checkout.initiate(actor,order.shipment_id,{idempotencyKey:randomUUID()}),/invalid payer/);
   assert.equal((await c.query('SELECT status FROM shipment_checkout_intents WHERE shipment_id=$1',[order.shipment_id])).rows[0].status,'failed');
   provider.createCheckout=create;assert.equal((await checkout.initiate(actor,order.shipment_id,{idempotencyKey:randomUUID()})).status,'pending');
  }));
  await t.test('paid kitchen timeout creates a full refund and cancels dispatch',()=>fixture(async({c,food,order,pay})=>{
   await pay();await c.query("UPDATE shipment_checkout_intents SET confirmed_at=now()-interval '10 minutes' WHERE shipment_id=$1",[order.shipment_id]);
   const result=await food.expireUnfulfilledOrders();assert.ok(result.some(x=>x.id===order.id&&x.reason==='kitchen_acceptance_deadline'));
   assert.equal((await c.query('SELECT amount_minor FROM checkout_refund_requests WHERE shipment_id=$1',[order.shipment_id])).rows[0].amount_minor,String(order.total_minor));
  }));
  await t.test('no-courier timeout releases customer money without dispatching old food',()=>fixture(async({c,food,kitchen,order,pay})=>{
   await pay();await food.acceptOrder(kitchen,order.id);await c.query("UPDATE shipments SET next_dispatch_at=now()-interval '30 minutes' WHERE id=$1",[order.shipment_id]);
   const result=await food.expireUnfulfilledOrders();assert.ok(result.some(x=>x.id===order.id&&x.reason==='courier_unavailable'));
   assert.equal((await c.query('SELECT state FROM shipments WHERE id=$1',[order.shipment_id])).rows[0].state,'CANCELLED');
  }));
  await t.test('refund completes only after adapter verification and clears liability once',()=>fixture(async({db,c,food,actor,order,pay,provider,admins})=>{
   await pay();await food.cancelOrder(actor,order.id);const [admin]=await admins();
   let operation,submitted=0;
   provider.createRefund=async x=>{submitted++;operation=x;return {providerId:'refund-1'};};
   provider.verifyRefund=async()=>({verified:true,status:'pending'});
   const money=moneyOperations(db,{provider});const refund=(await money.refunds(admin)).find(x=>x.shipment_id===order.shipment_id);
   await money.submitRefund(admin,refund.id);await money.submitRefund(admin,refund.id);assert.equal(submitted,1);
   const record={verified:true,status:'refunded',requestId:refund.id,reference:operation.reference,amountMinor:Number(refund.amount_minor),currency:'GHS',eventId:'refund:'+randomUUID()};
   await assert.rejects(money.confirmRefund({...record,amountMinor:1}),/mismatch/);
   assert.equal((await money.confirmRefund(record)).duplicate,false);assert.equal((await money.confirmRefund(record)).duplicate,true);
   const net=(await c.query(`SELECT sum(CASE WHEN side='credit' THEN amount_minor ELSE -amount_minor END)::bigint AS net FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 AND l.account='customer_refund_liability'`,[order.shipment_id])).rows[0].net;
   assert.equal(Number(net),0);assert.equal((await c.query('SELECT payment_status FROM food_orders WHERE id=$1',[order.id])).rows[0].payment_status,'REFUNDED');
  }));
  await t.test('new merchant stays pending until an authorized operator approves it',()=>fixture(async({db,kitchen,admins})=>{
   const merchants=restaurantService(db);const r=await merchants.createRestaurant(kitchen,{name:'Pending Kitchen',phone:'0241234567',address:'Pending kitchen address',latitude:5.6,longitude:-0.18});
   assert.equal(r.status,'pending');await assert.rejects(merchants.updateRestaurant(kitchen,r.id,{status:'approved'}),/administrator/);
   const [admin]=await admins();assert.equal((await merchants.updateRestaurant(admin,r.id,{status:'approved'})).status,'approved');
  }));
  await t.test('restaurant payout requires ownership verification, a second administrator and a verified receipt',()=>fixture(async({db,c,food,kitchen,order,pay,provider,admins})=>{
   await pay();await food.acceptOrder(kitchen,order.id);
   const rider=randomUUID();
   await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'fixture','rider',now())",[rider,'+2332'+String(randomInt(10000000,99999999))]);
   await c.query("INSERT INTO riders(id,status,vehicle,max_weight_g) VALUES($1,'approved','motorcycle',20000)",[rider]);
   await c.query('INSERT INTO rider_dispatch_plans(rider_id) VALUES($1)',[rider]);
   await c.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[order.shipment_id,rider]);
   for(const purpose of ['pickup','delivery'])await c.query("INSERT INTO challenges(id,shipment_id,rider_id,purpose,phone,digest,expires_at,consumed_at,sent) VALUES($1,$2,$3,$4,'+233241234567','fixture',now()+interval '5 minutes',now(),true)",[randomUUID(),order.shipment_id,rider,purpose]);
   for(const state of ['PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'])await c.query('UPDATE shipments SET state=$2 WHERE id=$1',[order.shipment_id,state]);
   await c.query("UPDATE shipments SET state='COMPLETED',completed_at=now() WHERE id=$1",[order.shipment_id]);
   await c.query("UPDATE food_orders SET state='DELIVERED',completed_at=now() WHERE id=$1",[order.id]);
   await digitalDeliveryCompleted(c,(await c.query('SELECT * FROM shipments WHERE id=$1',[order.shipment_id])).rows[0]);
   const [proposer,approver]=await admins();let submitted=0,payout;
   await c.query("DELETE FROM permissions WHERE user_id=$1 AND permission='finance:configure'",[approver.id]);
   provider.verifyBeneficiary=async x=>({verified:true,...x});
   provider.createPayout=async x=>{submitted++;payout=x;return {status:'initiated'};};
   provider.verifyPayout=async()=>({verified:true,status:'pending'});
   const money=moneyOperations(db,{provider});
   await assert.rejects(money.proposePayout(proposer,{shipmentId:order.shipment_id,kind:'restaurant'}),/Verified payout destination/);
   await money.verifyBeneficiary(kitchen,{recipientReference:'verified-merchant-destination'});
   const operation=await money.proposePayout(proposer,{shipmentId:order.shipment_id,kind:'restaurant'});
   assert.equal(Number(operation.amount_minor),4500);
   await assert.rejects(money.approvePayout(proposer,operation.id),/different finance administrator/);
   await money.approvePayout(approver,operation.id);await money.approvePayout(approver,operation.id);assert.equal(submitted,1);
   const record={verified:true,status:'paid',requestId:operation.id,recipientReference:payout.recipientReference,amountMinor:payout.amountMinor,currency:'GHS',eventId:'payout:'+randomUUID()};
   await assert.rejects(money.confirmPayout({...record,recipientReference:'different-recipient'}),/mismatch/);
   assert.equal((await money.confirmPayout(record)).duplicate,false);assert.equal((await money.confirmPayout(record)).duplicate,true);
   const net=(await c.query(`SELECT sum(CASE WHEN side='credit' THEN amount_minor ELSE -amount_minor END)::bigint AS net FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 AND l.account='restaurant_payable'`,[order.shipment_id])).rows[0].net;assert.equal(Number(net),0);
  }));
  await t.test('reconcileRefund and reconcilePayout preserve original receipt identifiers and reject mismatched evidence',()=>fixture(async({db,c,food,actor,order,pay,provider,admins})=>{
   await pay();await food.cancelOrder(actor,order.id);
   const [proposer]=await admins();
   let refundOp;
   provider.createRefund=async x=>{refundOp=x;return {providerId:'prov-ref-1'};};
   let verifyRefundReceipt={verified:true,status:'pending'};
   provider.verifyRefund=async()=>verifyRefundReceipt;
   const money=moneyOperations(db,{provider});
   const refund=(await money.refunds(proposer)).find(x=>x.shipment_id===order.shipment_id);
   await money.submitRefund(proposer,refund.id);
   const wrongId=randomUUID();
   verifyRefundReceipt={verified:true,status:'refunded',provider:'fixture',requestId:wrongId,providerId:'prov-ref-1',reference:refundOp.reference,amountMinor:Number(refund.amount_minor),currency:'GHS',eventId:'evt_wrong_'+randomUUID()};
   await assert.rejects(money.reconcileRefund(proposer,refund.id),/Refund evidence mismatch: request ID/);
   const validBase={verified:true,status:'refunded',provider:'fixture',requestId:refund.id,providerId:'prov-ref-1',reference:refundOp.reference,amountMinor:Number(refund.amount_minor),currency:'GHS',eventId:'evt_ok_'+randomUUID()};
   verifyRefundReceipt={...validBase,provider:'other'};await assert.rejects(money.reconcileRefund(proposer,refund.id),/Refund evidence mismatch: provider/);
   verifyRefundReceipt={...validBase,reference:'wrong_ref'};await assert.rejects(money.reconcileRefund(proposer,refund.id),/Refund evidence mismatch: reference/);
   verifyRefundReceipt={...validBase,amountMinor:Number(refund.amount_minor)-1};await assert.rejects(money.reconcileRefund(proposer,refund.id),/Refund evidence mismatch: amount/);
   verifyRefundReceipt={...validBase,currency:'USD'};await assert.rejects(money.reconcileRefund(proposer,refund.id),/Refund evidence mismatch: currency/);
   verifyRefundReceipt={...validBase,providerId:'prov-ref-other'};await assert.rejects(money.reconcileRefund(proposer,refund.id),/Refund evidence mismatch: provider ID/);
   assert.equal((await c.query('SELECT status FROM refund_operations WHERE id=$1',[refund.id])).rows[0].status,'pending');
   verifyRefundReceipt=validBase;
   const recResult=await money.reconcileRefund(proposer,refund.id);
   assert.equal(recResult.status,'refunded');
   const ev=(await c.query("SELECT * FROM payment_operation_events WHERE kind='refund' AND operation_id=$1",[refund.id])).rows[0];
   assert.equal(ev.request_id,refund.id);
   assert.equal(ev.provider_reference,'prov-ref-1');
   assert.equal(ev.status,'refunded');
   assert.equal(ev.receipt.eventId,validBase.eventId);
  }));
  await t.test('independent vs company-owned rider payouts resolve beneficiary ownership and permissions',()=>fixture(async({db,c,food,checkout,kitchen,order,pay,provider,admins})=>{
   await pay();await food.acceptOrder(kitchen,order.id);
   const [proposer]=await admins();
   const companyOwner=randomUUID(),companyId=randomUUID(),companyRider=randomUUID();
   await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'fixture','company',now()),($3,$4,'fixture','rider',now())",[companyOwner,'+2332'+String(randomInt(10000000,99999999)),companyRider,'+2332'+String(randomInt(10000000,99999999))]);
   await c.query("INSERT INTO companies(id,owner_id,name,status) VALUES($1,$2,'Fleet Co','pending')",[companyId,companyOwner]);
   await c.query("INSERT INTO riders(id,company_id,status,vehicle,max_weight_g) VALUES($1,$2,'approved','motorcycle',20000)",[companyRider,companyId]);
   await c.query('INSERT INTO rider_dispatch_plans(rider_id) VALUES($1)',[companyRider]);
   await c.query("UPDATE shipments SET rider_id=$2,company_id=$3,state='RIDER_ASSIGNED' WHERE id=$1",[order.shipment_id,companyRider,companyId]);
   for(const purpose of ['pickup','delivery'])await c.query("INSERT INTO challenges(id,shipment_id,rider_id,purpose,phone,digest,expires_at,consumed_at,sent) VALUES($1,$2,$3,$4,'+233241234567','fixture',now()+interval '5 minutes',now(),true)",[randomUUID(),order.shipment_id,companyRider,purpose]);
   for(const state of ['PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'])await c.query('UPDATE shipments SET state=$2 WHERE id=$1',[order.shipment_id,state]);
   await c.query("UPDATE shipments SET state='COMPLETED',completed_at=now() WHERE id=$1",[order.shipment_id]);
   await c.query("UPDATE food_orders SET state='DELIVERED',completed_at=now() WHERE id=$1",[order.id]);
   await digitalDeliveryCompleted(c,(await c.query('SELECT * FROM shipments WHERE id=$1',[order.shipment_id])).rows[0]);
   provider.verifyBeneficiary=async x=>({verified:true,...x});
   provider.createPayout=async()=>({status:'initiated',providerId:'payout-co-1'});
   let verifyPayoutReceipt={verified:true,status:'pending'};
   provider.verifyPayout=async()=>verifyPayoutReceipt;
   const money=moneyOperations(db,{provider});
   await money.verifyBeneficiary({id:companyOwner,kind:'company'},{recipientReference:'fleet-owner-dest'});
   await assert.rejects(money.proposePayout(proposer,{shipmentId:order.shipment_id,kind:'rider'}),/Approved company/);
   await c.query("UPDATE companies SET status='approved' WHERE id=$1",[companyId]);
   const coPayout=await money.proposePayout(proposer,{shipmentId:order.shipment_id,kind:'rider'});
   assert.equal(coPayout.beneficiary_id,companyOwner,'Beneficiary must be company owner user ID, not company ID or rider ID');
   assert.equal(coPayout.company_id,companyId);
   assert.equal(coPayout.recipient_reference,'fleet-owner-dest');
   const approveOnly={id:randomUUID(),kind:'admin'};
   await c.query("INSERT INTO users(id,phone,password_hash,kind) VALUES($1,$2,'fixture','admin')",[approveOnly.id,'+2332'+String(randomInt(10000000,99999999))]);
   await c.query("INSERT INTO permissions(user_id,permission) VALUES($1,'finance:approve')",[approveOnly.id]);
   assert.ok((await money.payouts(approveOnly)).some(x=>x.id===coPayout.id));
   assert.ok(Array.isArray(await money.refunds(approveOnly)));
   const opEx=await money.exceptions(approveOnly);
   assert.ok(Array.isArray(opEx.refunds)&&Array.isArray(opEx.payouts));
   assert.ok(Array.isArray(await checkout.exceptionQueue(approveOnly)));
   const fin=financeService(db,{provider});
   assert.ok(Array.isArray(await fin.aging(approveOnly)));
   assert.ok(Array.isArray(await fin.adjustmentQueue(approveOnly)));
   await assert.rejects(money.proposePayout(approveOnly,{shipmentId:order.shipment_id,kind:'restaurant'}),/permission/);
   await money.approvePayout(approveOnly,coPayout.id);
   verifyPayoutReceipt={verified:true,status:'paid',provider:'fixture',requestId:randomUUID(),providerId:'payout-co-1',recipientReference:'fleet-owner-dest',amountMinor:Number(coPayout.amount_minor),currency:'GHS',eventId:'evt_co_'+randomUUID()};
   await assert.rejects(money.reconcilePayout(approveOnly,coPayout.id),/Payout evidence mismatch: request ID/);
   verifyPayoutReceipt={...verifyPayoutReceipt,requestId:coPayout.id};
   assert.equal((await money.reconcilePayout(approveOnly,coPayout.id)).status,'paid');
  }));
  await t.test('failed and uncertain refunds/payouts record accurate states, surface in exceptions, and recover safely without duplication',()=>fixture(async({db,c,food,actor,order,pay,provider,admins})=>{
   await pay();await food.cancelOrder(actor,order.id);
   const [proposer,approver]=await admins();
   provider.createRefund=async()=>{throw Error('gateway timeout during refund submission');};
   let refundVerify={verified:true,status:'pending'};
   provider.verifyRefund=async()=>refundVerify;
   const money=moneyOperations(db,{provider});
   const refund=(await money.refunds(proposer)).find(x=>x.shipment_id===order.shipment_id);
   const subRes=await money.submitRefund(proposer,refund.id);
   assert.equal(subRes.status,'needs_review');
   const afterTimeout=(await c.query('SELECT * FROM refund_operations WHERE id=$1',[refund.id])).rows[0];
   assert.equal(afterTimeout.status,'needs_review');
   const ex1=await money.exceptions(approver);
   assert.ok(ex1.refunds.some(r=>r.id===refund.id&&r.status==='needs_review'));
   await assert.rejects(money.retryRefund(proposer,refund.id),/Only definitively failed refunds/);
   refundVerify={verified:true,status:'failed',provider:'fixture',requestId:refund.id,reference:refund.reference,amountMinor:Number(refund.amount_minor),currency:'GHS',eventId:'evt_ref_fail_'+randomUUID(),failureReason:'processor_rejected'};
   const failedRes=await money.reconcileRefund(proposer,refund.id);
   assert.equal(failedRes.status,'failed');
   assert.equal((await c.query('SELECT status,failure_reason FROM refund_operations WHERE id=$1',[refund.id])).rows[0].status,'failed');
   let retrySubmitted=0;
   provider.createRefund=async()=>({providerId:'prov-retry-'+String(++retrySubmitted)});
   refundVerify={verified:true,status:'pending'};
   const retried=await money.retryRefund(proposer,refund.id);
   assert.equal(retried.retry_of,refund.id);
   await assert.rejects(money.retryRefund(proposer,refund.id),/already active or completed/);
   await money.submitRefund(proposer,retried.id);
   refundVerify={verified:true,status:'refunded',provider:'fixture',requestId:retried.id,providerId:'prov-retry-1',reference:retried.reference,amountMinor:Number(retried.amount_minor),currency:'GHS',eventId:'evt_ref_ok_'+randomUUID()};
   assert.equal((await money.reconcileRefund(proposer,retried.id)).status,'refunded');
   const refundLiability=(await c.query(`SELECT sum(CASE WHEN side='credit' THEN amount_minor ELSE -amount_minor END)::bigint AS net FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 AND l.account='customer_refund_liability'`,[order.shipment_id])).rows[0].net;
   assert.equal(Number(refundLiability),0);
  }));
  await t.test('failed payout requires verified failure before retry and preserves two-person approval on retry',()=>fixture(async({db,c,food,kitchen,order,pay,provider,admins})=>{
   await pay();await food.acceptOrder(kitchen,order.id);
   const rider=randomUUID();
   await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'fixture','rider',now())",[rider,'+2332'+String(randomInt(10000000,99999999))]);
   await c.query("INSERT INTO riders(id,status,vehicle,max_weight_g) VALUES($1,'approved','motorcycle',20000)",[rider]);
   await c.query('INSERT INTO rider_dispatch_plans(rider_id) VALUES($1)',[rider]);
   await c.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[order.shipment_id,rider]);
   for(const purpose of ['pickup','delivery'])await c.query("INSERT INTO challenges(id,shipment_id,rider_id,purpose,phone,digest,expires_at,consumed_at,sent) VALUES($1,$2,$3,$4,'+233241234567','fixture',now()+interval '5 minutes',now(),true)",[randomUUID(),order.shipment_id,rider,purpose]);
   for(const state of ['PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP'])await c.query('UPDATE shipments SET state=$2 WHERE id=$1',[order.shipment_id,state]);
   await c.query("UPDATE shipments SET state='COMPLETED',completed_at=now() WHERE id=$1",[order.shipment_id]);
   await c.query("UPDATE food_orders SET state='DELIVERED',completed_at=now() WHERE id=$1",[order.id]);
   await digitalDeliveryCompleted(c,(await c.query('SELECT * FROM shipments WHERE id=$1',[order.shipment_id])).rows[0]);
   const [proposer,approver]=await admins();
   provider.verifyBeneficiary=async x=>({verified:true,...x});
   provider.createPayout=async()=>{throw Error('transfer network drop');};
   provider.verifyPayout=async()=>({verified:true,status:'pending'});
   const money=moneyOperations(db,{provider});
   await money.verifyBeneficiary({id:rider,kind:'rider'},{recipientReference:'rider-momo-dest'});
   const p1=await money.proposePayout(proposer,{shipmentId:order.shipment_id,kind:'rider'});
   const appRes=await money.approvePayout(approver,p1.id);
   assert.equal(appRes.status,'needs_review');
   assert.equal((await c.query('SELECT status FROM payout_operations WHERE id=$1',[p1.id])).rows[0].status,'needs_review');
   await assert.rejects(money.retryPayout(proposer,p1.id),/Only definitively failed payouts/);
   provider.verifyPayout=async()=>({verified:true,status:'failed',provider:'fixture',requestId:p1.id,recipientReference:'rider-momo-dest',amountMinor:Number(p1.amount_minor),currency:'GHS',eventId:'evt_pay_fail_'+randomUUID(),failureReason:'transfer_reversed'});
   assert.equal((await money.reconcilePayout(approver,p1.id)).status,'failed');
   const p2=await money.retryPayout(proposer,p1.id);
   assert.equal(p2.status,'proposed');assert.equal(p2.retry_of,p1.id);
   assert.equal((await money.retryPayout(proposer,p1.id)).id,p2.id);
   await assert.rejects(money.approvePayout(proposer,p2.id),/different finance administrator/);
   provider.createPayout=async()=>({status:'initiated',providerId:'payout-retry-1'});
   provider.verifyPayout=async()=>({verified:true,status:'pending'});
   await money.approvePayout(approver,p2.id);
   provider.verifyPayout=async()=>({verified:true,status:'paid',provider:'fixture',requestId:p2.id,providerId:'payout-retry-1',recipientReference:'rider-momo-dest',amountMinor:Number(p2.amount_minor),currency:'GHS',eventId:'evt_pay_ok_'+randomUUID()});
   assert.equal((await money.reconcilePayout(approver,p2.id)).status,'paid');
   const riderPayable=(await c.query(`SELECT sum(CASE WHEN side='credit' THEN amount_minor ELSE -amount_minor END)::bigint AS net FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 AND l.account='rider_payable'`,[order.shipment_id])).rows[0].net;
   assert.equal(Number(riderPayable),0);
  }));
  await t.test('slow payment-provider reconciliation never blocks food expiration and leases prevent duplicate work across instances',()=>fixture(async({db,c,food,order,pay,provider})=>{
   await pay();
   await c.query("UPDATE shipment_checkout_intents SET confirmed_at=now()-interval '10 minutes' WHERE shipment_id=$1",[order.shipment_id]);
   let verifyCalls=0;
   provider.createRefund=async()=>({providerId:'slow-ref-1'});
   provider.verifyRefund=async()=>{verifyCalls++;await new Promise(r=>setTimeout(r,250));return {verified:true,status:'pending'};};
   const money=moneyOperations(db,{provider,concurrency:2,verifyTimeoutMs:2000});
   const scheduler=backgroundJobs({db,restOrders:food,money,paymentProvider:provider});
   await scheduler.jobs.foodExpiry();
   assert.equal((await c.query('SELECT state FROM food_orders WHERE id=$1',[order.id])).rows[0].state,'CANCELLED');
   await money.syncRefunds();
   await c.query("UPDATE refund_operations SET status='initiating',provider_id='slow-ref-1',updated_at=now()-interval '5 minutes',reconcile_lease_until=now()+interval '5 minutes' WHERE shipment_id=$1",[order.shipment_id]);
   verifyCalls=0;
   await money.reconcileDue({olderThanSeconds:1});
   assert.equal(verifyCalls,0,'Leased operation must be skipped by concurrent instance');
   await c.query("UPDATE refund_operations SET reconcile_lease_until=now()-interval '1 second',updated_at=now()-interval '5 minutes' WHERE shipment_id=$1",[order.shipment_id]);
   await money.reconcileDue({olderThanSeconds:1});
   assert.equal(verifyCalls,1,'Expired lease must be recovered after restart');
  }));
  await t.test('stuck food orders after rider assignment resolve cleanly for pre-pickup reassignment, cancellation, and post-pickup return',()=>fixture(async({db,c,food,kitchen,order,pay,provider,admins})=>{
   await pay();await food.acceptOrder(kitchen,order.id);await food.markReadyForPickup(kitchen,order.id);
   const rider1=randomUUID(),rider2=randomUUID();
   for(const r of [rider1,rider2]){
    await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'fixture','rider',now())",[r,'+2332'+String(randomInt(10000000,99999999))]);
    await c.query("INSERT INTO riders(id,status,vehicle,max_weight_g) VALUES($1,'approved','motorcycle',20000)",[r]);
    await c.query('INSERT INTO rider_dispatch_plans(rider_id,stops) VALUES($1,$2)',[r,JSON.stringify([{shipmentId:order.shipment_id,kind:'pickup'},{shipmentId:order.shipment_id,kind:'dropoff'}])]);
   }
   await c.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[order.shipment_id,rider1]);
   await c.query("UPDATE shipments SET state='FAILED' WHERE id=$1",[order.shipment_id]);
   const reassigned=await food.resolveOrder(kitchen,order.id,{action:'reassign',reason:'Rider 1 bike breakdown before pickup'});
   assert.equal(reassigned.shipmentState,'AWAITING_ASSIGNMENT');
   assert.equal(reassigned.state,'READY_FOR_PICKUP');
   assert.equal((await c.query('SELECT rider_id FROM shipments WHERE id=$1',[order.shipment_id])).rows[0].rider_id,null);
   assert.equal((await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1',[rider1])).rows[0].stops.length,0);
   await c.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[order.shipment_id,rider2]);
   await c.query("INSERT INTO challenges(id,shipment_id,rider_id,purpose,phone,digest,expires_at,consumed_at,sent) VALUES($1,$2,$3,'pickup','+233241234567','fixture',now()+interval '5 minutes',now(),true)",[randomUUID(),order.shipment_id,rider2]);
   await c.query("UPDATE shipments SET state='PICKUP_VERIFIED' WHERE id=$1",[order.shipment_id]);
   await c.query("UPDATE shipments SET state='IN_TRANSIT' WHERE id=$1",[order.shipment_id]);
   await c.query("UPDATE food_orders SET state='IN_TRANSIT' WHERE id=$1",[order.id]);
   await c.query("UPDATE shipments SET state='FAILED' WHERE id=$1",[order.shipment_id]);
   await assert.rejects(food.resolveOrder(kitchen,order.id,{action:'reassign',reason:'Try reassign after pickup'}),/before pickup/);
   assert.equal((await food.resolveOrder({id:rider2,kind:'rider'},order.id,{action:'return',reason:'Customer unreachable at dropoff'})).shipmentState,'RETURN_REQUESTED');
   const resolved=await food.resolveOrder(kitchen,order.id,{action:'returned',reason:'Food returned to kitchen after failed dropoff'});
   assert.equal(resolved.state,'CANCELLED');
   assert.equal(resolved.shipmentState,'RETURNED');
   assert.equal(resolved.refundReviewRequired,true);
   assert.equal((await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1',[rider2])).rows[0].stops.length,0);
   const refund=(await c.query('SELECT * FROM checkout_refund_requests WHERE shipment_id=$1',[order.shipment_id])).rows[0];
   assert.equal(Number(refund.amount_minor),Number(order.total_minor));
   assert.equal((await c.query('SELECT count(*)::int AS count FROM restaurant_settlements WHERE order_id=$1',[order.id])).rows[0].count,0);
   const [proposer]=await admins();
   provider.createPayout=async()=>({status:'initiated'});
   provider.verifyPayout=async()=>({verified:true,status:'pending'});
   const money=moneyOperations(db,{provider});
   await assert.rejects(money.proposePayout(proposer,{shipmentId:order.shipment_id,kind:'restaurant'}),/Completed prepaid delivery required/);
   await assert.rejects(money.proposePayout(proposer,{shipmentId:order.shipment_id,kind:'rider'}),/Completed prepaid delivery required/);
  }));
  await t.test('dispatch retries pushing next_dispatch_at forward cannot delay no-courier food expiration and refund',()=>fixture(async({db,c,food,kitchen,order,pay})=>{
   await pay();await food.acceptOrder(kitchen,order.id,{estimatedPrepMinutes:10});
   await c.query("UPDATE food_orders SET dispatch_started_at=now()-interval '25 minutes',ready_at=now()-interval '20 minutes' WHERE id=$1",[order.id]);
   await c.query("UPDATE shipments SET next_dispatch_at=now()-interval '1 second' WHERE id=$1",[order.shipment_id]);
   const dispatch=dispatchEngine(db,{routing:{route:async()=>({distanceMeters:2000,durationSeconds:300}),matrix:async()=>[[{distanceMeters:2000,durationSeconds:300}]]}});
   const retryTick=await dispatch.tick();
   assert.ok(retryTick.some(x=>x.status==='no_road_eligible_rider'&&x.attempt===1));
   const sAfterRetry=(await c.query('SELECT next_dispatch_at,dispatch_attempts FROM shipments WHERE id=$1',[order.shipment_id])).rows[0];
   assert.equal(sAfterRetry.dispatch_attempts,1);
   assert.ok(new Date(sAfterRetry.next_dispatch_at).getTime()>Date.now(),'dispatch retry moved next_dispatch_at into the future');
   const expired=await food.expireUnfulfilledOrders();
   assert.ok(expired.some(x=>x.id===order.id&&x.reason==='courier_unavailable'),'food order must still expire using fixed dispatch_started_at deadline');
   assert.equal((await c.query('SELECT state FROM food_orders WHERE id=$1',[order.id])).rows[0].state,'CANCELLED');
   assert.equal((await c.query('SELECT state FROM shipments WHERE id=$1',[order.shipment_id])).rows[0].state,'CANCELLED');
   assert.equal((await c.query('SELECT count(*)::int AS count FROM checkout_refund_requests WHERE shipment_id=$1',[order.shipment_id])).rows[0].count,1);
  }));
  await t.test('post-pickup customer actions cannot record an unconfirmed return or create a refund liability before restaurant or admin confirmation',()=>fixture(async({db,c,food,actor,kitchen,order,pay})=>{
   await pay();await food.acceptOrder(kitchen,order.id);await food.markReadyForPickup(kitchen,order.id);
   const rider=randomUUID();
   await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'fixture','rider',now())",[rider,'+2332'+String(randomInt(10000000,99999999))]);
   await c.query("INSERT INTO riders(id,status,vehicle,max_weight_g) VALUES($1,'approved','motorcycle',20000)",[rider]);
   await c.query('INSERT INTO rider_dispatch_plans(rider_id,stops) VALUES($1,$2)',[rider,JSON.stringify([{shipmentId:order.shipment_id,kind:'pickup'},{shipmentId:order.shipment_id,kind:'dropoff'}])]);
   await c.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[order.shipment_id,rider]);
   await c.query("INSERT INTO challenges(id,shipment_id,rider_id,purpose,phone,digest,expires_at,consumed_at,sent) VALUES($1,$2,$3,'pickup','+233241234567','fixture',now()+interval '5 minutes',now(),true)",[randomUUID(),order.shipment_id,rider]);
   for(const state of ['PICKUP_VERIFIED','IN_TRANSIT','FAILED'])await c.query('UPDATE shipments SET state=$2 WHERE id=$1',[order.shipment_id,state]);
   await c.query("UPDATE food_orders SET state='IN_TRANSIT' WHERE id=$1",[order.id]);
   const platform=platformService(db,{routing:{route:async()=>({distanceMeters:2000,durationSeconds:300}),matrix:async()=>[[{distanceMeters:2000,durationSeconds:300}]]},sms:{sendOtp:async()=>({accepted:true})},otpKey:'a'.repeat(64)});
   await assert.rejects(food.resolveOrder(actor,order.id,{action:'cancel_refund',reason:'Customer tries unilateral post-pickup refund'}),/restaurant return confirmation or operator decision/);
   await assert.rejects(food.resolveOrder(actor,order.id,{action:'returned',reason:'Customer tries to confirm physical return'}),/Only restaurant owner or administrator/);
   await assert.rejects(food.resolveOrder({id:rider,kind:'rider'},order.id,{action:'returned',reason:'Rider tries to confirm physical return without kitchen'}),/Only restaurant owner or administrator/);
   const reqRes=await food.resolveOrder(actor,order.id,{action:'return',reason:'Customer requests return after failed delivery'});
   assert.equal(reqRes.shipmentState,'RETURN_REQUESTED');
   assert.equal(reqRes.refundReviewRequired,false);
   assert.equal((await c.query('SELECT state FROM shipments WHERE id=$1',[order.shipment_id])).rows[0].state,'RETURN_REQUESTED');
   assert.equal((await c.query('SELECT count(*)::int AS count FROM checkout_refund_requests WHERE shipment_id=$1',[order.shipment_id])).rows[0].count,0);
   await assert.rejects(food.resolveOrder(actor,order.id,{action:'cancel_refund',reason:'Customer tries again before return confirmed'}),/restaurant return confirmation or operator decision/);
   await assert.rejects(platform.transition({id:rider,kind:'rider'},order.shipment_id,{action:'returned',reason:'Rider tries to bypass kitchen confirmation via shipment transition'}),/Only restaurant owner or administrator/);
   await assert.rejects(platform.transition(actor,order.shipment_id,{action:'returned',reason:'Customer tries shipment transition returned'}),/Only restaurant owner or administrator/);
   assert.equal((await c.query('SELECT state FROM shipments WHERE id=$1',[order.shipment_id])).rows[0].state,'RETURN_REQUESTED');
   assert.equal((await c.query('SELECT count(*)::int AS count FROM checkout_refund_requests WHERE shipment_id=$1',[order.shipment_id])).rows[0].count,0);
   const confirmed=await food.resolveOrder(kitchen,order.id,{action:'returned',reason:'Kitchen confirmed physical return of meal'});
   assert.equal(confirmed.shipmentState,'RETURNED');
   assert.equal(confirmed.state,'CANCELLED');
   assert.equal((await c.query('SELECT count(*)::int AS count FROM checkout_refund_requests WHERE shipment_id=$1',[order.shipment_id])).rows[0].count,1);
  }));
  await t.test('reused failure receipt eventId is rejected before marking another operation failed, and reconciliation polling preserves overdue exception detection',()=>fixture(async({db,c,food,checkout,actor,input,order,pay,setReceipt,provider,admins})=>{
   await pay();await food.cancelOrder(actor,order.id);
   const order2=await food.createFoodOrder(actor,input,{paymentMethod:'MOMO',idempotencyKey:randomUUID()});
   const intent2=await checkout.initiate(actor,order2.shipment_id,{idempotencyKey:randomUUID()});
   setReceipt({reference:intent2.reference,status:'success',amountMinor:Number(order2.total_minor),currency:'GHS',channel:'mobile_money',eventId:'evt_'+randomUUID()});
   await checkout.webhook(Buffer.from('{}'),{});
   await food.cancelOrder(actor,order2.id);
   const [proposer,approver]=await admins();
   provider.createRefund=async x=>({providerId:'prov-'+x.requestId});
   let activeReceipt=null;
   provider.verifyRefund=async()=>activeReceipt;
   const money=moneyOperations(db,{provider});
   const allRefunds=await money.refunds(proposer);
   const ref1=allRefunds.find(x=>x.shipment_id===order.shipment_id);
   const ref2=allRefunds.find(x=>x.shipment_id===order2.shipment_id);
   activeReceipt={verified:true,status:'pending'};
   await money.submitRefund(proposer,ref1.id);
   await money.submitRefund(proposer,ref2.id);
   const sharedFailEventId='evt_fail_reused_'+randomUUID();
   activeReceipt={verified:true,status:'failed',provider:'fixture',requestId:ref1.id,providerId:'prov-'+ref1.id,reference:ref1.reference,amountMinor:Number(ref1.amount_minor),currency:'GHS',eventId:sharedFailEventId,failureReason:'bank_declined'};
   assert.equal((await money.reconcileRefund(proposer,ref1.id)).status,'failed');
   activeReceipt={verified:true,status:'failed',provider:'fixture',requestId:ref2.id,providerId:'prov-'+ref2.id,reference:ref2.reference,amountMinor:Number(ref2.amount_minor),currency:'GHS',eventId:sharedFailEventId,failureReason:'reused_failure_event'};
   await assert.rejects(money.reconcileRefund(proposer,ref2.id),/Provider receipt already applied to another operation/);
   assert.equal((await c.query('SELECT status FROM refund_operations WHERE id=$1',[ref2.id])).rows[0].status,'pending');
   await assert.rejects(money.retryRefund(proposer,ref2.id),/Only definitively failed refunds/);
   activeReceipt={verified:true,status:'pending'};
   await c.query("UPDATE refund_operations SET submitted_at=now()-interval '2 hours',last_reconciled_at=now()-interval '10 minutes' WHERE id=$1",[ref2.id]);
   await money.reconcileDue({olderThanSeconds:1});
   const ref2AfterPoll=(await c.query('SELECT status,submitted_at,last_reconciled_at FROM refund_operations WHERE id=$1',[ref2.id])).rows[0];
   assert.equal(ref2AfterPoll.status,'pending');
   assert.ok(new Date(ref2AfterPoll.last_reconciled_at).getTime()>Date.now()-30000,'reconcileDue recorded last_reconciled_at');
   const overdue=await money.exceptions(approver);
   assert.ok(overdue.refunds.some(r=>r.id===ref2.id&&r.status==='pending')&&!overdue.refunds.some(r=>r.id===ref2.id&&r.status==='failed'),'pending operation submitted over 1 hour ago must remain in exceptions after polling');
  }));
  await t.test('missed commission webhooks recover via bounded polling, handle provider timeouts as uncertain, and prevent duplicate postings across concurrent callbacks and workers',()=>fixture(async({db,c,checkout})=>{
   const riderId=randomUUID(),shipmentId=randomUUID(),quoteId=randomUUID();
   await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'fixture','rider',now())",[riderId,'+2332'+String(randomInt(10000000,99999999))]);
   await c.query("INSERT INTO riders(id,status,vehicle,max_weight_g,financial_restriction,financial_restriction_at) VALUES($1,'approved','motorcycle',20000,'OVERDUE_CASH_COMMISSION',now())",[riderId]);
   await c.query('INSERT INTO commission_accounts(rider_id) VALUES($1)',[riderId]);
   await c.query("INSERT INTO quotes(id,customer_id,policy_id,request,amount_minor,commission_minor,expires_at) SELECT $1,u.id,p.id,'{}'::jsonb,10000,1300,now()+interval '1 hour' FROM (SELECT id FROM users WHERE kind='customer' LIMIT 1) u CROSS JOIN (SELECT id FROM pricing_policies LIMIT 1) p",[quoteId]);
   await c.query("INSERT INTO shipments(id,customer_id,quote_id,idempotency_key,rider_id,recipient_phone,amount_minor,commission_minor,payment_method,cash_payer,state,completed_at) SELECT $1,customer_id,$2,$4,$3,'+233241234567',10000,1300,'CASH','recipient','COMPLETED',now()-interval '10 days' FROM quotes WHERE id=$2",[shipmentId,quoteId,riderId,'ship-comm-'+shipmentId]);
   const pastDate=new Date(Date.now()-10*86400000);
   const pastWeekKey=getGhanaWeekKey(pastDate);
   await journal(c,{eventKey:'shipment:'+shipmentId+':cash-commission',riderId,shipmentId,kind:'cash_commission',value:1300});
   await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at,created_at,week_key) VALUES($1,$2,$3,1300,now()-interval '3 days',now()-interval '10 days',$4)",[randomUUID(),shipmentId,riderId,pastWeekKey]);

   const riderActor={id:riderId,kind:'rider'};
   assert.equal((await evaluateRiderWeeklyEligibility(c,riderId)).eligible,false);

   let createCalls=0,verifyCalls=0,verifyMode='timeout';
   let verifiedReceipt=null;
   const commProvider={
    name:'comm_psp',
    allowedCheckoutHosts:['checkout.test'],
    payerFields:['email'],
    commissionIntentId(r){const ref=typeof r==='string'?r:r?.reference||'';const m=/^escomm_([0-9a-f]{32})$/.exec(ref);if(!m)return null;const h=m[1];return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');},
    async createPayment(x){
     createCalls++;
     return {reference:x.reference,checkoutUrl:'https://checkout.test/comm/'+x.intentId,ussd:'*170#'};
    },
    async verifyPayment(ref){
     verifyCalls++;
     if(verifyMode==='timeout'){
      await new Promise(r=>setTimeout(r,120));
      throw Object.assign(Error('provider network timeout'),{code:'provider_timeout'});
     }
     return verifiedReceipt??{reference:ref,status:'pending',amountMinor:1300,currency:'GHS',channel:'mobile_money'};
    },
    async parseVerifiedWebhook(){return verifiedReceipt;}
   };

   const finance=financeService(db,{provider:commProvider,verifyTimeoutMs:50,concurrency:2,leaseSeconds:60});
   const initRes=await finance.initiate(riderActor,{
    kind:'commission_repayment',
    amountMinor:1300,
    idempotencyKey:'comm-missed-wh-001',
    email:'rider@example.test',
    momoNetwork:'MTN',
    momoPhone:'0244123456'
   });
   assert.equal(initRes.status,'pending');
   assert.equal(createCalls,1);
   assert.equal(initRes.checkoutUrl,'https://checkout.test/comm/'+initRes.intentId);

   const savedIntent=(await c.query('SELECT * FROM settlement_intents WHERE id=$1',[initRes.intentId])).rows[0];
   assert.equal(savedIntent.provider_reference,initRes.reference);
   assert.equal(savedIntent.checkout_url,initRes.checkoutUrl);
   assert.equal(savedIntent.payer_email,'rider@example.test');
   assert.equal(savedIntent.momo_network,'MTN');
   assert.equal(savedIntent.momo_phone,'0244123456');

   // 1. Provider timeout during reconciliation must leave intent pending, never failed.
   await c.query("UPDATE settlement_intents SET updated_at=now()-interval '1 minute',submitted_at=now()-interval '1 minute' WHERE id=$1",[initRes.intentId]);
   const timeoutPoll=await finance.reconcileDue({olderThanSeconds:1});
   assert.equal(timeoutPoll.length,1);
   assert.equal(timeoutPoll[0].status,'verification_unavailable');
   assert.equal((await c.query('SELECT status FROM settlement_intents WHERE id=$1',[initRes.intentId])).rows[0].status,'pending');

   // 2. Active lease prevents duplicate polling by a second worker instance.
   verifyMode='pending';
   verifyCalls=0;
   await c.query("UPDATE settlement_intents SET reconcile_lease_until=now()+interval '5 minutes',last_reconciled_at=now()-interval '2 minutes' WHERE id=$1",[initRes.intentId]);
   await finance.reconcileDue({olderThanSeconds:1});
   assert.equal(verifyCalls,0,'Leased settlement intent must be skipped by concurrent worker');

   // 3. Expired lease + missed webhook: concurrent background job, direct reconcile, and late webhook post exactly once.
   await c.query("UPDATE settlement_intents SET reconcile_lease_until=now()-interval '1 second',last_reconciled_at=now()-interval '2 minutes' WHERE id=$1",[initRes.intentId]);
   verifiedReceipt={
    reference:initRes.reference,
    status:'success',
    amountMinor:1300,
    currency:'GHS',
    channel:'mobile_money',
    eventId:'evt_comm_paid_'+randomUUID()
   };
   const scheduler=backgroundJobs({db,checkout,finance,paymentProvider:commProvider});
   const wh=paymentWebhook({db,provider:commProvider,checkout,finance});
   await Promise.all([
    scheduler.jobs.paymentRecon(),
    finance.reconcileIntent(initRes.intentId),
    wh(Buffer.from('{}'),{})
   ]);

   const confirmedRow=(await c.query('SELECT * FROM settlement_intents WHERE id=$1',[initRes.intentId])).rows[0];
   assert.equal(confirmedRow.status,'confirmed');
   assert.match(confirmedRow.receipt_number,/^REC-\d{8}-[A-F0-9]{8}$/);
   const repaymentJournals=(await c.query("SELECT count(*)::int AS count FROM finance_journals WHERE rider_id=$1 AND kind='commission_repayment'",[riderId])).rows[0].count;
   assert.equal(repaymentJournals,1,'Commission repayment journal must be posted exactly once');
   assert.equal((await balance(c,riderId)).dueMinor,0);
   assert.equal((await c.query('SELECT financial_restriction FROM riders WHERE id=$1',[riderId])).rows[0].financial_restriction,null);
   assert.equal((await evaluateRiderWeeklyEligibility(c,riderId)).eligible,true);

   // 4. Already-paid rider retrying with same idempotency key receives confirmed receipt without paying again;
   // retrying with a new key is rejected because dueMinor is now 0.
   const retrySameKey=await finance.initiate(riderActor,{
    kind:'commission_repayment',
    amountMinor:1300,
    idempotencyKey:'comm-missed-wh-001',
    email:'rider@example.test',
    momoNetwork:'MTN',
    momoPhone:'0244123456'
   });
   assert.equal(retrySameKey.status,'confirmed');
   assert.equal(retrySameKey.receiptNumber,confirmedRow.receipt_number);
   assert.equal(createCalls,1,'Must not call createPayment again for confirmed intent');
   await assert.rejects(
    finance.initiate(riderActor,{
     kind:'commission_repayment',
     amountMinor:1300,
     idempotencyKey:'comm-missed-wh-002',
     email:'rider@example.test',
     momoNetwork:'MTN',
     momoPhone:'0244123456'
    }),
    /exceeds outstanding commission/
   );
  }));
  await t.test('commission checkout retries are idempotent, reject term mismatches, protect lost responses, and recover payments arriving during retry',()=>fixture(async({db,c})=>{
   const riderId=randomUUID();
   await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'fixture','rider',now())",[riderId,'+2332'+String(randomInt(10000000,99999999))]);
   await c.query("INSERT INTO riders(id,status,vehicle,max_weight_g) VALUES($1,'approved','motorcycle',20000)",[riderId]);
   await c.query('INSERT INTO commission_accounts(rider_id) VALUES($1)',[riderId]);
   await journal(c,{eventKey:'seed:comm:'+riderId,riderId,kind:'cash_commission',value:2500});
   await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at,week_key) VALUES($1,NULL,$2,2500,now()+interval '5 days',$3)",[randomUUID(),riderId,getGhanaWeekKey(new Date())]);

   const riderActor={id:riderId,kind:'rider'};
   let createCalls=0,createBehavior='ok',verifyBehavior='pending';
   let verifiedReceipt=null;
   const commProvider={
    name:'retry_psp',
    allowedCheckoutHosts:['checkout.test'],
    payerFields:['email'],
    async createPayment(x){
     createCalls++;
     await new Promise(r=>setTimeout(r,20));
     if(createBehavior==='definitive_no_charge'){
      throw Object.assign(Error('Invalid MoMo subscriber'),{status:400,definitiveNoCharge:true});
     }
     if(createBehavior==='lost_response'){
      throw Error('socket hang up after request sent');
     }
     return {reference:x.reference,checkoutUrl:'https://checkout.test/pay/'+x.intentId};
    },
    async verifyPayment(ref){
     if(verifyBehavior==='paid')return verifiedReceipt;
     if(verifyBehavior==='failed')return {verified:true,status:'failed',failureReason:'Subscriber declined prompt',reference:ref};
     if(verifyBehavior==='definitive_no_charge')return {verified:true,status:'not_created',definitiveNoCharge:true,reference:ref};
     return {verified:true,status:'pending',reference:ref};
    }
   };
   const finance=financeService(db,{provider:commProvider});

   // 1. Definitive no-charge failure marks attempt failed and allows clean retry with new key.
   createBehavior='definitive_no_charge';
   await assert.rejects(
    finance.initiate(riderActor,{
     kind:'commission_repayment',
     amountMinor:1500,
     idempotencyKey:'retry-nocharge-001',
     email:'rider@example.test',
     momoNetwork:'MTN',
     momoPhone:'0244123456'
    }),
    /Invalid MoMo subscriber/
   );
   assert.equal(createCalls,1);
   assert.equal((await c.query("SELECT status FROM settlement_intents WHERE idempotency_key='retry-nocharge-001'",[])).rows[0].status,'failed');
   await assert.rejects(
    finance.initiate(riderActor,{
     kind:'commission_repayment',
     amountMinor:1500,
     idempotencyKey:'retry-nocharge-001',
     email:'rider@example.test',
     momoNetwork:'MTN',
     momoPhone:'0244123456'
    }),
    /failed/
   );

   // 2. Simultaneous requests with the SAME idempotency key call createPayment only once.
   createBehavior='ok';
   createCalls=0;
   const sameKeyInput={
    kind:'commission_repayment',
    amountMinor:1500,
    idempotencyKey:'retry-simul-same-001',
    email:'rider@example.test',
    momoNetwork:'MTN',
    momoPhone:'0244123456'
   };
   const [sim1,sim2]=await Promise.all([
    finance.initiate(riderActor,sameKeyInput),
    finance.initiate(riderActor,sameKeyInput)
   ]);
   assert.equal(createCalls,1,'Simultaneous same-key requests must call createPayment once');
   assert.equal(sim1.intentId,sim2.intentId);
   assert.equal(sim1.checkoutUrl,sim2.checkoutUrl);

   // 3. Repeated request with same key returns persisted instructions without calling createPayment again.
   const repeated=await finance.initiate(riderActor,sameKeyInput);
   assert.equal(createCalls,1,'Repeated pending retry must not call createPayment again');
   assert.equal(repeated.intentId,sim1.intentId);
   assert.deepEqual(repeated.paymentInstructions,sim1.paymentInstructions);

   // 4. Reusing the same idempotency key with different payment terms is rejected with 409.
   for(const diff of [
    {amountMinor:1000},
    {momoNetwork:'TELECEL'},
    {momoPhone:'0201234567'},
    {email:'different@example.test'}
   ]){
    await assert.rejects(
     finance.initiate(riderActor,{...sameKeyInput,...diff}),
     err=>err.status===409&&/Idempotency key reused/.test(err.message)
    );
   }

   // 5. Concurrent attempt with a DIFFERENT idempotency key while an attempt is pending is rejected with 409.
   await assert.rejects(
    finance.initiate(riderActor,{...sameKeyInput,idempotencyKey:'retry-different-while-pending'}),
    err=>err.status===409&&/existing commission payment attempt is pending/.test(err.message)
   );
   assert.equal(createCalls,1);

   // Mark first pending attempt failed via a terminal provider failure so we can test lost creation response.
   verifyBehavior='failed';
   assert.equal((await finance.reconcileIntent(sim1.intentId)).status,'failed');

   // 6. Lost creation response leaves attempt in 'initiating', blocks duplicate createPayment,
   // and recovers when payment succeeds at provider during retry.
   createBehavior='lost_response';
   verifyBehavior='pending';
   createCalls=0;
   const lostInput={
    kind:'commission_repayment',
    amountMinor:1500,
    idempotencyKey:'retry-lost-resp-001',
    email:'rider@example.test',
    momoNetwork:'MTN',
    momoPhone:'0244123456'
   };
   await assert.rejects(
    finance.initiate(riderActor,lostInput),
    err=>err.status===503&&/initialization unconfirmed/.test(err.message)
   );
   assert.equal(createCalls,1);
   const lostRow=(await c.query("SELECT * FROM settlement_intents WHERE idempotency_key='retry-lost-resp-001'",[])).rows[0];
   assert.equal(lostRow.status,'initiating');

   // Retrying while still unconfirmed at PSP does NOT call createPayment again.
   await assert.rejects(
    finance.initiate(riderActor,lostInput),
    err=>err.status===503&&/initialization unconfirmed/.test(err.message)
   );
   assert.equal(createCalls,1,'Must not call createPayment again for uncertain initiating attempt');

   // Now the payment succeeds at the PSP before/during the next retry.
   verifyBehavior='paid';
   verifiedReceipt={
    reference:lostRow.provider_reference,
    status:'success',
    amountMinor:1500,
    currency:'GHS',
    channel:'mobile_money',
    eventId:'evt_lost_recovered_'+randomUUID()
   };
   const recoveredOnRetry=await finance.initiate(riderActor,lostInput);
   assert.equal(recoveredOnRetry.status,'confirmed');
   assert.ok(recoveredOnRetry.receiptNumber);
   assert.equal(createCalls,1,'Recovery on retry must verify existing attempt without calling createPayment');
   assert.equal((await balance(c,riderId)).dueMinor,1000);
  }));
  await t.test('weekly settlement settings and adjacent admin endpoints enforce server-side permissions and strict input validation',()=>fixture(async({db,c,actor})=>{
   const unprivAdminId=randomUUID(),readAdminId=randomUUID(),configAdminId=randomUUID();
   for(const id of [unprivAdminId,readAdminId,configAdminId]){
    await c.query("INSERT INTO users(id,phone,password_hash,kind) VALUES($1,$2,'fixture','admin')",[id,'+2332'+String(randomInt(10000000,99999999))]);
   }
   await c.query("INSERT INTO permissions(user_id,permission) VALUES($1,'verification:write'),($2,'finance:read'),($3,'finance:configure')",[unprivAdminId,readAdminId,configAdminId]);
   const unprivAdmin={id:unprivAdminId,kind:'admin'};
   const readAdmin={id:readAdminId,kind:'admin'};
   const configAdmin={id:configAdminId,kind:'admin'};

   // 1. Non-admin and admins without finance:configure cannot update weekly settlement settings.
   await assert.rejects(updateWeeklySettlementSettings(db,actor,{graceHours:2}),err=>err.status===403);
   await assert.rejects(updateWeeklySettlementSettings(db,unprivAdmin,{graceHours:2}),err=>err.status===403&&/Finance configuration permission required/.test(err.message));
   await assert.rejects(updateWeeklySettlementSettings(db,readAdmin,{graceHours:2}),err=>err.status===403&&/Finance configuration permission required/.test(err.message));

   // 2. Invalid types, out-of-range values, invalid time strings, empty payload, and unknown fields are rejected with 400.
   for(const bad of [
    {},
    {cutoffDayOfWeek:0},
    {cutoffDayOfWeek:8},
    {cutoffDayOfWeek:'1'},
    {cutoffTimeUtc:'24:00:00'},
    {cutoffTimeUtc:'9:00'},
    {cutoffTimeUtc:'12:60:00'},
    {graceHours:-1},
    {graceHours:169},
    {defaultCommissionBps:-10},
    {defaultCommissionBps:6000},
    {remindersEnabled:'yes'},
    {graceHours:4,unknownField:true}
   ]){
    await assert.rejects(
     updateWeeklySettlementSettings(db,configAdmin,bad),
     err=>err.status===400,
     `Expected 400 for invalid settings: ${JSON.stringify(bad)}`
    );
   }

   // 3. Authorized finance:configure admin updates settings cleanly.
   const updated=await updateWeeklySettlementSettings(db,configAdmin,{
    cutoffDayOfWeek:2,
    cutoffTimeUtc:'06:30:00',
    graceHours:12,
    defaultCommissionBps:1300,
    remindersEnabled:false
   });
   assert.equal(updated.cutoff_day_of_week,2);
   assert.equal(String(updated.cutoff_time_utc),'06:30:00');
   assert.equal(updated.grace_hours,12);
   assert.equal(updated.reminders_enabled,false);

   // 4. Adjacent admin endpoints enforce permissions.
   await assert.rejects(getAdminSettlementOverview(db,{actor:unprivAdmin}),err=>err.status===403);
   assert.ok(await getAdminSettlementOverview(db,{actor:readAdmin}));

   const comm=commissionEngine(db);
   await assert.rejects(comm.listRules(unprivAdmin),err=>err.status===403);
   assert.ok(Array.isArray(await comm.listRules(readAdmin)));
   await assert.rejects(
    comm.createRule(readAdmin,{name:'Unauthorized Rule',category:'delivery_default',scopeType:'global',rateBps:1200,reason:'Attempt by read-only admin'}),
    err=>err.status===403
   );
   const createdRule=await comm.createRule(configAdmin,{name:'Authorized Rule',category:'delivery_default',scopeType:'global',rateBps:1200,reason:'Authorized finance config change'});
   assert.equal(createdRule.rateBps,1200);
  }));
  await t.test('weekly financial history aggregation never multiplies accrued or job counts across multiple allocations and distinguishes non-shipment obligations',()=>fixture(async({db,c})=>{
   const riderId=randomUUID(),ship1=randomUUID(),ship2=randomUUID(),quote1=randomUUID(),quote2=randomUUID();
   await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'fixture','rider',now())",[riderId,'+2332'+String(randomInt(10000000,99999999))]);
   await c.query("INSERT INTO riders(id,status,vehicle,max_weight_g) VALUES($1,'approved','motorcycle',20000)",[riderId]);
   await c.query('INSERT INTO commission_accounts(rider_id) VALUES($1)',[riderId]);
   for(const [qid,sid,amt,comm] of [[quote1,ship1,10000,1300],[quote2,ship2,20000,2600]]){
    await c.query("INSERT INTO quotes(id,customer_id,policy_id,request,amount_minor,commission_minor,expires_at) SELECT $1,u.id,p.id,'{}'::jsonb,$2,$3,now()+interval '1 hour' FROM (SELECT id FROM users WHERE kind='customer' LIMIT 1) u CROSS JOIN (SELECT id FROM pricing_policies LIMIT 1) p",[qid,amt,comm]);
    await c.query("INSERT INTO shipments(id,customer_id,quote_id,idempotency_key,rider_id,recipient_phone,amount_minor,commission_minor,payment_method,cash_payer,state,completed_at) SELECT $1,customer_id,$2,$6,$3,'+233241234567',$4,$5,'CASH','recipient','COMPLETED',now() FROM quotes WHERE id=$2",[sid,qid,riderId,amt,comm,'ship-hist-'+sid]);
    await postCashCommission(c,{id:sid,rider_id:riderId,payment_method:'CASH',commission_minor:comm});
   }

   // Add a non-shipment reinstated obligation (500 minor) in the same week.
   const currentWeekKey=getGhanaWeekKey(new Date());
   await journal(c,{eventKey:'reinstate:test:'+riderId,riderId,kind:'reinstate',value:500});
   await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at,week_key) VALUES($1,NULL,$2,500,now()+interval '7 days',$3)",[randomUUID(),riderId,currentWeekKey]);

   // Apply THREE separate partial repayments (500, 600, 700 = 1800 total) so the first obligation (1300)
   // receives THREE allocation rows (500 + 600 + 200 = 1300) and the second obligation (2600) receives one (500).
   const ob1=(await c.query('SELECT id FROM commission_obligations WHERE shipment_id=$1',[ship1])).rows[0].id;
   const ob2=(await c.query('SELECT id FROM commission_obligations WHERE shipment_id=$1',[ship2])).rows[0].id;
   const j1=await journal(c,{eventKey:'repay:1:'+riderId,riderId,kind:'commission_repayment',value:500});
   await c.query('INSERT INTO commission_allocations(journal_id,obligation_id,amount_minor) VALUES($1,$2,500)',[j1.id,ob1]);
   const j2=await journal(c,{eventKey:'repay:2:'+riderId,riderId,kind:'commission_repayment',value:600});
   await c.query('INSERT INTO commission_allocations(journal_id,obligation_id,amount_minor) VALUES($1,$2,600)',[j2.id,ob1]);
   const j3=await journal(c,{eventKey:'repay:3:'+riderId,riderId,kind:'commission_repayment',value:700});
   await c.query('INSERT INTO commission_allocations(journal_id,obligation_id,amount_minor) VALUES($1,$2,200),($1,$3,500)',[j3.id,ob1,ob2]);

   // Total accrued = 1300 + 2600 + 500 = 4400.
   // Total allocated = 500 + 600 + 700 = 1800.
   // Total outstanding = 4400 - 1800 = 2600 (2100 on ship2 + 500 on reinstated non-shipment obligation).
   const history=await getRiderWeeklyHistory(db,riderId);
   assert.equal(history.length,1);
   const week=history[0];
   assert.equal(week.weekKey,currentWeekKey);
   assert.equal(week.jobCount,2,'jobCount must count only shipment obligations and never multiply by allocation rows');
   assert.equal(week.obligationCount,3,'obligationCount must count all 3 obligations once');
   assert.equal(week.accruedMinor,4400,'accruedMinor must not be multiplied by multiple allocations on ob1');
   assert.equal(week.allocatedMinor,1800);
   assert.equal(week.outstandingMinor,2600);

   const weeklyBal=await getRiderWeeklyBalance(c,riderId);
   const ledgerBal=await balance(c,riderId);
   const summary=await getRiderWeeklySummary(db,riderId);
   assert.equal(weeklyBal.totalPayableMinor,2600);
   assert.equal(weeklyBal.currentWeekJobs,1,'Only 1 unpaid shipment job remains (ship1 is settled, 500 is non-shipment)');
   assert.equal(ledgerBal.dueMinor,2600);
   assert.equal(summary.totalPayableMinor,2600);
  }));
  await t.test('late verified payments on expired or failed intents recover repayment or unapplied refund liability idempotently without discarding money',()=>fixture(async({db,c})=>{
   const riderId=randomUUID();
   await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'fixture','rider',now())",[riderId,'+2332'+String(randomInt(10000000,99999999))]);
   await c.query("INSERT INTO riders(id,status,vehicle,max_weight_g,financial_restriction,financial_restriction_at) VALUES($1,'approved','motorcycle',20000,'OVERDUE_CASH_COMMISSION',now())",[riderId]);
   await c.query('INSERT INTO commission_accounts(rider_id) VALUES($1)',[riderId]);
   await journal(c,{eventKey:'seed:late:'+riderId,riderId,kind:'cash_commission',value:1500});
   await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at,week_key) VALUES($1,NULL,$2,1500,now()-interval '4 days',$3)",[randomUUID(),riderId,getGhanaWeekKey(new Date(Date.now()-8*86400000))]);

   const riderActor={id:riderId,kind:'rider'};
   const receiptByRef=new Map();
   let activeWebhookReceipt=null;
   const commProvider={
    name:'late_psp',
    allowedCheckoutHosts:['checkout.test'],
    payerFields:['email'],
    commissionIntentId(r){const ref=typeof r==='string'?r:r?.reference||'';const m=/^escomm_([0-9a-f]{32})$/.exec(ref);if(!m)return null;const h=m[1];return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');},
    async createPayment(x){return {reference:x.reference,checkoutUrl:'https://checkout.test/late/'+x.intentId};},
    async verifyPayment(ref){return receiptByRef.get(ref)??{verified:true,status:'pending',reference:ref};},
    async parseVerifiedWebhook(){return activeWebhookReceipt;}
   };
   const finance=financeService(db,{provider:commProvider});
   const wh=paymentWebhook({db,provider:commProvider,checkout:null,finance});

   // 1. Initiate first attempt (1500 minor), then simulate local expiration before payment arrives.
   const first=await finance.initiate(riderActor,{
    kind:'commission_repayment',
    amountMinor:1500,
    idempotencyKey:'late-exp-001',
    email:'rider@example.test',
    momoNetwork:'MTN',
    momoPhone:'0244123456'
   });
   await c.query(
    "UPDATE settlement_intents SET status='expired',failure_reason='Expired locally before webhook arrived',last_reconciled_at=NULL,updated_at=now()-interval '10 seconds' WHERE id=$1",
    [first.intentId]
   );

   // Database trigger blocks resurrecting an expired intent back to 'pending' or 'initiating'.
   await assert.rejects(
    db.tx(txC=>txC.query("UPDATE settlement_intents SET status='pending' WHERE id=$1",[first.intentId])),
    /cannot be resurrected/
   );

   // 2. Rider starts a second attempt (1500 minor) after the first expired; first is polled during pre-reconcile (still pending at PSP),
   // so second attempt proceeds to 'pending' and then is paid and confirmed.
   const second=await finance.initiate(riderActor,{
    kind:'commission_repayment',
    amountMinor:1500,
    idempotencyKey:'late-exp-002',
    email:'rider@example.test',
    momoNetwork:'MTN',
    momoPhone:'0244123456'
   });
   const secondEventId='evt_second_'+randomUUID();
   receiptByRef.set(second.reference,{
    verified:true,
    reference:second.reference,
    status:'success',
    amountMinor:1500,
    currency:'GHS',
    channel:'mobile_money',
    eventId:secondEventId
   });
   const secondConfirm=await finance.reconcileIntent(second.intentId);
   assert.equal(secondConfirm.status,'confirmed');
   assert.equal(secondConfirm.collectedMinor,1500);
   assert.equal(secondConfirm.unappliedProviderMinor,0);
   assert.equal((await balance(c,riderId)).dueMinor,0);
   assert.equal((await c.query('SELECT financial_restriction FROM riders WHERE id=$1',[riderId])).rows[0].financial_restriction,null);

   // 3. Now a late verified payment arrives for the FIRST (expired) intent!
   // Because dueMinor is now 0, the late payment must STILL be accepted, transition the expired intent to 'confirmed',
   // and record 1500 minor in unapplied_provider_funds refund liability without discarding money or duplicating repayment.
   const firstEventId='evt_first_late_'+randomUUID();
   const firstReceipt={
    verified:true,
    reference:first.reference,
    status:'success',
    amountMinor:1500,
    currency:'GHS',
    channel:'mobile_money',
    eventId:firstEventId
   };
   receiptByRef.set(first.reference,firstReceipt);
   activeWebhookReceipt=firstReceipt;

   const lateWebhookRes=await wh(Buffer.from('{}'),{});
   assert.equal(lateWebhookRes.status,'confirmed');
   assert.equal(lateWebhookRes.lateRecovery,true);
   assert.equal(lateWebhookRes.collectedMinor,0);
   assert.equal(lateWebhookRes.unappliedProviderMinor,1500);
   assert.equal(lateWebhookRes.requiresReconciliation,true);

   // Duplicate webhook and reconciliation on the recovered late payment must be idempotent.
   const dupWebhookRes=await wh(Buffer.from('{}'),{});
   assert.equal(dupWebhookRes.duplicate,true);
   const dupReconcileRes=await finance.reconcileIntent(first.intentId);
   assert.equal(dupReconcileRes.duplicate,true);

   const bAfterLate=await balance(c,riderId);
   assert.equal(bAfterLate.dueMinor,0,'Receivable must remain 0');
   assert.equal(bAfterLate.unappliedProviderMinor,1500,'Late duplicate payment on expired intent must be recorded as unapplied refund liability');

   // 4. Also verify an expired intent that is reconciled via reconcileDue when debt IS still unpaid settles the debt directly.
   await journal(c,{eventKey:'seed:late2:'+riderId,riderId,kind:'cash_commission',value:900});
   await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at,week_key) VALUES($1,NULL,$2,900,now()-interval '2 days',$3)",[randomUUID(),riderId,getGhanaWeekKey(new Date(Date.now()-8*86400000))]);
   const third=await finance.initiate(riderActor,{
    kind:'commission_repayment',
    amountMinor:900,
    idempotencyKey:'late-exp-003',
    email:'rider@example.test',
    momoNetwork:'MTN',
    momoPhone:'0244123456'
   });
   await c.query(
    "UPDATE settlement_intents SET status='expired',failure_reason='Superseded by newer pending settlement intent before migration 036',last_reconciled_at=NULL,updated_at=now()-interval '30 seconds',submitted_at=now()-interval '30 seconds' WHERE id=$1",
    [third.intentId]
   );
   receiptByRef.set(third.reference,{
    verified:true,
    reference:third.reference,
    status:'success',
    amountMinor:900,
    currency:'GHS',
    channel:'mobile_money',
    eventId:'evt_third_late_'+randomUUID()
   });
   const dueRecovered=await finance.reconcileDue({olderThanSeconds:1});
   assert.ok(dueRecovered.some(r=>r.intentId===third.intentId&&r.status==='confirmed'));
   assert.equal((await balance(c,riderId)).dueMinor,0,'Late payment on expired intent with open debt must settle the obligation');
  }));
  await t.test('database-backed submission ownership prevents creation/reconciliation races, protects not_created while creation can complete, and blocks delayed creation responses from resurrecting failed/expired intents',()=>fixture(async({db,c})=>{
   const riderId=randomUUID();
   await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'fixture','rider',now())",[riderId,'+2332'+String(randomInt(10000000,99999999))]);
   await c.query("INSERT INTO riders(id,status,vehicle,max_weight_g) VALUES($1,'approved','motorcycle',20000)",[riderId]);
   await c.query('INSERT INTO commission_accounts(rider_id) VALUES($1)',[riderId]);
   await journal(c,{eventKey:'seed:race:'+riderId,riderId,kind:'cash_commission',value:2000});
   await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at,week_key) VALUES($1,NULL,$2,2000,now()+interval '5 days',$3)",[randomUUID(),riderId,getGhanaWeekKey(new Date())]);

   const riderActor={id:riderId,kind:'rider'};
   let releaseCreate1,create1StartedResolve;
   const create1Started=new Promise(r=>{create1StartedResolve=r;});
   const create1Gate=new Promise(r=>{releaseCreate1=r;});
   let createMode='gate1';
   let verifyStatus='not_created';

   const sharedProvider={
    name:'race_psp',
    allowedCheckoutHosts:['checkout.test'],
    payerFields:['email'],
    async createPayment(x){
     if(createMode==='gate1'){
      create1StartedResolve(x);
      await create1Gate;
     }
     return {reference:x.reference,checkoutUrl:'https://checkout.test/race/'+x.intentId};
    },
    async verifyPayment(ref){
     if(verifyStatus==='not_created'){
      return {verified:true,status:'not_created',definitiveNoCharge:true,reference:ref};
     }
     if(verifyStatus==='pending'){
      return {verified:true,status:'pending',reference:ref};
     }
     return {verified:true,status:'not_created',definitiveNoCharge:false,reference:ref};
    }
   };

   // Two distinct service instances representing separate API and Worker processes sharing only PostgreSQL.
   const apiInstance=financeService(db,{provider:sharedProvider,submissionLeaseSeconds:60});
   const workerInstance=financeService(db,{provider:sharedProvider,submissionLeaseSeconds:60});

   // 1. Start payment creation on apiInstance; pause inside provider.createPayment.
   const pInitiate1=apiInstance.initiate(riderActor,{
    kind:'commission_repayment',
    amountMinor:1000,
    idempotencyKey:'race-sub-001',
    email:'rider@example.test',
    momoNetwork:'MTN',
    momoPhone:'0244123456'
   });
   const createdReq1=await create1Started;

   const rowDuringCreate=(await c.query('SELECT * FROM settlement_intents WHERE id=$1',[createdReq1.intentId])).rows[0];
   assert.equal(rowDuringCreate.status,'initiating');
   assert.ok(rowDuringCreate.submission_token,'Database submission_token must be set while creation is in flight');
   assert.ok(new Date(rowDuringCreate.submission_lease_until).getTime()>Date.now(),'Database submission_lease_until must be in the future');

   // 2. While creation is in flight and leased in DB, workerInstance.reconcileDue must skip the row,
   // and workerInstance.reconcileIntent must NOT treat "not_created" as a definitive failure.
   await c.query("UPDATE settlement_intents SET submitted_at=now()-interval '10 seconds',updated_at=now()-interval '10 seconds' WHERE id=$1",[createdReq1.intentId]);
   const dueWhileLeased=await workerInstance.reconcileDue({olderThanSeconds:1});
   assert.equal(dueWhileLeased.length,0,'Worker reconcileDue must skip initiating intent while submission_lease_until is active');

   const directRecWhileLeased=await workerInstance.reconcileIntent(createdReq1.intentId);
   assert.equal(directRecWhileLeased.status,'initiating','reconcileIntent must not mark not_created as failed while submission lease is active');
   assert.equal(directRecWhileLeased.submissionInProgress,true);
   assert.equal((await c.query('SELECT status FROM settlement_intents WHERE id=$1',[createdReq1.intentId])).rows[0].status,'initiating');

   // 3. Simulate submission lease expiration while apiInstance's createPayment is still stalled,
   // and workerInstance reconciles "not_created" (definitiveNoCharge: true) -> marks intent1 'failed'.
   await c.query("UPDATE settlement_intents SET submission_lease_until=now()-interval '5 seconds' WHERE id=$1",[createdReq1.intentId]);
   const recAfterLeaseExpiry=await workerInstance.reconcileIntent(createdReq1.intentId);
   assert.equal(recAfterLeaseExpiry.status,'failed');
   assert.equal((await c.query('SELECT status,submission_token FROM settlement_intents WHERE id=$1',[createdReq1.intentId])).rows[0].status,'failed');

   // 4. Rider starts a new attempt (intent2) which succeeds and transitions to 'pending'.
   createMode='immediate';
   const intent2=await workerInstance.initiate(riderActor,{
    kind:'commission_repayment',
    amountMinor:1000,
    idempotencyKey:'race-sub-002',
    email:'rider@example.test',
    momoNetwork:'MTN',
    momoPhone:'0244123456'
   });
   assert.equal(intent2.status,'pending');

   // 5. Now release the delayed creation response on apiInstance for intent1!
   // Guarded transition must reject resurrecting intent1 from 'failed' to 'pending' and must not disturb intent2.
   releaseCreate1();
   await assert.rejects(
    pInitiate1,
    err=>err.status===409&&/expired or was superseded/.test(err.message)
   );
   const intent1AfterDelayed=(await c.query('SELECT status FROM settlement_intents WHERE id=$1',[createdReq1.intentId])).rows[0];
   const intent2AfterDelayed=(await c.query('SELECT status FROM settlement_intents WHERE id=$1',[intent2.intentId])).rows[0];
   assert.equal(intent1AfterDelayed.status,'failed','Delayed creation response must never resurrect failed intent');
   assert.equal(intent2AfterDelayed.status,'pending','Active replacement intent must remain pending');

   // Also verify that "not_created" on an already 'pending' intent is NEVER treated as failure.
   const recPendingNotCreated=await workerInstance.reconcileIntent(intent2.intentId);
   assert.equal(recPendingNotCreated.status,'pending','Already pending intent must never fail on stale not_created response');
  }));
  await t.test('expired intents keep polling through non-terminal provider responses and recover a later success without any webhook; only verified terminal outcomes stop polling',()=>fixture(async({db,c})=>{
   const riderId=randomUUID();
   await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'fixture','rider',now())",[riderId,'+2332'+String(randomInt(10000000,99999999))]);
   await c.query("INSERT INTO riders(id,status,vehicle,max_weight_g,financial_restriction,financial_restriction_at) VALUES($1,'approved','motorcycle',20000,'OVERDUE_CASH_COMMISSION',now())",[riderId]);
   await c.query('INSERT INTO commission_accounts(rider_id) VALUES($1)',[riderId]);
   await journal(c,{eventKey:'seed:poll:'+riderId,riderId,kind:'cash_commission',value:1200});
   await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at,week_key) VALUES($1,NULL,$2,1200,now()-interval '4 days',$3)",[randomUUID(),riderId,getGhanaWeekKey(new Date(Date.now()-8*86400000))]);
   const riderActor={id:riderId,kind:'rider'};
   const statusByRef=new Map();
   let verifyCalls=0;
   const commProvider={
    name:'poll_psp',allowedCheckoutHosts:['checkout.test'],payerFields:['email'],
    async createPayment(x){return {reference:x.reference,checkoutUrl:'https://checkout.test/poll/'+x.intentId};},
    async verifyPayment(ref){verifyCalls++;return statusByRef.get(ref)??{verified:true,status:'pending',reference:ref};},
    async parseVerifiedWebhook(){return null;}
   };
   const finance=financeService(db,{provider:commProvider,checkoutExpirySeconds:3600});
   const ageRow=(id,seconds)=>c.query("UPDATE settlement_intents SET last_reconciled_at=now()-make_interval(secs=>$2),submitted_at=now()-make_interval(secs=>$2) WHERE id=$1",[id,seconds]);

   // A. expired -> provider pending -> later success, no webhook.
   const a=await finance.initiate(riderActor,{kind:'commission_repayment',amountMinor:1200,idempotencyKey:'poll-exp-001',email:'rider@example.test',momoNetwork:'MTN',momoPhone:'0244123456'});
   await c.query("UPDATE settlement_intents SET status='expired',failure_reason='Expired locally',last_reconciled_at=NULL,submitted_at=now()-interval '30 seconds' WHERE id=$1",[a.intentId]);
   const poll1=await finance.reconcileDue({olderThanSeconds:1});
   const r1=poll1.find(r=>r.intentId===a.intentId);
   assert.ok(r1,'expired intent must be polled');
   assert.equal(r1.status,'expired');assert.equal(r1.verificationContinues,true);
   const finAdmin={id:randomUUID(),kind:'admin'};
   await c.query("INSERT INTO users(id,phone,password_hash,kind) VALUES($1,$2,'fixture','admin')",[finAdmin.id,'+2332'+String(randomInt(10000000,99999999))]);
   await c.query("INSERT INTO permissions(user_id,permission) VALUES($1,'finance:read')",[finAdmin.id]);
   await assert.rejects(finance.settlementExceptions({id:riderId,kind:'rider'}),err=>err.status===403);
   assert.ok((await finance.settlementExceptions(finAdmin)).unresolved.some(x=>x.id===a.intentId&&x.provider_last_status==='pending'),'unresolved expired intent is visible to finance operators');
   const afterPending=(await c.query('SELECT status,last_reconciled_at,provider_terminal_at,provider_last_status FROM settlement_intents WHERE id=$1',[a.intentId])).rows[0];
   assert.ok(afterPending.last_reconciled_at,'non-terminal poll records attempt time');
   assert.equal(afterPending.provider_terminal_at,null,'pending provider response is not terminal');
   assert.equal(afterPending.provider_last_status,'pending');
   // Backoff: an immediate second poll skips it; once the backoff elapses it is polled again.
   assert.equal((await finance.reconcileDue({olderThanSeconds:60})).some(r=>r.intentId===a.intentId),false);
   await ageRow(a.intentId,120);
   const poll2=await finance.reconcileDue({olderThanSeconds:60});
   assert.equal(poll2.find(r=>r.intentId===a.intentId)?.providerStatus,'pending','still polled after a non-terminal response');
   // Payment completes later at the provider; webhook is never delivered.
   statusByRef.set(a.reference,{verified:true,reference:a.reference,status:'success',amountMinor:1200,currency:'GHS',channel:'mobile_money',eventId:'evt_poll_a_'+randomUUID()});
   await ageRow(a.intentId,120);
   const poll3=await finance.reconcileDue({olderThanSeconds:60});
   const r3=poll3.find(r=>r.intentId===a.intentId);
   assert.equal(r3?.status,'confirmed');assert.equal(r3.lateRecovery,true);assert.equal(r3.collectedMinor,1200);
   assert.equal((await balance(c,riderId)).dueMinor,0);
   assert.equal((await c.query('SELECT financial_restriction FROM riders WHERE id=$1',[riderId])).rows[0].financial_restriction,null);
   const confirmedRow=(await c.query('SELECT status,provider_terminal_at FROM settlement_intents WHERE id=$1',[a.intentId])).rows[0];
   assert.equal(confirmedRow.status,'confirmed');assert.ok(confirmedRow.provider_terminal_at);
   // Crash/restart: a fresh service instance does not re-poll or re-post a confirmed intent.
   const restarted=financeService(db,{provider:commProvider});
   await ageRow(a.intentId,120);
   assert.equal((await restarted.reconcileDue({olderThanSeconds:1})).some(r=>r.intentId===a.intentId),false);
   assert.equal((await c.query("SELECT count(*)::int AS n FROM finance_journals WHERE rider_id=$1 AND kind='commission_repayment'",[riderId])).rows[0].n,1);
   assert.equal((await finance.settlementExceptions(finAdmin)).unresolved.some(x=>x.id===a.intentId),false,'confirmed intent leaves the exception queue');

   // B. Abandoned (non-terminal) checkout past its window is expired to free the slot, keeps polling, and recovers.
   await journal(c,{eventKey:'seed:poll2:'+riderId,riderId,kind:'cash_commission',value:800});
   await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at,week_key) VALUES($1,NULL,$2,800,now()+interval '3 days',$3)",[randomUUID(),riderId,getGhanaWeekKey(new Date())]);
   const b=await finance.initiate(riderActor,{kind:'commission_repayment',amountMinor:800,idempotencyKey:'poll-abn-001',email:'rider@example.test',momoNetwork:'MTN',momoPhone:'0244123456'});
   statusByRef.set(b.reference,{verified:true,status:'abandoned',reference:b.reference});
   await c.query("UPDATE settlement_intents SET created_at=now()-interval '2 hours' WHERE id=$1",[b.intentId]);
   await ageRow(b.intentId,7200);
   const rb=(await finance.reconcileDue({olderThanSeconds:1})).find(r=>r.intentId===b.intentId);
   assert.equal(rb?.status,'expired','abandoned is non-terminal: checkout window expiry, not failure');
   assert.equal((await c.query('SELECT provider_terminal_at FROM settlement_intents WHERE id=$1',[b.intentId])).rows[0].provider_terminal_at,null);
   statusByRef.set(b.reference,{verified:true,reference:b.reference,status:'success',amountMinor:800,currency:'GHS',channel:'mobile_money',eventId:'evt_poll_b_'+randomUUID()});
   await ageRow(b.intentId,7200);
   assert.equal((await finance.reconcileDue({olderThanSeconds:1})).find(r=>r.intentId===b.intentId)?.status,'confirmed');
   assert.equal((await balance(c,riderId)).dueMinor,0);

   // C. A verified terminal failure on an expired intent stops scheduled polling; provider timeouts do not.
   await journal(c,{eventKey:'seed:poll3:'+riderId,riderId,kind:'cash_commission',value:500});
   await c.query("INSERT INTO commission_obligations(id,shipment_id,rider_id,original_minor,due_at,week_key) VALUES($1,NULL,$2,500,now()+interval '3 days',$3)",[randomUUID(),riderId,getGhanaWeekKey(new Date())]);
   const d=await finance.initiate(riderActor,{kind:'commission_repayment',amountMinor:500,idempotencyKey:'poll-term-001',email:'rider@example.test',momoNetwork:'MTN',momoPhone:'0244123456'});
   await c.query("UPDATE settlement_intents SET status='expired',failure_reason='Expired locally' WHERE id=$1",[d.intentId]);
   const timeoutProvider={...commProvider,async verifyPayment(){throw Object.assign(Error('timeout'),{code:'provider_timeout'});}};
   await ageRow(d.intentId,120);
   assert.equal((await financeService(db,{provider:timeoutProvider,verifyTimeoutMs:50}).reconcileDue({olderThanSeconds:1})).find(r=>r.intentId===d.intentId)?.status,'verification_unavailable');
   assert.equal((await c.query('SELECT provider_terminal_at FROM settlement_intents WHERE id=$1',[d.intentId])).rows[0].provider_terminal_at,null,'timeouts never end verification');
   statusByRef.set(d.reference,{verified:true,status:'failed',failureReason:'Declined by subscriber',reference:d.reference});
   await ageRow(d.intentId,120);
   const rd=(await finance.reconcileDue({olderThanSeconds:1})).find(r=>r.intentId===d.intentId);
   assert.equal(rd?.terminal,true);assert.equal(rd.status,'expired');
   assert.ok((await c.query('SELECT provider_terminal_at FROM settlement_intents WHERE id=$1',[d.intentId])).rows[0].provider_terminal_at);
   verifyCalls=0;await ageRow(d.intentId,120);
   assert.equal((await finance.reconcileDue({olderThanSeconds:1})).some(r=>r.intentId===d.intentId),false,'terminal outcome stops scheduled polling');
   assert.equal(verifyCalls,0);
  }));
  await t.test('customer checkout lifecycle: non-terminal abandoned/pending, submission ownership leases, late payment recovery when payable vs cancelled, and concurrent multi-instance polling',()=>fixture(async({db,c,food,actor,kitchen,input,order,provider})=>{
   let createMode='immediate';
   let releaseStalledCreate,stalledCreateStartedResolve;
   const stalledCreateStarted=new Promise(r=>{stalledCreateStartedResolve=r;});
   const stalledCreateGate=new Promise(r=>{releaseStalledCreate=r;});
   const statusByRef=new Map();
   let verifyCalls=0;

   const psp={
    name:'cust_psp',
    methods:['MOMO'],
    allowedCheckoutHosts:['checkout.test'],
    async createCheckout(x){
     if(createMode==='stalled'){
      stalledCreateStartedResolve(x);
      await stalledCreateGate;
     }
     return {reference:x.reference,checkoutUrl:'https://checkout.test/pay/'+x.reference};
    },
    async verifyPayment(ref){
     verifyCalls++;
     return statusByRef.get(ref)??{verified:true,status:'pending',reference:ref};
    },
    async parseVerifiedWebhook(){return null;}
   };

   const apiCheckout=checkoutService(db,{provider:psp,submissionLeaseSeconds:60,checkoutExpirySeconds:3600});
   const workerCheckout=checkoutService(db,{provider:psp,submissionLeaseSeconds:60,checkoutExpirySeconds:3600});

   // 1. Database-backed submission ownership: while createCheckout is in flight and leased,
   // workerCheckout.reconcileDue skips it, and reconcileIntent does NOT treat not_created as failure.
   createMode='stalled';
   statusByRef.clear();
   const pInit1=apiCheckout.initiate(actor,order.shipment_id,{idempotencyKey:'cust-sub-001'});
   const req1=await stalledCreateStarted;
   statusByRef.set(req1.reference,{verified:true,status:'not_created',definitiveNoCharge:true,reference:req1.reference});
   await c.query("UPDATE shipment_checkout_intents SET submitted_at=now()-interval '15 seconds',updated_at=now()-interval '15 seconds' WHERE reference=$1",[req1.reference]);
   const rowLeased=(await c.query('SELECT * FROM shipment_checkout_intents WHERE reference=$1',[req1.reference])).rows[0];
   assert.equal(rowLeased.status,'initiating');
   assert.ok(rowLeased.submission_token);

   assert.equal((await workerCheckout.reconcileDue({olderThanSeconds:1})).length,0,'worker skips initiating intent while submission lease is active');
   const recWhileLeased=await workerCheckout.reconcileIntent(rowLeased.id);
   assert.equal(recWhileLeased.status,'initiating');
   assert.equal(recWhileLeased.submissionInProgress,true);

   // Expire submission lease while createCheckout is still stalled; reconcileIntent with definitive not_created marks it 'failed'.
   await c.query("UPDATE shipment_checkout_intents SET submission_lease_until=now()-interval '5 seconds' WHERE id=$1",[rowLeased.id]);
   const recAfterLease=await workerCheckout.reconcileIntent(rowLeased.id);
   assert.equal(recAfterLease.status,'failed');
   assert.equal(recAfterLease.terminal,true);

   // Customer starts a replacement checkout attempt (intent2) which becomes 'pending'.
   createMode='immediate';
   const intent2=await workerCheckout.initiate(actor,order.shipment_id,{idempotencyKey:'cust-sub-002'});
   assert.equal(intent2.status,'pending');

   // Release delayed creation response for intent1; guarded transition rejects resurrecting intent1 or overlapping intent2.
   releaseStalledCreate();
   await assert.rejects(pInit1,err=>err.status===409&&/expired or was superseded/.test(err.message));
   assert.equal((await c.query('SELECT status FROM shipment_checkout_intents WHERE id=$1',[rowLeased.id])).rows[0].status,'failed');
   assert.equal((await c.query('SELECT status FROM shipment_checkout_intents WHERE id=$1',[intent2.intentId])).rows[0].status,'pending');

   // 2. Non-terminal 'abandoned' status does NOT mark pending intent failed before checkout window elapses.
   statusByRef.set(intent2.reference,{verified:true,status:'abandoned',reference:intent2.reference});
   const recAbnActive=await workerCheckout.reconcileIntent(intent2.intentId);
   assert.equal(recAbnActive.status,'unverified_or_pending');
   assert.equal((await c.query('SELECT status,provider_terminal_at FROM shipment_checkout_intents WHERE id=$1',[intent2.intentId])).rows[0].status,'pending');

   // Once checkout window elapses, non-terminal 'abandoned' transitions to 'expired' (releasing active slot),
   // while provider_terminal_at remains NULL so scheduled polling continues!
    await c.query("UPDATE shipment_checkout_intents SET last_reconciled_at=now()-interval '2 hours',submitted_at=now()-interval '2 hours' WHERE id=$1",[intent2.intentId]);
   const dueExpired=await workerCheckout.reconcileDue({olderThanSeconds:1});
   const rExp=dueExpired.find(r=>r.id===intent2.intentId);
   assert.equal(rExp?.result?.status,'expired');
   assert.equal(rExp?.result?.verificationContinues,true);
   assert.equal((await c.query('SELECT provider_terminal_at FROM shipment_checkout_intents WHERE id=$1',[intent2.intentId])).rows[0].provider_terminal_at,null);

   // 3. Late verified payment on expired intent when order remains payable and unpaid -> applies payment and confirms order!
   statusByRef.set(intent2.reference,{
    verified:true,
    reference:intent2.reference,
    status:'success',
    amountMinor:Number(order.total_minor),
    currency:'GHS',
    channel:'mobile_money',
    eventId:'evt_cust_late_apply_'+randomUUID()
   });
   await c.query("UPDATE shipment_checkout_intents SET last_reconciled_at=now()-interval '2 hours' WHERE id=$1",[intent2.intentId]);
   const [pA,pB]=await Promise.all([apiCheckout.reconcileDue({olderThanSeconds:1}),workerCheckout.reconcileDue({olderThanSeconds:1})]);
   const combined=[...pA,...pB].filter(r=>r.id===intent2.intentId);
   assert.equal(combined.length,1,'reconcile_lease_until prevents concurrent workers from polling the same checkout intent');
   assert.equal(combined[0].result.status,'confirmed');
   assert.equal(combined[0].result.lateRecovery,true);
   assert.equal((await c.query('SELECT paid,state FROM shipments WHERE id=$1',[order.shipment_id])).rows[0].paid,true);
   assert.equal((await c.query('SELECT payment_status FROM food_orders WHERE id=$1',[order.id])).rows[0].payment_status,'PAID');

   // 4. Late verified payment after order cancellation (or expiry) with missed webhook -> recovered by scheduled polling into refund_review!
   const order2=await food.createFoodOrder(actor,input,{paymentMethod:'MOMO',idempotencyKey:randomUUID()});
   const intent3=await apiCheckout.initiate(actor,order2.shipment_id,{idempotencyKey:'cust-sub-003'});
   await food.cancelOrder(actor,order2.id,{reason:'Customer cancelled before webhook'});
   const afterCancel=(await c.query('SELECT status,provider_terminal_at FROM shipment_checkout_intents WHERE id=$1',[intent3.intentId])).rows[0];
   assert.equal(afterCancel.status,'expired','Order cancellation expires open checkout intent');
   assert.equal(afterCancel.provider_terminal_at,null,'provider_terminal_at stays NULL so late payment is still polled');

   statusByRef.set(intent3.reference,{
    verified:true,
    reference:intent3.reference,
    status:'success',
    amountMinor:Number(order2.total_minor),
    currency:'GHS',
    channel:'mobile_money',
    eventId:'evt_cust_late_cancel_'+randomUUID()
   });
   await c.query("UPDATE shipment_checkout_intents SET last_reconciled_at=NULL,submitted_at=now()-interval '30 seconds' WHERE id=$1",[intent3.intentId]);
   const dueCancelRec=await workerCheckout.reconcileDue({olderThanSeconds:1});
   const rCancelRec=dueCancelRec.find(r=>r.id===intent3.intentId);
   assert.equal(rCancelRec?.result?.status,'refund_review');
   assert.equal((await c.query('SELECT count(*)::int AS n FROM checkout_unapplied_payments WHERE intent_id=$1',[intent3.intentId])).rows[0].n,1);
   assert.ok((await c.query('SELECT provider_terminal_at FROM shipment_checkout_intents WHERE id=$1',[intent3.intentId])).rows[0].provider_terminal_at,'provider_terminal_at is set once unapplied payment is recorded');
  }));
  await t.test('food pickup verification sends OTP to restaurant handover contact while preserving parcel pickup and customer delivery OTPs and enforcing challenge bindings',()=>fixture(async({db,c,food,actor,kitchen,order,pay})=>{
   await pay();
   await food.acceptOrder(kitchen,order.id,{estimatedPrepMinutes:15});
   await food.markReadyForPickup(kitchen,order.id);
   const rider1=randomUUID(),rider2=randomUUID();
   for(const r of [rider1,rider2]){
    await c.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'fixture','rider',now())",[r,'+2332'+String(randomInt(10000000,99999999))]);
    await c.query("INSERT INTO riders(id,status,vehicle,max_weight_g) VALUES($1,'approved','motorcycle',20000)",[r]);
     if(r===rider1)await c.query('INSERT INTO rider_dispatch_plans(rider_id,stops) VALUES($1,$2)',[r,JSON.stringify([{shipmentId:order.shipment_id,kind:'pickup',latitude:5.60,longitude:-0.18,weightG:1000},{shipmentId:order.shipment_id,kind:'dropoff',latitude:5.61,longitude:-0.19,weightG:1000}])]);
   }
   await c.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[order.shipment_id,rider1]);

   const sentMessages=[];
   const sms={async send(msg){sentMessages.push(msg);return {accepted:true};}};
   const app=platformService(db,{otpKey:'b'.repeat(64),sms,routing:{route:async()=>({distanceMeters:2000,durationSeconds:300,source:'fixture'})}});

   // 1. Food pickup challenge sends OTP to restaurant's phone (+233241234567), NOT customer's user phone.
   const restRow=(await c.query('SELECT phone FROM restaurants WHERE id=$1',[order.restaurant_id])).rows[0];
   const custRow=(await c.query('SELECT phone FROM users WHERE id=$1',[actor.id])).rows[0];
   assert.notEqual(restRow.phone,custRow.phone);

   const pickupCh=await app.challenge({id:rider1,kind:'rider'},order.shipment_id,'pickup');
   assert.equal(sentMessages.length,1);
   assert.equal(sentMessages[0].purpose,'pickup');
   assert.equal(sentMessages[0].phone,restRow.phone,'Food pickup OTP must be sent to restaurant phone');
   const pickupCode=sentMessages[0].code;

   // Unassigned rider cannot verify challenge.
   await assert.rejects(
    app.verify({id:rider2,kind:'rider'},order.shipment_id,{challengeId:pickupCh.challengeId,code:pickupCode}),
    err=>err.status===403
   );

   // Wrong code increments attempts and rejects.
   const wrongCode=pickupCode==='000000'?'999999':'000000';
   await assert.rejects(
    app.verify({id:rider1,kind:'rider'},order.shipment_id,{challengeId:pickupCh.challengeId,code:wrongCode}),
    err=>err.status===400
   );
   assert.equal((await c.query('SELECT attempts FROM challenges WHERE id=$1',[pickupCh.challengeId])).rows[0].attempts,1);

   // Tampering with stored phone on the challenge row is caught by recipient binding.
   await c.query('UPDATE challenges SET phone=$2 WHERE id=$1',[pickupCh.challengeId,custRow.phone]);
   await assert.rejects(
    app.verify({id:rider1,kind:'rider'},order.shipment_id,{challengeId:pickupCh.challengeId,code:pickupCode}),
    /Challenge recipient mismatch/
   );
   await c.query('UPDATE challenges SET phone=$2 WHERE id=$1',[pickupCh.challengeId,restRow.phone]);

   // Correct verification advances shipment to PICKUP_VERIFIED and food_order to IN_TRANSIT.
   const verifiedPickup=await app.verify({id:rider1,kind:'rider'},order.shipment_id,{challengeId:pickupCh.challengeId,code:pickupCode});
   assert.equal(verifiedPickup.ok,true);
   assert.equal((await c.query('SELECT state FROM shipments WHERE id=$1',[order.shipment_id])).rows[0].state,'PICKUP_VERIFIED');
   assert.equal((await c.query('SELECT state FROM food_orders WHERE id=$1',[order.id])).rows[0].state,'IN_TRANSIT');

   // 2. Customer delivery OTP still goes to shipment.recipient_phone.
   await app.transition({id:rider1,kind:'rider'},order.shipment_id,{action:'start'});
   const delivCh=await app.challenge({id:rider1,kind:'rider'},order.shipment_id,'delivery');
   assert.equal(sentMessages.length,2);
   assert.equal(sentMessages[1].purpose,'delivery');
   const shipRow=(await c.query('SELECT recipient_phone FROM shipments WHERE id=$1',[order.shipment_id])).rows[0];
   assert.equal(sentMessages[1].phone,shipRow.recipient_phone);
   assert.equal((await app.verify({id:rider1,kind:'rider'},order.shipment_id,{challengeId:delivCh.challengeId,code:sentMessages[1].code})).ok,true);
   assert.equal((await c.query('SELECT state FROM food_orders WHERE id=$1',[order.id])).rows[0].state,'DELIVERED');

   // 3. Parcel pickup challenge still sends OTP to the customer (sender) phone.
   const parcelQuote=await app.quote(actor,{
    pickup:{address:'Accra Mall Pickup',latitude:5.6214,longitude:-0.1741},
    destination:{address:'Osu Oxford Dropoff',latitude:5.5560,longitude:-0.1825},
    vehicle:'motorcycle',
    recipientPhone:'+233209998877',
    weightG:1000,
    description:'Documents',
    paymentMethod:'CASH',
    cashPayer:'recipient'
   });
   const parcelShip=await app.book(actor,{quoteId:parcelQuote.id},'parcel-idem-'+randomUUID());
   await c.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[parcelShip.id,rider1]);
    await c.query('UPDATE rider_dispatch_plans SET stops=$2 WHERE rider_id=$1',[rider1,JSON.stringify([{shipmentId:parcelShip.id,kind:'pickup',latitude:5.6214,longitude:-0.1741,weightG:1000},{shipmentId:parcelShip.id,kind:'dropoff',latitude:5.5560,longitude:-0.1825,weightG:1000}])]);
   await app.challenge({id:rider1,kind:'rider'},parcelShip.id,'pickup');
   assert.equal(sentMessages.length,3);
   assert.equal(sentMessages[2].phone,custRow.phone,'Parcel pickup OTP must still be sent to sender customer phone');
  }));
  await t.test('restaurant order listing includes items and modifiers, and account phone verification handles attempt expiry and resend cleanly',()=>fixture(async({db,c,food,actor,kitchen,order})=>{
   const listForKitchen=await food.listFoodOrders(kitchen,{restaurantId:order.restaurant_id});
   const found=listForKitchen.find(o=>o.id===order.id);
   assert.ok(found,'listFoodOrders returns the restaurant order');
   assert.ok(Array.isArray(found.items)&&found.items.length===1,'listFoodOrders includes food_order_items array');
   assert.equal(found.items[0].name,'Test food');
   assert.equal(Number(found.items[0].unit_price_minor),5000);
   assert.equal(Number(found.items[0].total_price_minor),5000);
   assert.equal(found.shipment_paid,false);

   // Test account phone verification flow (register -> phoneStatus -> phoneChallenge -> 5 wrong attempts expire challenge -> resend -> verifyPhone)
   const sentSms=[];
   const app=platformService(db,{otpKey:'c'.repeat(64),sms:{async send(m){sentSms.push(m);return {accepted:true};}}});
   const reg=await app.register({phone:'024'+String(randomInt(1000000,9999999)),password:'StrongPassword123!',kind:'customer',name:'New User'});
   assert.equal(reg.phoneVerified,false);
   const newActor={id:reg.id,kind:'customer'};
   assert.equal((await app.phoneStatus(newActor)).verified,false);
   const ch1=await app.phoneChallenge(newActor);
   assert.ok(ch1.challengeId);
   for(let i=0;i<5;i++){
    await assert.rejects(app.verifyPhone(newActor,{challengeId:ch1.challengeId,code:sentSms[0].code==='000000'?'111111':'000000'}),err=>err.status===400);
   }
   // After 5 failed attempts, challenge is expired so user can request a new challenge immediately without waiting 5 minutes.
   const ch2=await app.phoneChallenge(newActor);
   assert.notEqual(ch2.challengeId,ch1.challengeId);
   const verified=await app.verifyPhone(newActor,{challengeId:ch2.challengeId,code:sentSms[1].code});
   assert.equal(verified.verified,true);
   assert.equal((await app.phoneStatus(newActor)).verified,true);
  }));
 }finally{await root.close();}
});
