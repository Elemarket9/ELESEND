import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {processingFeeMinor} from '../services/api/modules/payments/checkout-policy.mjs';
import {paystackCheckout} from '../services/api/modules/payments/paystack-checkout-adapter.mjs';
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
 const {moneyOperations}=await import('../services/api/modules/payments/money-operations.mjs');
 const {checkoutService}=await import('../services/api/modules/payments/checkout.mjs');
 const {checkoutJournal,digitalDeliveryCompleted,requestCheckoutRefund}=await import('../services/api/modules/payments/checkout-accounting.mjs');
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
  // Not found never releases money by itself, however long it takes.
  await db.query("UPDATE payout_withdrawals SET created_at=now()-interval '30 days',updated_at=now()-interval '10 minutes',last_reconciled_at=now()-interval '10 minutes' WHERE id=$1",[lost.id]);
  await money.reconcileDue({olderThanSeconds:0});
  const lostRow=(await db.query('SELECT * FROM payout_withdrawals WHERE id=$1',[lost.id])).rows[0];
  assert.ok(['initiating','pending','needs_review'].includes(lostRow.status));assert.ok(lostRow.stuck_flagged_at);
  await assert.rejects(withdraw(key()),/in progress/);
  // Finance can release it only with the provider still reporting no transfer.
  const releaser=await user('admin');await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'finance:approve')",[releaser]);
  await assert.rejects(money.releaseUnsentWithdrawal({id:customer,kind:'customer'},lost.id,{reason:'Not allowed to do this'}));
  outcome='pending';
  await assert.rejects(money.releaseUnsentWithdrawal({id:releaser,kind:'admin'},lost.id,{reason:'Checked the Paystack dashboard'}),/record of this transfer/);
  outcome='missing';
  assert.equal((await money.releaseUnsentWithdrawal({id:releaser,kind:'admin'},lost.id,{reason:'Checked the Paystack dashboard'})).status,'failed');
  assert.equal(await payable(missing),700);
  // If the provider pays it late anyway, the account goes on hold before the money can leave twice.
  const late=await money.confirmPayout({verified:true,type:'payout',provider:'fixture',status:'paid',requestId:lost.id,providerId:'TRF_'+lost.id,recipientReference:lostRow.recipient_reference,amountMinor:Number(lostRow.amount_minor),currency:'GHS',eventId:'transfer:'+randomUUID()});
  assert.equal(late.status,'paid_after_release');
  await assert.rejects(withdraw(key()),/on hold/);
  await db.query('DELETE FROM payout_holds WHERE user_id=$1',[rider]);
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
  // The wallet's withdrawable figure and the actual withdrawal agree.
  const {walletSummary}=await import('../services/api/modules/payments/rider-wallet.mjs');
  process.env.WITHDRAWAL_EARNINGS_HOLD_HOURS='0';
  assert.equal((await walletSummary(db,other)).availableNowMinor,600000);
  process.env.WITHDRAWAL_EARNINGS_HOLD_HOURS='24';
  const heldSummary=await walletSummary(db,other);
  assert.equal(heldSummary.availableNowMinor,0);assert.equal(heldSummary.onHoldMinor,600000);
  delete process.env.WITHDRAWAL_EARNINGS_HOLD_HOURS;
  submitted.length=0;
  const charged=await withdraw(key(),other,moneyOperations(db,{...limits,withdrawalFeeMinor:100}));
  assert.equal(charged.status,'paid');assert.equal(charged.amountMinor,599900);
  assert.equal(submitted[0].amountMinor,599900);
  assert.equal((await payable(a1))+(await payable(a2)),0);
  await assert.rejects(withdraw(key(),other),/once a day/);
  // The wallet shows the rider each withdrawal and a statement, and no one else's.
  const {walletWithdrawals,walletStatement}=await import('../services/api/modules/payments/rider-wallet.mjs');
  const walletView=await walletWithdrawals(db,other);
  assert.equal(walletView.onHold,false);
  assert.equal(walletView.withdrawals[0].earnedMinor,600000);assert.equal(walletView.withdrawals[0].feeMinor,100);assert.equal(walletView.withdrawals[0].sentMinor,599900);assert.equal(walletView.withdrawals[0].deliveries,2);
  assert.match(walletView.withdrawals[0].transferCode,/^TRF_/);
  const walletPaper=await walletStatement(db,other);
  assert.equal(walletPaper.deliveries,2);assert.equal(walletPaper.withdrawals,1);
  assert.match(walletPaper.csv,/^Type,Date,Reference/);assert.match(walletPaper.csv,/Withdrawal,.*TRF_.*,paid,Mobile Money,,1\.00,5999\.00/);
  const afterPaid=await walletSummary(db,other);
  assert.equal(afterPaid.availableNowMinor,0);assert.equal(afterPaid.inPayoutMinor,0);assert.equal(afterPaid.availableEarningsMinor,0);
  await assert.rejects(walletStatement(db,other,{from:'2020-01-01',to:'2026-01-01'}),/up to 92 days/);
  await assert.rejects(walletWithdrawals(db,{id:customer,kind:'customer'}),/Rider account/);
  await assert.rejects(db.query("INSERT INTO payout_withdrawals(id,beneficiary_id,idempotency_key,provider,recipient_reference,amount_minor) VALUES($1,$2,$3,'fixture','RCP_second',100)",[randomUUID(),second_rider,key()]),/payout_withdrawals_once_a_day/);
  await assert.rejects(db.query('UPDATE payout_withdrawals SET fee_minor=0 WHERE id=$1',[charged.id]),/immutable/);

  // The platform ceiling and earnings hold both keep money in the balance.
  const third_rider=await newRider(),third_actor={id:third_rider,kind:'rider'};
  await db.query('INSERT INTO payout_beneficiaries(user_id,provider,recipient_reference) VALUES($1,$2,$3)',[third_rider,'fixture','RCP_third']);
  const held=await completedEarning(third_rider,customer,1000);
  await assert.rejects(withdraw(key(),third_actor,moneyOperations(db,{...limits,platformDailyLimitMinor:1})),/paused/);
  await assert.rejects(withdraw(key(),third_actor,moneyOperations(db,{...limits,earningsHoldHours:1})),/at least/);

  // Password changes and payout detail changes block withdrawal.
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
  const {settleCompletedDelivery,debtState}=await import('../services/api/modules/payments/rider-wallet.mjs');
  const {companyDebtMinor}=await import('../services/api/modules/payments/company-commission.mjs');
  const {cashEligible}=await import('../services/api/modules/payments/finance.mjs');
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
  // A failed parcel is paid by the sender once it is back with them, proved by their SMS code.
  const {platform}=await import('../services/api/platform.mjs');
  const outbox=[];
  const app=platform(db,{otpKey:'a'.repeat(64),sms:{send:async x=>{outbox.push(x);}}});
  const returnRider=await newRider(),returning={id:returnRider,kind:'rider'};
  const failed_parcel=await shipment(customer);
  const parcelIntent=await checkout.initiate({id:customer,kind:'customer'},failed_parcel,{idempotencyKey:key()});
  verification={reference:parcelIntent.reference,status:'success',amountMinor:1020,currency:'GHS',channel:'mobile_money',eventId:'evt_'+randomUUID()};
  await checkout.confirmVerified(verification);
  const stop=kind=>({shipmentId:failed_parcel,kind,weightG:100,latitude:5.5,longitude:-0.2});
  await db.query('INSERT INTO rider_dispatch_plans(rider_id,revision,stops) VALUES($1,1,$2)',[returnRider,JSON.stringify([stop('pickup'),stop('dropoff')])]);
  await db.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[failed_parcel,returnRider]);
  await db.query("INSERT INTO challenges(id,shipment_id,rider_id,purpose,phone,digest,expires_at,sent,consumed_at) VALUES($1,$2,$3,'pickup','+233241234567','x',now()+interval '5 minutes',true,now())",[randomUUID(),failed_parcel,returnRider]);
  await db.query("UPDATE shipments SET state='PICKUP_VERIFIED' WHERE id=$1",[failed_parcel]);
  await app.transition(returning,failed_parcel,{action:'fail',reason:'Recipient unreachable'});
  await app.transition(returning,failed_parcel,{action:'return',reason:'Returning to sender'});
  await assert.rejects(app.transition(returning,failed_parcel,{action:'returned',reason:'Rider alone says so'}),/SMS code/);
  await assert.rejects(app.dispute({id:customer,kind:'customer'},failed_parcel,{category:'lost',detail:'Please refund this order',requestedRefundMinor:1000}),/not refunded/);
  const returnChallenge=await app.challenge(returning,failed_parcel,'return');
  assert.equal(outbox.at(-1).phone,(await db.query('SELECT phone FROM users WHERE id=$1',[customer])).rows[0].phone);
  await app.verify(returning,failed_parcel,{challengeId:returnChallenge.challengeId,code:outbox.at(-1).code});
  assert.equal((await db.query('SELECT state FROM shipments WHERE id=$1',[failed_parcel])).rows[0].state,'RETURNED');
  assert.equal(await payable(failed_parcel),870);
  assert.equal((await db.query('SELECT 1 FROM checkout_refund_requests WHERE shipment_id=$1',[failed_parcel])).rowCount,0);
  const returnedBooks=await balances(failed_parcel);
  assert.equal(returnedBooks.customer_delivery_liability,0);assert.equal(returnedBooks.customer_processing_fee_liability,0);
  // A parcel kept past the limit suspends the rider, blocks withdrawal and freezes the evidence.
  const {flagOverdueParcels,listCustodyIncidents,resolveCustodyIncident}=await import('../services/api/custody-incidents.mjs');
  const runner=await newRider();
  await db.query('INSERT INTO payout_beneficiaries(user_id,provider,recipient_reference) VALUES($1,$2,$3)',[runner,'fixture','RCP_runner']);
  const stolen=await shipment(customer,'AWAITING_ASSIGNMENT',true);
  await db.query('INSERT INTO rider_dispatch_plans(rider_id,revision,stops) VALUES($1,1,$2)',[runner,JSON.stringify([{shipmentId:stolen,kind:'pickup',weightG:100,latitude:5.5,longitude:-0.2},{shipmentId:stolen,kind:'dropoff',weightG:100,latitude:5.5,longitude:-0.2}])]);
  await db.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[stolen,runner]);
  const pickupCode=randomUUID();
  await db.query("INSERT INTO challenges(id,shipment_id,rider_id,purpose,phone,digest,expires_at,sent,consumed_at) VALUES($1,$2,$3,'pickup','+233241234567','x',now()+interval '5 minutes',true,now())",[pickupCode,stolen,runner]);
  await db.query("UPDATE shipments SET state='PICKUP_VERIFIED' WHERE id=$1",[stolen]);
  assert.equal((await flagOverdueParcels(db)).length,0);
  await db.query("UPDATE challenges SET consumed_at=now()-interval '25 hours' WHERE id=$1",[pickupCode]);
  assert.equal((await flagOverdueParcels(db)).length,1);
  assert.equal((await flagOverdueParcels(db)).length,0);
  assert.equal((await db.query('SELECT status FROM riders WHERE id=$1',[runner])).rows[0].status,'suspended');
  await assert.rejects(withdraw(key(),{id:runner,kind:'rider'}),/unavailable/);
  const investigator=await user('admin');
  await assert.rejects(listCustodyIncidents(db,{id:investigator,kind:'admin'}),/Permission/);
  await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'verification:write')",[investigator]);
  const incident=(await listCustodyIncidents(db,{id:investigator,kind:'admin'})).find(i=>i.shipment_id===stolen);
  assert.equal(incident.evidence.rider_id,runner);assert.ok(incident.evidence.sender_phone);assert.ok(incident.evidence.picked_up_at);
  await assert.rejects(db.query("UPDATE parcel_custody_incidents SET evidence='{}' WHERE id=$1",[incident.id]),/immutable/);
  await assert.rejects(app.transition({id:investigator,kind:'admin'},stolen,{action:'fail',reason:'Admin should not change this'}),/Assigned rider/);
  assert.equal((await resolveCustodyIncident(db,{id:investigator,kind:'admin'},incident.id,{outcome:'police_reported',reason:'Rider unreachable for a day',policeReference:'ACC-123'})).police_reference,'ACC-123');
  // No rider is approved without a current licence, and one licence cannot back two accounts.
  // The rider data key works with nothing extra set, using the required admin key.
  delete process.env.RIDER_ID_ENCRYPTION_KEY;
  process.env.ADMIN_MFA_ENCRYPTION_KEY=process.env.ADMIN_MFA_ENCRYPTION_KEY||'b'.repeat(64);
  const {submitRiderLicence,riderLicenceStatus,rejectRiderLicence,suspendExpiredLicences,attachLicences}=await import('../services/api/rider-licence.mjs');
  const applicant=await newRider(),other_applicant=await newRider();
  await db.query("UPDATE riders SET status='pending' WHERE id=ANY($1::uuid[])",[[applicant,other_applicant]]);
  const reviewer={id:investigator,kind:'admin'},applicantActor={id:applicant,kind:'rider'};
  await assert.rejects(app.approve(reviewer,'riders',applicant,'approved'),/not submitted a licence/);
  const nextYear=`${new Date().getUTCFullYear()+1}-01-31`;
  const licenceForm={legalName:'Kofi Mensah',ghanaCardNumber:'GHA-123456789-0',licenceNumber:'GH-12345678',licenceClass:'A',expiresOn:nextYear,vehiclePlate:'GR 1234-26'};
  // Independent riders need a Ghana Card in the right format, and one card cannot back two accounts.
  await assert.rejects(submitRiderLicence(db,applicantActor,{...licenceForm,ghanaCardNumber:undefined}));
  await assert.rejects(submitRiderLicence(db,applicantActor,{...licenceForm,ghanaCardNumber:'123456789'}),/Ghana Card number/);
  await assert.rejects(submitRiderLicence(db,applicantActor,{...licenceForm,expiresOn:'2020-01-01'}),/expired/);
  await assert.rejects(submitRiderLicence(db,applicantActor,{...licenceForm,vehiclePlate:undefined}),/plate/);
  assert.equal((await submitRiderLicence(db,applicantActor,licenceForm)).status,'pending');
  await assert.rejects(submitRiderLicence(db,{id:other_applicant,kind:'rider'},{...licenceForm,licenceNumber:'gh 12345678',ghanaCardNumber:'GHA-111111111-1'}),/another rider/);
  await assert.rejects(submitRiderLicence(db,{id:other_applicant,kind:'rider'},{...licenceForm,licenceNumber:'GH-55555555',ghanaCardNumber:'gha 123456789 0'}),/Ghana Card is already linked/);
  const stored=(await db.query('SELECT number_encrypted FROM rider_licences WHERE rider_id=$1',[applicant])).rows[0];
  assert.ok(!stored.number_encrypted.includes('12345678'));
  const shown=await attachLicences(db,reviewer,[{id:applicant}]);
  assert.equal(shown[0].licence.number,'GH-12345678');assert.equal(shown[0].licence.number_encrypted,undefined);
  assert.equal(shown[0].licence.ghanaCard,'GHA-123456789-0');assert.equal(shown[0].licence.ghana_card_encrypted,undefined);
  assert.ok(!(await db.query('SELECT ghana_card_encrypted FROM rider_licences WHERE rider_id=$1',[applicant])).rows[0].ghana_card_encrypted.includes('123456789'));
  assert.equal((await rejectRiderLicence(db,reviewer,applicant,{reason:'Number is not readable'})).status,'rejected');
  await assert.rejects(app.approve(reviewer,'riders',applicant,'approved'),/rejected/);
  await submitRiderLicence(db,applicantActor,licenceForm);
  // Profile photo and vehicle certificates are required too, through a short-lived link.
  const {createDocumentUploadLink,uploadRiderDocument,riderDocumentStatus,viewRiderDocument,rejectRiderDocument,suspendExpiredDocuments}=await import('../services/api/rider-documents.mjs');
  const jpeg=Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.alloc(200,7)]).toString('base64');
  const uploadAll=async rider=>{
   const token=(await createDocumentUploadLink(db,{id:rider,kind:'rider'})).path.split('#')[1];
   await uploadRiderDocument(db,{token,kind:'profile_photo',imageBase64:jpeg});
   await uploadRiderDocument(db,{token,kind:'licence_photo',imageBase64:jpeg});
   await uploadRiderDocument(db,{token,kind:'ghana_card_photo',imageBase64:jpeg});
   await uploadRiderDocument(db,{token,kind:'insurance',imageBase64:jpeg,expiresOn:nextYear});
   await uploadRiderDocument(db,{token,kind:'roadworthiness',imageBase64:jpeg,expiresOn:nextYear});
   return token;
  };
  await assert.rejects(app.approve(reviewer,'riders',applicant,'approved'),/not uploaded their profile photo/);
  const uploadToken=(await createDocumentUploadLink(db,applicantActor)).path.split('#')[1];
  await assert.rejects(uploadRiderDocument(db,{token:'0'.repeat(64),kind:'profile_photo',imageBase64:jpeg}),/expired/);
  await assert.rejects(uploadRiderDocument(db,{token:uploadToken,kind:'profile_photo',imageBase64:Buffer.alloc(200,65).toString('base64')}),/upload a photo/);
  await assert.rejects(uploadRiderDocument(db,{token:uploadToken,kind:'insurance',imageBase64:jpeg,expiresOn:'2020-01-01'}),/expiry/);
  await uploadAll(applicant);
  assert.deepEqual((await riderDocumentStatus(db,applicantActor)).documents.map(d=>d.kind),['profile_photo','licence_photo','ghana_card_photo','insurance','roadworthiness']);
  assert.ok(!(await db.query("SELECT data_encrypted FROM rider_documents WHERE rider_id=$1 AND kind='insurance'",[applicant])).rows[0].data_encrypted.includes(jpeg.slice(0,40)));
  assert.equal((await viewRiderDocument(db,reviewer,applicant,'insurance')).imageBase64,jpeg);
  await assert.rejects(viewRiderDocument(db,{id:customer,kind:'customer'},applicant,'insurance'),/Permission/);
  await rejectRiderDocument(db,reviewer,applicant,'insurance',{reason:'Certificate is not readable'});
  await assert.rejects(app.approve(reviewer,'riders',applicant,'approved'),/insurance was rejected/);
  await uploadAll(applicant);
  await app.approve(reviewer,'riders',applicant,'approved');
  // One approval covers the vehicle, and the plate is stored only in the vehicle record.
  const vehicleRow=(await db.query('SELECT registration_plate,verification_status FROM rider_vehicle_registrations WHERE rider_id=$1',[applicant])).rows[0];
  assert.equal(vehicleRow.registration_plate,'GR 1234-26');assert.equal(vehicleRow.verification_status,'approved');
  await db.query("UPDATE rider_documents SET valid_until=now()::date-1 WHERE rider_id=$1 AND kind='insurance'",[applicant]);
  const docExpired=await suspendExpiredDocuments(db);
  assert.ok(docExpired.includes(applicant));
  await db.query("UPDATE rider_documents SET valid_until=$2 WHERE rider_id=$1",[applicant,nextYear]);
  await db.query("UPDATE riders SET status='pending' WHERE id=$1",[applicant]);
  await app.approve(reviewer,'riders',applicant,'approved');
  assert.equal((await db.query('SELECT status FROM riders WHERE id=$1',[applicant])).rows[0].status,'approved');
  assert.equal((await riderLicenceStatus(db,applicantActor)).validUntil,nextYear);
  await db.query("UPDATE rider_licences SET valid_until=now()::date-1 WHERE rider_id=$1",[applicant]);
  assert.ok((await suspendExpiredLicences(db)).includes(applicant));
  assert.equal((await db.query('SELECT status FROM riders WHERE id=$1',[applicant])).rows[0].status,'suspended');

  // Once identity checks are on, approval needs a passed photo and selfie check that matches the details.
  const {startIdentityCheck,syncIdentityCheck,identityWebhook}=await import('../services/api/rider-licence.mjs');
  const {diditProvider}=await import('../services/api/identity-verification.mjs');
  const {createHmac}=await import('node:crypto');
  const sessionId=randomUUID(),selfie=await newRider();
  await db.query("UPDATE riders SET status='pending' WHERE id=$1",[selfie]);
  let decisionBody;
  const didit=diditProvider({apiKey:'k',workflowId:'w',webhookSecret:'whsec',fetchImpl:async(url,options)=>({ok:true,status:200,json:async()=>options.method==='POST'?{session_id:sessionId,url:'https://verify.didit.me/session/x'}:decisionBody})});
  const decisionOf=(number,over={})=>({session_id:sessionId,vendor_data:selfie,status:'Approved',id_verifications:[{status:'Approved',document_type:"Driver's License",document_number:number,expiration_date:nextYear}],liveness_checks:[{status:'Approved'}],face_matches:[{status:'Approved'}],...over});
  await submitRiderLicence(db,{id:selfie,kind:'rider'},{...licenceForm,licenceNumber:'GH-99999999',ghanaCardNumber:'GHA-999999999-9'});
  for(const [k,v] of [['DIDIT_API_KEY','k'],['DIDIT_WORKFLOW_ID','w'],['DIDIT_WEBHOOK_SECRET','whsec']])process.env[k]=v;
  try{
   await assert.rejects(app.approve(reviewer,'riders',selfie,'approved'),/photo and selfie/);
   assert.match((await startIdentityCheck(db,{id:selfie,kind:'rider'},{provider:didit})).url,/^https:/);
   decisionBody=decisionOf('GH-00000000');
   assert.equal((await syncIdentityCheck(db,selfie,{provider:didit})).status,'failed');
   await startIdentityCheck(db,{id:selfie,kind:'rider'},{provider:didit});
   decisionBody=decisionOf('GH 99999999',{face_matches:[{status:'Declined'}]});
   assert.equal((await syncIdentityCheck(db,selfie,{provider:didit})).status,'failed');
   await startIdentityCheck(db,{id:selfie,kind:'rider'},{provider:didit});
   await uploadAll(selfie);
   decisionBody=decisionOf('GH 99999999');
   const raw=Buffer.from(JSON.stringify({session_id:sessionId,status:'Approved'}));
   const stamp=String(Math.floor(Date.now()/1000));
   await assert.rejects(identityWebhook(db,raw,{'x-timestamp':stamp,'x-signature':'0'.repeat(64)},{provider:didit}),/signature/);
   await assert.rejects(identityWebhook(db,raw,{'x-timestamp':'1','x-signature':createHmac('sha256','whsec').update(raw).digest('hex')},{provider:didit}),/Stale/);
   await identityWebhook(db,raw,{'x-timestamp':stamp,'x-signature':createHmac('sha256','whsec').update(raw).digest('hex')},{provider:didit});
   await app.approve(reviewer,'riders',selfie,'approved');
   assert.equal((await db.query('SELECT status FROM riders WHERE id=$1',[selfie])).rows[0].status,'approved');
  }finally{for(const k of ['DIDIT_API_KEY','DIDIT_WORKFLOW_ID','DIDIT_WEBHOOK_SECRET'])delete process.env[k];}
  // Emergency alerts reach the duty phone and trusted contact, and repeat presses do not spam them.
  const {raiseEmergency,saveTrustedContact,listSafetyAlerts,resolveSafetyAlert,createShareLink,rateDelivery,myRating,pendingRatings}=await import('../services/api/safety.mjs');
  const tools=await import('../services/api/rider-tools.mjs');
  const safetyRider=await newRider(),safetyActor={id:safetyRider,kind:'rider'},customerActor={id:customer,kind:'customer'};
  const texts=[];
  const smsFake={sendNotification:async x=>{texts.push(x);return {sent:true};}};
  await saveTrustedContact(db,safetyActor,{name:'Ama',phone:'0241112222'});
  // With no SMS or duty phone the alert still saves for staff.
  const quiet=await raiseEmergency(db,{id:await user('customer'),kind:'customer'},{},{sms:null,dutyPhone:''});
  assert.equal(quiet.notified,0);assert.equal(quiet.emergencyNumber,'112');
  const alert=await raiseEmergency(db,safetyActor,{latitude:5.6,longitude:-0.2},{sms:smsFake,dutyPhone:'+233201234567'});
  assert.equal(alert.notified,2);assert.equal(texts.length,2);assert.match(texts[0].message,/maps\.google/);
  assert.equal((await raiseEmergency(db,safetyActor,{},{sms:smsFake,dutyPhone:'+233201234567'})).duplicate,true);assert.equal(texts.length,2);
  await assert.rejects(raiseEmergency(db,{id:await user('customer'),kind:'customer'},{shipmentId:held},{sms:smsFake}),/not yours/);
  // An unconfirmed number cannot name a trusted contact, and one contact number gets at most three alerts a day.
  const unverified=await user('customer');await db.query('UPDATE users SET phone_verified_at=NULL WHERE id=$1',[unverified]);
  await assert.rejects(saveTrustedContact(db,{id:unverified,kind:'customer'},{name:'Kofi',phone:'0241113333'}),/Verify your phone/);
  const sent=[];const counting={sendNotification:async x=>{sent.push(x);return {sent:true};}};
  for(let i=0;i<5;i++){const a=await user('customer');await saveTrustedContact(db,{id:a,kind:'customer'},{name:'Target',phone:'0241114444'});await raiseEmergency(db,{id:a,kind:'customer'},{},{sms:counting,dutyPhone:'+233201234567'});}
  assert.equal(sent.filter(x=>x.phone==='+233241114444').length,3,'the contact number is capped');
  assert.equal(sent.filter(x=>x.phone==='+233201234567').length,5,'the duty phone always hears');
  // A contact the person has had for days always gets the alert, even after strangers used up the daily allowance.
  const longTime=await user('customer');await saveTrustedContact(db,{id:longTime,kind:'customer'},{name:'Mum',phone:'0241114444'});
  await db.query("UPDATE trusted_contacts SET updated_at=now()-interval '10 days' WHERE user_id=$1",[longTime]);
  await saveTrustedContact(db,{id:longTime,kind:'customer'},{name:'Mother',phone:'0241114444'});
  await raiseEmergency(db,{id:longTime,kind:'customer'},{},{sms:counting,dutyPhone:'+233201234567'});
  assert.equal(sent.filter(x=>x.phone==='+233241114444').length,4,'the real emergency still reaches the established contact');
  const investigatorActor={id:investigator,kind:'admin'};
  assert.ok((await listSafetyAlerts(db,investigatorActor)).some(a=>a.id===alert.id));
  await assert.rejects(listSafetyAlerts(db,customerActor),/Permission/);
  assert.equal((await resolveSafetyAlert(db,investigatorActor,alert.id,{note:'Called the rider, all safe'})).status,'resolved');

  // Ratings work both ways, once, and only after the delivery ends. Poor averages go to staff.
  const rated=await completedEarning(safetyRider,customer,500);
  assert.ok((await pendingRatings(db,customerActor)).some(p=>p.id===rated));
  await rateDelivery(db,customerActor,rated,{stars:4});
  await assert.rejects(rateDelivery(db,customerActor,rated,{stars:5}),/already rated/);
  await assert.rejects(rateDelivery(db,customerActor,rated,{stars:9}));
  await rateDelivery(db,safetyActor,rated,{stars:5});
  assert.deepEqual(await myRating(db,safetyActor),{average:4,total:1});
  await assert.rejects(createShareLink(db,safetyActor,{shipmentId:rated}),/finished/);

  // Long shifts force a rest, and a short break does not reset the clock.
  await db.query('UPDATE riders SET online=false,last_offline_at=NULL WHERE id=$1',[safetyRider]);
  await db.query('UPDATE riders SET online=true WHERE id=$1',[safetyRider]);
  const shift=(await db.query('SELECT shift_started_at FROM riders WHERE id=$1',[safetyRider])).rows[0].shift_started_at;
  assert.ok(shift);
  await db.query('UPDATE riders SET online=false WHERE id=$1',[safetyRider]);
  await db.query('UPDATE riders SET online=true WHERE id=$1',[safetyRider]);
  assert.equal((await db.query('SELECT shift_started_at FROM riders WHERE id=$1',[safetyRider])).rows[0].shift_started_at.getTime(),shift.getTime());
  await db.query("UPDATE riders SET shift_started_at=now()-interval '13 hours' WHERE id=$1",[safetyRider]);
  assert.ok((await tools.enforceDrivingLimits(db)).includes(safetyRider));
  await assert.rejects(app.availability(safetyActor,{online:true}),/driving time limit/);

  // A rider who stays still mid-delivery is flagged once.
  const stopRider=await newRider();
  const stopped=await shipment(customer,'AWAITING_ASSIGNMENT',true);
  await db.query('INSERT INTO rider_dispatch_plans(rider_id,revision,stops) VALUES($1,1,$2)',[stopRider,JSON.stringify([{shipmentId:stopped,kind:'pickup',weightG:100,latitude:5.5,longitude:-0.2},{shipmentId:stopped,kind:'dropoff',weightG:100,latitude:5.5,longitude:-0.2}])]);
  await db.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[stopped,stopRider]);
  await db.query("INSERT INTO challenges(id,shipment_id,rider_id,purpose,phone,digest,expires_at,sent,consumed_at) VALUES($1,$2,$3,'pickup','+233241234567','x',now()+interval '5 minutes',true,now())",[randomUUID(),stopped,stopRider]);
  await db.query("UPDATE shipments SET state='PICKUP_VERIFIED' WHERE id=$1",[stopped]);
  await db.query("UPDATE riders SET current_position=ST_SetSRID(ST_MakePoint(-0.2,5.5),4326)::geography,position_at=now() WHERE id=$1",[stopRider]);
  assert.match((await createShareLink(db,{id:stopRider,kind:'rider'},{shipmentId:stopped})).path,/^\/track\//);
  assert.equal((await tools.flagUnusualStops(db)).length,0);
  await db.query("UPDATE delivery_stop_watch SET since=now()-interval '25 minutes' WHERE shipment_id=$1",[stopped]);
  assert.deepEqual(await tools.flagUnusualStops(db),[stopped]);
  assert.equal((await tools.flagUnusualStops(db)).length,0);

  // Goals, referrals and campaigns. Rewards arrive once, as commission credit.
  const goalsRider={id:safetyRider,kind:'rider'};
  assert.equal((await tools.setEarningsGoals(db,goalsRider,{dailyGoalMinor:5000,weeklyGoalMinor:null})).dailyGoalMinor,5000);
  const {recordFinancialEntry}=await import('../services/api/modules/payments/index.mjs');
  await db.tx(async c=>recordFinancialEntry(c,{shipment:(await c.query('SELECT * FROM shipments WHERE id=$1',[rated])).rows[0],beneficiaryId:safetyRider}));
  assert.ok((await tools.riderEarningsGoals(db,goalsRider)).todayMinor>=370);
  const inviter=await newRider(),invited=await newRider();
  const inviteCode=(await tools.referralSummary(db,{id:inviter,kind:'rider'})).code;
  await assert.rejects(tools.applyReferralCode(db,{id:inviter,kind:'rider'},{code:inviteCode}),/not valid/);
  await tools.applyReferralCode(db,{id:invited,kind:'rider'},{code:inviteCode});
  await assert.rejects(tools.applyReferralCode(db,{id:invited,kind:'rider'},{code:inviteCode}),/already/);
  const financeAdmin=await user('admin');
  await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'finance:configure')",[financeAdmin]);
  await tools.createRewardCampaign(db,{id:financeAdmin,kind:'admin'},{title:'Weekend push',targetDeliveries:1,rewardMinor:700,days:7});
  await completedEarning(invited,customer,100);
  process.env.REFERRAL_TARGET_DELIVERIES='1';process.env.REFERRAL_REWARD_MINOR='900';
  await tools.settleRiderRewards(db);await tools.settleRiderRewards(db);
  delete process.env.REFERRAL_TARGET_DELIVERIES;delete process.env.REFERRAL_REWARD_MINOR;
  const {balance}=await import('../services/api/modules/payments/finance.mjs');
  assert.equal((await balance(db,inviter)).creditMinor,900);
  assert.equal((await balance(db,invited)).creditMinor,700);
  assert.ok((await tools.riderCampaigns(db,{id:invited,kind:'rider'})).campaigns.some(k=>k.title==='Weekend push'&&k.completed>=1));
  assert.ok(Array.isArray((await tools.demandAreas(db,{id:invited,kind:'rider'})).areas));

  // Riders repeat the selfie check, and are suspended if they ignore it.
  const {requireIdentityRefresh}=await import('../services/api/rider-licence.mjs');
  for(const [k,v] of [['DIDIT_API_KEY','k'],['DIDIT_WORKFLOW_ID','w'],['DIDIT_WEBHOOK_SECRET','whsec']])process.env[k]=v;
  try{
   await db.query("UPDATE rider_licences SET identity_checked_at=now()-interval '100 days' WHERE rider_id=$1",[selfie]);
   assert.ok((await requireIdentityRefresh(db)).requested>=1);
   await db.query("UPDATE rider_licences SET reverify_due_at=now()-interval '1 hour' WHERE rider_id=$1",[selfie]);
   assert.ok((await requireIdentityRefresh(db)).suspended>=1);
   assert.equal((await db.query('SELECT status FROM riders WHERE id=$1',[selfie])).rows[0].status,'suspended');
  }finally{for(const k of ['DIDIT_API_KEY','DIDIT_WORKFLOW_ID','DIDIT_WEBHOOK_SECRET'])delete process.env[k];}
 }finally{await db.close();}
});
