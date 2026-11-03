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
  assert.ok(fee<=Math.ceil(base*0.0199)+1,String(base));
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

test('Paystack final statuses release money, and an unknown transfer is reported as not found',async()=>{
 const id='11111111-1111-4111-8111-111111111111';
 const adapter=status=>paystackCheckout({secretKey:'sk_test_x',production:false,fetchImpl:async()=>status==='missing'
  ?{ok:false,status:404,json:async()=>({status:false})}
  :{ok:true,status:200,json:async()=>({status:true,data:{id:9,reference:'espayout-'+id,amount:500,currency:'GHS',status,recipient:'RCP_x'}})}});
 for(const status of ['failed','reversed','abandoned','blocked','rejected'])assert.equal((await adapter(status).verifyPayout({requestId:id})).status,'failed',status);
 assert.equal((await adapter('success').verifyPayout({requestId:id})).status,'paid');
 assert.equal((await adapter('otp').verifyPayout({requestId:id})).status,'pending');
 assert.equal((await adapter('missing').verifyPayout({requestId:id})).status,'not_found');
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
 const {passwordHash}=await import('../services/api/security.mjs');
 const secret=await passwordHash('Correct-pass-1');
 async function user(kind){const id=randomUUID();await db.query('INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,$3,$4,now())',[id,phone(),secret,kind]);return id;}
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
   verifyPayout:async x=>outcome==='missing'?{status:'not_found',requestId:x.requestId}:({verified:true,type:'payout',provider:'fixture',status:outcome==='success'?'paid':outcome==='failed'?'failed':'pending',requestId:x.requestId,providerId:'TRF_'+x.requestId,recipientReference:x.recipientReference,amountMinor:x.amountMinor,currency:x.currency,eventId:'transfer:'+randomUUID()+(outcome==='failed'?':failed':''),...(outcome==='failed'?{failureReason:'Wallet rejected'}:{})})};
  const limits={provider,withdrawalMinMinor:500,withdrawalFeeMinor:0,earningsHoldHours:0};
  const money=moneyOperations(db,limits);
  const rider=await newRider();const actor={id:rider,kind:'rider'};
  const key=()=>randomUUID();
  // Moves today's withdrawals to a date no earlier call has used, as one person can hold one per day.
  let daysBack=0;
  const nextDay=()=>db.query("UPDATE payout_withdrawals SET created_at=created_at-make_interval(days=>$1) WHERE (created_at AT TIME ZONE 'UTC')::date=(now() AT TIME ZONE 'UTC')::date",[++daysBack]);
  const withdraw=(idempotencyKey,who=actor,service=money,password='Correct-pass-1')=>service.requestWithdrawal(who,{idempotencyKey,password});
  await assert.rejects(withdraw(key(),actor,money,'wrong-password'),/Incorrect password/);
  await assert.rejects(withdraw(key()),/payout details/);
  await db.query('INSERT INTO payout_beneficiaries(user_id,provider,recipient_reference) VALUES($1,$2,$3)',[rider,'fixture','RCP_fixture']);
  await assert.rejects(withdraw(key()),/at least/);
  const first=await completedEarning(rider,customer,1200),second=await completedEarning(rider,customer,800);

  // Failure returns earnings, and a retry can then succeed.
  outcome='failed';
  const failed=await withdraw(key());
  assert.equal(failed.status,'failed');
  assert.equal(await payable(first),1200);

  // Several deliveries go out as one transfer, and repeats do not pay twice.
  outcome='success';submitted.length=0;
  const idempotencyKey=key();
  const paid=await withdraw(idempotencyKey);
  assert.equal(paid.status,'paid');assert.equal(paid.amountMinor,2000);
  assert.equal(submitted.length,1);assert.equal(submitted[0].amountMinor,2000);
  assert.equal(await payable(first),0);assert.equal(await payable(second),0);
  assert.equal((await withdraw(idempotencyKey)).status,'paid');
  assert.equal(submitted.length,1);
  await assert.rejects(withdraw(key()),/once a day/);
  await nextDay();

  // An unclear outcome stays locked: nothing further is sent until it is checked.
  const third=await completedEarning(rider,customer,900);
  outcome='uncertain';submitted.length=0;
  const unclear=await withdraw(key());
  assert.equal(unclear.status,'needs_review');assert.equal(submitted.length,1);
  await assert.rejects(withdraw(key()),/in progress/);
  outcome='success';
  await money.reconcileDue({olderThanSeconds:0});
  assert.equal(await payable(third),0);
  assert.equal((await db.query("SELECT status FROM payout_withdrawals WHERE id=$1",[unclear.id])).rows[0].status,'paid');

  await nextDay();
  // The provider has no transfer: the same reference is resent, so it cannot pay twice.
  const missing=await completedEarning(rider,customer,700);
  outcome='missing';submitted.length=0;
  const lost=await withdraw(key());
  assert.equal(submitted.length,1);
  await db.query("UPDATE payout_withdrawals SET updated_at=now()-interval '10 minutes',last_reconciled_at=now()-interval '10 minutes' WHERE id=$1",[lost.id]);
  await money.reconcileDue({olderThanSeconds:0});
  assert.equal(submitted.length,2);assert.equal(submitted[0].requestId,submitted[1].requestId);
  // After a day with no transfer at Paystack, the money comes back by itself.
  await db.query("UPDATE payout_withdrawals SET created_at=now()-interval '30 days',last_reconciled_at=now()-interval '10 minutes' WHERE id=$1",[lost.id]);
  await money.reconcileDue({olderThanSeconds:0});
  assert.equal((await db.query('SELECT status FROM payout_withdrawals WHERE id=$1',[lost.id])).rows[0].status,'failed');
  assert.equal(await payable(missing),700);
  outcome='success';
  await db.query("UPDATE payout_operations SET created_at=now() WHERE withdrawal_id=$1",[lost.id]);

  // A reversal after success puts the money back on the ledger, exactly once.
  const backAgain=await withdraw(key());
  assert.equal(backAgain.status,'paid');assert.equal(await payable(missing),0);
  const reversal={verified:true,type:'payout',provider:'fixture',status:'failed',reversed:true,requestId:backAgain.id,providerId:'TRF_'+backAgain.id,recipientReference:'RCP_fixture',amountMinor:700,currency:'GHS',eventId:'transfer:'+randomUUID()+':reversed',failureReason:'Wallet could not accept funds'};
  assert.equal((await money.reverseWithdrawal(reversal)).status,'reversed');
  assert.equal((await money.reverseWithdrawal(reversal)).duplicate,true);
  assert.equal(await payable(missing),700);

  // Terms cannot be edited, and records cannot be removed.
  await assert.rejects(db.query('UPDATE payout_withdrawals SET amount_minor=1 WHERE id=$1',[backAgain.id]),/immutable/);
  await assert.rejects(db.query("UPDATE payout_withdrawals SET recipient_reference='RCP_attacker' WHERE id=$1",[backAgain.id]),/immutable/);
  await assert.rejects(db.query("UPDATE payout_withdrawals SET status='paid' WHERE id=$1",[backAgain.id]),/finished/);
  await assert.rejects(db.query('DELETE FROM payout_withdrawals WHERE id=$1',[backAgain.id]),/permanent/);

  // There is no amount limit. The fee comes out of the transfer, and the ledger still balances.
  const second_rider=await newRider(),other={id:second_rider,kind:'rider'};
  await db.query('INSERT INTO payout_beneficiaries(user_id,provider,recipient_reference) VALUES($1,$2,$3)',[second_rider,'fixture','RCP_second']);
  const a1=await completedEarning(second_rider,customer,300000),a2=await completedEarning(second_rider,customer,300000);
  submitted.length=0;
  const charged=await withdraw(key(),other,moneyOperations(db,{...limits,withdrawalFeeMinor:100}));
  assert.equal(charged.status,'paid');assert.equal(charged.amountMinor,599900);
  assert.equal(submitted[0].amountMinor,599900);
  assert.equal((await payable(a1))+(await payable(a2)),0);
  await assert.rejects(withdraw(key(),other),/once a day/);
  await assert.rejects(db.query("INSERT INTO payout_withdrawals(id,beneficiary_id,idempotency_key,provider,recipient_reference,amount_minor) VALUES($1,$2,$3,'fixture','RCP_second',100)",[randomUUID(),second_rider,key()]),/payout_withdrawals_once_a_day/);
  await assert.rejects(db.query('UPDATE payout_withdrawals SET fee_minor=0 WHERE id=$1',[charged.id]),/immutable/);

  // The platform ceiling and earnings hold both keep money in the balance.
  const third_rider=await newRider(),third_actor={id:third_rider,kind:'rider'};
  await db.query('INSERT INTO payout_beneficiaries(user_id,provider,recipient_reference) VALUES($1,$2,$3)',[third_rider,'fixture','RCP_third']);
  const held=await completedEarning(third_rider,customer,1000);
  await assert.rejects(withdraw(key(),third_actor,moneyOperations(db,{...limits,platformDailyLimitMinor:1})),/paused/);
  await assert.rejects(withdraw(key(),third_actor,moneyOperations(db,{...limits,earningsHoldHours:1})),/at least/);

  // Open disputes, password changes and payout detail changes all block withdrawal.
  const dispute=randomUUID();
  await db.query("INSERT INTO disputes(id,shipment_id,reporter_id,category,detail) VALUES($1,$2,$3,'other','Test dispute')",[dispute,held,customer]);
  await assert.rejects(withdraw(key(),third_actor),/at least/);
  await db.query("UPDATE disputes SET status='dismissed' WHERE id=$1",[dispute]);
  await db.query("UPDATE users SET password_hash=password_hash||'' WHERE id=$1",[third_rider]);
  assert.equal((await db.query('SELECT credentials_changed_at FROM users WHERE id=$1',[third_rider])).rows[0].credentials_changed_at,null);
  const changed=await passwordHash('Correct-pass-1');
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1',[third_rider,changed]);
  await assert.rejects(withdraw(key(),third_actor),/password change/);
  await db.query('UPDATE users SET credentials_changed_at=NULL WHERE id=$1',[third_rider]);
  await db.query("UPDATE payout_beneficiaries SET destination_changed_at=now() WHERE user_id=$1",[third_rider]);
  await assert.rejects(withdraw(key(),third_actor),/payout details change/);
  await db.query('UPDATE payout_beneficiaries SET destination_changed_at=NULL WHERE user_id=$1',[third_rider]);

  // A destination that no longer matches the verified phone is refused before any money moves.
  submitted.length=0;
  const tampered=await withdraw(key(),third_actor,moneyOperations(db,{...limits,provider:{...provider,verifyBeneficiary:async()=>({verified:false})}}));
  assert.equal(tampered.status,'failed');assert.equal(submitted.length,0);assert.equal(await payable(held),1000);

  // Delivery companies are paid automatically, once a day, with no staff step.
  const owner=await user('company'),companyId=randomUUID();
  await db.query("INSERT INTO companies(id,owner_id,name,status) VALUES($1,$2,'Fleet Co','approved')",[companyId,owner]);
  await db.query('INSERT INTO payout_beneficiaries(user_id,provider,recipient_reference) VALUES($1,$2,$3)',[owner,'fixture','RCP_fleet']);
  const fleetRider=await newRider();
  const fleet=await completedEarning(fleetRider,customer,2500);
  await db.query('UPDATE shipments SET company_id=$2 WHERE id=$1',[fleet,companyId]);
  // Cash commission on a company job is the company's debt, never the rider's, and earnings repay it.
  const {settleCompletedDelivery,debtState}=await import('../services/api/rider-wallet.mjs');
  const {companyDebtMinor}=await import('../services/api/company-commission.mjs');
  const {cashEligible}=await import('../services/api/finance.mjs');
  await db.query('UPDATE riders SET company_id=$2 WHERE id=$1',[fleetRider,companyId]);
  const cashJob=await completedEarning(fleetRider,customer,1);
  await db.query('UPDATE shipments SET company_id=$2 WHERE id=$1',[cashJob,companyId]);
  await db.tx(c=>settleCompletedDelivery(c,{id:cashJob,rider_id:fleetRider,company_id:companyId,payment_method:'CASH',commission_minor:500}));
  assert.equal((await db.tx(c=>debtState(c,fleetRider))).debtMinor,0);
  assert.equal(await db.tx(c=>companyDebtMinor(c,companyId)),0);
  const ceiling=process.env.COMPANY_COMMISSION_DEBT_LIMIT_MINOR;
  process.env.COMPANY_COMMISSION_DEBT_LIMIT_MINOR='5';
  await assert.rejects(db.tx(c=>cashEligible(c,fleetRider,10)),/company commission limit/);
  if(ceiling===undefined)delete process.env.COMPANY_COMMISSION_DEBT_LIMIT_MINOR;else process.env.COMPANY_COMMISSION_DEBT_LIMIT_MINOR=ceiling;
  const swept=await money.settleBusinessesDue();
  assert.ok(swept.some(r=>r.status==='paid'&&r.amountMinor===2001),JSON.stringify(swept));
  assert.equal(await payable(fleet),0);
  submitted.length=0;
  await money.settleBusinessesDue();
  assert.ok(!submitted.some(x=>x.recipientReference==='RCP_fleet'));

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
