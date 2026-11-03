import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {processingFeeMinor} from '../services/api/checkout-policy.mjs';
import {paystackCheckout} from '../services/api/paystack-checkout-adapter.mjs';
import {validateConfig} from '../services/api/config.mjs';

test('the customer fee leaves the full price after Paystack takes its percentage',()=>{
 for(const base of [100,1234,2000,6200,99999,1000000]){
  const fee=processingFeeMinor(base,195),total=base+fee;
  assert.ok(total-Math.ceil(total*0.0195)>=base-1,String(base));
  assert.ok(fee<=Math.ceil(base*0.0195)+2,String(base));
 }
 assert.equal(processingFeeMinor(10000,195),199);
 assert.equal(processingFeeMinor(10000,0),0);
 assert.equal(processingFeeMinor(10000,undefined),0);
});

test('the fee rate is configurable, and bad values are refused',()=>{
 assert.equal(paystackCheckout({secretKey:'sk_test_x',production:false}).processingFeeBps,195);
 assert.equal(paystackCheckout({secretKey:'sk_test_x',production:false,processingFeeBps:0}).processingFeeBps,0);
 assert.ok(validateConfig({PAYSTACK_CUSTOMER_FEE_BPS:'abc'}).errors.some(e=>e.includes('PAYSTACK_CUSTOMER_FEE_BPS')));
 assert.ok(!validateConfig({PAYSTACK_CUSTOMER_FEE_BPS:'0'}).errors.some(e=>e.includes('PAYSTACK_CUSTOMER_FEE_BPS')));
});

test('withdrawals and customer fees work against PostgreSQL',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {database}=await import('../services/api/db.mjs');
 const {migrate}=await import('../scripts/migrate.mjs');
 const {moneyOperations}=await import('../services/api/money-operations.mjs');
 const {checkoutService}=await import('../services/api/checkout.mjs');
 const {checkoutJournal,digitalDeliveryCompleted,requestCheckoutRefund}=await import('../services/api/checkout-accounting.mjs');
 const configured=new URL(process.env.TEST_DATABASE_URL);
 assert.match(configured.pathname,/^\/elesend_test/);
 const db=database(configured.toString());
 const phone=()=>'+23324'+String(randomInt(0,10000000)).padStart(7,'0');
 const policy=async()=>(await db.query('SELECT id FROM pricing_policies LIMIT 1')).rows[0].id;
 const request={vehicle:'motorcycle',pickup:{address:'A',latitude:5.5,longitude:-0.2},destination:{address:'B',latitude:5.6,longitude:-0.2},recipientPhone:'+233241234567',weightG:100,description:'Test'};
 async function user(kind){const id=randomUUID();await db.query('INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,$3,$4,now())',[id,phone(),'x',kind]);return id;}
 async function newRider(){const id=await user('rider');await db.query("INSERT INTO riders(id,vehicle,max_weight_g,status,online) VALUES($1,'motorcycle',20000,'approved',true)",[id]);await db.query('INSERT INTO commission_accounts(rider_id) VALUES($1)',[id]);return id;}
 async function shipment(customer,state='AWAITING_PAYMENT',paid=false,amount=1000){
  const quote=randomUUID(),id=randomUUID();
  await db.query("INSERT INTO quotes(id,customer_id,policy_id,request,amount_minor,commission_minor,expires_at,payment_method) VALUES($1,$2,$3,$4,$5,130,now()+interval '1 hour','MOMO')",[quote,customer,await policy(),JSON.stringify(request),amount]);
  await db.query("INSERT INTO shipments(id,customer_id,quote_id,idempotency_key,state,recipient_phone,amount_minor,commission_minor,payment_method,paid) VALUES($1,$2,$3,$4,$5,'+233241234567',$6,130,'MOMO',$7)",[id,customer,quote,randomUUID(),state,amount,paid]);
  return id;
 }
 async function completedEarning(rider,customer,amount){
  const id=await shipment(customer,'AWAITING_ASSIGNMENT',true,amount+130);
  const stop=kind=>({shipmentId:id,kind,weightG:100,latitude:5.5,longitude:-0.2});
  await db.query('INSERT INTO rider_dispatch_plans(rider_id,revision,stops) VALUES($1,1,$2) ON CONFLICT(rider_id) DO UPDATE SET stops=$2',[rider,JSON.stringify([stop('pickup'),stop('dropoff')])]);
  await db.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[id,rider]);
  const challenge=purpose=>db.query("INSERT INTO challenges(id,shipment_id,rider_id,purpose,phone,digest,expires_at,sent,consumed_at) VALUES($1,$2,$3,$4,'+233241234567','x',now()+interval '5 minutes',true,now())",[randomUUID(),id,rider,purpose]);
  await challenge('pickup');
  await db.query("UPDATE shipments SET state='PICKUP_VERIFIED' WHERE id=$1",[id]);
  await db.query("UPDATE shipments SET state='IN_TRANSIT' WHERE id=$1",[id]);
  await db.query("UPDATE shipments SET state='AWAITING_DELIVERY_OTP' WHERE id=$1",[id]);
  await challenge('delivery');
  await db.query("UPDATE shipments SET state='COMPLETED',completed_at=now() WHERE id=$1",[id]);
  await db.tx(c=>checkoutJournal(c,{shipmentId:id,eventKey:'test:'+id,kind:'delivery_completed',entries:[['customer_delivery_liability','debit',amount],['rider_payable','credit',amount]]}));
  await db.query('UPDATE rider_dispatch_plans SET stops=$2 WHERE rider_id=$1',[rider,'[]']);
  return id;
 }
 const payable=async id=>Number((await db.query("SELECT coalesce(sum(CASE WHEN l.side='credit' THEN amount_minor ELSE -amount_minor END),0)::bigint AS v FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 AND l.account='rider_payable'",[id])).rows[0].v);
 try{
  await migrate(db);
  const customer=await user('customer');
  const submitted=[];let outcome='success';
  const provider={name:'fixture',
   createPayout:async x=>{submitted.push(x);if(outcome==='uncertain')throw Error('timeout');return {providerId:'TRF_'+x.requestId};},
   verifyPayout:async x=>({verified:true,type:'payout',provider:'fixture',status:outcome==='success'?'paid':outcome==='failed'?'failed':'pending',requestId:x.requestId,providerId:'TRF_'+x.requestId,recipientReference:x.recipientReference,amountMinor:x.amountMinor,currency:x.currency,eventId:'transfer:'+randomUUID()+(outcome==='failed'?':failed':''),...(outcome==='failed'?{failureReason:'Wallet rejected'}:{})})};
  const money=moneyOperations(db,{provider,withdrawalMinMinor:500,withdrawalAutoLimitMinor:5000});
  const rider=await newRider();const actor={id:rider,kind:'rider'};
  const key=()=>randomUUID();
  await assert.rejects(money.requestWithdrawal(actor,{idempotencyKey:key()}),/payout details/);
  await db.query('INSERT INTO payout_beneficiaries(user_id,provider,recipient_reference) VALUES($1,$2,$3)',[rider,'fixture','RCP_fixture']);
  await assert.rejects(money.requestWithdrawal(actor,{idempotencyKey:key()}),/at least/);
  const first=await completedEarning(rider,customer,1200),second=await completedEarning(rider,customer,800);

  // Failure returns earnings, and a retry can then succeed.
  outcome='failed';
  const failed=await money.requestWithdrawal(actor,{idempotencyKey:key()});
  assert.equal(failed.status,'failed');
  assert.equal(await payable(first),1200);

  // Several deliveries go out as one transfer, and repeats do not pay twice.
  outcome='success';submitted.length=0;
  const idempotencyKey=key();
  const paid=await money.requestWithdrawal(actor,{idempotencyKey});
  assert.equal(paid.status,'paid');assert.equal(paid.amountMinor,2000);
  assert.equal(submitted.length,1);assert.equal(submitted[0].amountMinor,2000);
  assert.equal(await payable(first),0);assert.equal(await payable(second),0);
  assert.equal((await money.requestWithdrawal(actor,{idempotencyKey})).status,'paid');
  assert.equal(submitted.length,1);
  await assert.rejects(money.requestWithdrawal(actor,{idempotencyKey:key()}),/at least/);

  // An unclear outcome stays locked: nothing further is sent until it is checked.
  const third=await completedEarning(rider,customer,900);
  outcome='uncertain';submitted.length=0;
  const unclear=await money.requestWithdrawal(actor,{idempotencyKey:key()});
  assert.equal(unclear.status,'needs_review');assert.equal(submitted.length,1);
  await assert.rejects(money.requestWithdrawal(actor,{idempotencyKey:key()}),/in progress/);
  outcome='success';
  await money.reconcileDue({olderThanSeconds:0});
  assert.equal(await payable(third),0);
  assert.equal((await db.query("SELECT status FROM rider_withdrawals WHERE id=$1",[unclear.id])).rows[0].status,'paid');

  // Above the daily limit a finance administrator decides. Rejection frees the money.
  const big=await completedEarning(rider,customer,6000);submitted.length=0;
  const waiting=await money.requestWithdrawal(actor,{idempotencyKey:key()});
  assert.equal(waiting.status,'awaiting_approval');assert.equal(submitted.length,0);
  const finance=await user('admin');await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'finance:approve')",[finance]);
  assert.equal((await money.decideWithdrawal({id:finance,kind:'admin'},waiting.id,{decision:'reject',reason:'Unusual amount'})).status,'rejected');
  assert.equal(await payable(big),6000);
  const again=await money.requestWithdrawal(actor,{idempotencyKey:key()});
  assert.equal((await money.decideWithdrawal({id:finance,kind:'admin'},again.id,{decision:'approve',reason:'Checked with rider'})).status,'paid');
  assert.equal(await payable(big),0);

  // Customer fee: charged on top, refunded on cancellation, and the books balance.
  let verification;
  const psp={name:'feefixture',methods:['MOMO'],processingFeeBps:195,payerFields:[],allowedCheckoutHosts:['checkout.test'],
   createCheckout:async x=>({reference:x.reference,checkoutUrl:'https://checkout.test/pay'}),
   verifyPayment:async()=>verification,parseVerifiedWebhook:async()=>verification};
  await db.query("UPDATE checkout_method_policies SET enabled=true WHERE method='MOMO'");
  const checkout=checkoutService(db,{provider:psp});
  const paidOrder=await shipment(customer);
  const intent=await checkout.initiate({id:customer,kind:'customer'},paidOrder,{idempotencyKey:key()});
  assert.equal(intent.amountMinor,1020);assert.equal(intent.processingFeeMinor,20);
  verification={reference:intent.reference,status:'success',amountMinor:1020,currency:'GHS',channel:'mobile_money',eventId:'evt_'+randomUUID()};
  assert.equal((await checkout.confirmVerified(verification)).status,'confirmed');
  const balances=async id=>Object.fromEntries((await db.query("SELECT l.account,sum(CASE WHEN l.side='credit' THEN amount_minor ELSE -amount_minor END)::bigint AS v FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 GROUP BY l.account",[id])).rows.map(r=>[r.account,Number(r.v)]));
  let books=await balances(paidOrder);
  assert.equal(books.customer_delivery_liability,1000);assert.equal(books.customer_processing_fee_liability,20);assert.equal(books.provider_receivable,-1020);
  const row=(await db.query('SELECT * FROM shipments WHERE id=$1',[paidOrder])).rows[0];
  assert.equal(row.paid,true);
  await db.tx(c=>digitalDeliveryCompleted(c,{...row,rider_id:rider}));
  books=await balances(paidOrder);
  assert.equal(books.customer_delivery_liability,0);assert.equal(books.customer_processing_fee_liability,0);assert.equal(books.provider_receivable,-1000);

  const cancelled=await shipment(customer);
  const second_intent=await checkout.initiate({id:customer,kind:'customer'},cancelled,{idempotencyKey:key()});
  verification={reference:second_intent.reference,status:'success',amountMinor:1020,currency:'GHS',channel:'mobile_money',eventId:'evt_'+randomUUID()};
  await checkout.confirmVerified(verification);
  const refund=await db.tx(async c=>requestCheckoutRefund(c,(await c.query('SELECT * FROM shipments WHERE id=$1',[cancelled])).rows[0],'Customer cancelled'));
  assert.equal(refund.amountMinor,1020);
  books=await balances(cancelled);
  assert.equal(books.customer_refund_liability,1020);assert.equal(books.customer_processing_fee_liability,0);assert.equal(books.customer_delivery_liability,0);
 }finally{await db.close();}
});
