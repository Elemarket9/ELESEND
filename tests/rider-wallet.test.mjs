import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {financeService,balance} from '../services/api/finance.mjs';
import {moneyOperations} from '../services/api/money-operations.mjs';
import {platform as platformService} from '../services/api/platform.mjs';
import {paymentWebhook} from '../services/api/payment-provider.mjs';
import {calculateQuote} from '../services/api/pricing.mjs';
import {calculateCommissionBreakdown} from '../services/api/commission-engine.mjs';
import {digitalDeliveryCompleted} from '../services/api/checkout-accounting.mjs';
import {
 settleCompletedDelivery,walletSummary,walletDebt,walletTransactions,assignmentEligibility,requireDebtEligible,
 updateWalletPolicy,walletPolicyView,walletReconciliation,runScheduledRecovery,adminWalletOverview,adminWalletReconciliation,debtState
} from '../services/api/rider-wallet.mjs';

const url=process.env.TEST_DATABASE_URL;
const phone=()=>'+2332'+String(randomInt(10000000,99999999));
const riderActor=id=>({id,kind:'rider'});
const commissionRef=id=>'escomm_'+id.replaceAll('-','');
const intentFromRef=r=>{const ref=typeof r==='string'?r:r?.reference||'';const m=/^escomm_([0-9a-f]{32})$/.exec(ref);if(!m)return null;const h=m[1];return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');};

/** Provider-neutral fixture adapter: no network, no real money. */
function fixtureProvider(name='wallet_fx'){
 const p={
  name,methods:['MOMO','CARD'],allowedCheckoutHosts:['checkout.test'],
  createCalls:[],payoutCalls:[],webhookRecord:null,verifyResult:{verified:true,status:'pending'},
  async createPayment(x){p.createCalls.push(x);return {reference:x.reference,checkoutUrl:'https://checkout.test/pay/'+x.reference};},
  async verifyPayment(ref){return {...p.verifyResult,reference:ref};},
  commissionIntentId:intentFromRef,
  async parseVerifiedWebhook(){return p.webhookRecord;},
  async createPayout(x){p.payoutCalls.push(x);return {providerId:'po_'+x.requestId};},
  async verifyPayout(){return {verified:true,status:'pending'};}
 };
 return p;
}

test('rider wallet, COD commission debt, automatic recovery and debt restriction',{skip:!url},async t=>{
 assert.match(new URL(url).pathname,/^\/elesend_test/,'Requires dedicated test database');
 const root=database(url);
 try{
  await migrate(root);

  async function mkUser(q,kind,perms=[]){
   const id=randomUUID();
   await q.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'test-only',$3,now())",[id,phone(),kind]);
   for(const p of perms)await q.query('INSERT INTO permissions(user_id,permission) VALUES($1,$2)',[id,p]);
   return id;
  }
  async function mkRider(q,{companyId=null,limitMinor=null}={}){
   const id=await mkUser(q,'rider');
   await q.query("INSERT INTO riders(id,status,vehicle,max_weight_g,company_id) VALUES($1,'approved','motorcycle',20000,$2)",[id,companyId]);
   await q.query('INSERT INTO commission_accounts(rider_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
   if(limitMinor!==null)await q.query('UPDATE commission_accounts SET max_outstanding_minor=$2 WHERE rider_id=$1',[id,limitMinor]);
   return id;
  }
  /** A delivery that already passed OTP handover; settlement is then invoked exactly as the completion tx does. */
  async function mkCompleted(q,{customer,riderId,amount,commission,method='MOMO',companyId=null}){
   const qid=randomUUID(),sid=randomUUID(),cash=method==='CASH';
   await q.query("INSERT INTO quotes(id,customer_id,policy_id,request,amount_minor,commission_minor,expires_at,payment_method) SELECT $1,$2,id,'{}'::jsonb,$3,$4,now()+interval '1 hour',$5 FROM pricing_policies ORDER BY active DESC LIMIT 1",[qid,customer,amount,commission,method]);
   const s=(await q.query(`INSERT INTO shipments(id,customer_id,quote_id,idempotency_key,rider_id,company_id,recipient_phone,amount_minor,commission_minor,payment_method,cash_payer,state,paid,completed_at)
     VALUES($1,$2,$3,$4,$5,$6,'+233241234567',$7,$8,$9,$10,'COMPLETED',$11,now()) RETURNING *`,[sid,customer,qid,'w-'+sid,riderId,companyId,amount,commission,method,cash?'recipient':null,!cash])).rows[0];
   if(!cash)await q.query(`INSERT INTO shipment_checkout_intents(id,shipment_id,customer_id,method,provider,reference,amount_minor,currency,idempotency_key,status,confirmed_at,provider_terminal_at)
     VALUES($1,$2,$3,$4,'fixture',$5,$6,'GHS',$7,'confirmed',now(),now())`,[randomUUID(),sid,customer,method,'ref_'+sid,amount,'idem-'+sid]);
   return s;
  }
  const settle=(db,s)=>db.tx(c=>settleCompletedDelivery(c,s));
  const debtOf=async(q,riderId)=>(await balance(q,riderId)).dueMinor;
  const payableOf=async(q,sid)=>Number((await q.query(`SELECT coalesce(sum(CASE WHEN side='credit' THEN amount_minor ELSE -amount_minor END),0)::bigint AS v FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 AND l.account='rider_payable'`,[sid])).rows[0].v);

  async function fixture(fn){
   const c=await root.pool.connect();await c.query('BEGIN');let sp=0;
   const db={query:(...a)=>c.query(...a),async tx(f){const n='w_'+(++sp);await c.query('SAVEPOINT '+n);try{const r=await f(c);await c.query('RELEASE SAVEPOINT '+n);return r;}catch(e){await c.query('ROLLBACK TO SAVEPOINT '+n);throw e;}}};
   try{
    const customer=await mkUser(c,'customer');
    await fn({db,c,customer});
    await c.query('SET CONSTRAINTS ALL IMMEDIATE'); // deferred balanced-journal triggers must pass
   }finally{await c.query('ROLLBACK');c.release();}
  }

  await t.test('COD delivery completed through OTP posts the configured commission as rider debt exactly once; wallet goes negative',()=>fixture(async({db,c,customer})=>{
   await c.query('UPDATE pricing_policies SET active=false');
   await c.query("INSERT INTO pricing_policies(id,base_minor,per_km_minor,commission_bps,vehicle) VALUES($1,1000,100,1000,'motorcycle')",[randomUUID()]);
   const rider=await mkRider(c);
   const sent=[];
   const app=platformService(db,{otpKey:'d'.repeat(64),sms:{async send(m){sent.push(m);return {accepted:true};}},routing:{route:async()=>({distanceMeters:2000,durationSeconds:300,source:'fixture'})}});
   const finance=financeService(db,{});
   const quote=await app.quote({id:customer,kind:'customer'},{pickup:{address:'Accra Mall',latitude:5.6214,longitude:-0.1741},destination:{address:'Osu Oxford Street',latitude:5.556,longitude:-0.1825},vehicle:'motorcycle',recipientPhone:'+233209998877',weightG:1000,description:'Documents',paymentMethod:'CASH',cashPayer:'recipient'});
   const booked=await app.book({id:customer,kind:'customer'},{quoteId:quote.id},'cod-'+randomUUID());
   assert.equal(booked.state,'AWAITING_ASSIGNMENT','COD courier enters dispatch without digital prepayment');
   assert.equal(booked.payment_method,'CASH');
   await c.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[booked.id,rider]);
   await c.query('INSERT INTO rider_dispatch_plans(rider_id,stops) VALUES($1,$2)',[rider,JSON.stringify([{shipmentId:booked.id,kind:'pickup',latitude:5.6214,longitude:-0.1741,weightG:1000},{shipmentId:booked.id,kind:'dropoff',latitude:5.556,longitude:-0.1825,weightG:1000}])]);
   const pick=await app.challenge(riderActor(rider),booked.id,'pickup');
   await app.verify(riderActor(rider),booked.id,{challengeId:pick.challengeId,code:sent.at(-1).code});
   await app.transition(riderActor(rider),booked.id,{action:'start'});
   await finance.reportCash(riderActor(rider),booked.id,{reportedMinor:booked.amount_minor,cashPayer:'recipient',idempotencyKey:'cash-'+randomUUID().slice(0,8)});
   const drop=await app.challenge(riderActor(rider),booked.id,'delivery');
   assert.equal(sent.at(-1).phone,'+233209998877','delivery OTP goes to the immutable booked recipient');
   const code=sent.at(-1).code;
   assert.equal((await app.verify(riderActor(rider),booked.id,{challengeId:drop.challengeId,code})).ok,true);
   await assert.rejects(app.verify(riderActor(rider),booked.id,{challengeId:drop.challengeId,code}),/Challenge unavailable|Wrong delivery state/,'replayed completion is rejected');
   const done=(await c.query('SELECT * FROM shipments WHERE id=$1',[booked.id])).rows[0];
   assert.equal(done.state,'COMPLETED');
   const commission=Number(quote.commission_minor);
   assert.ok(commission>0&&commission<done.amount_minor);
   assert.equal(done.commission_minor,commission,'commission is the locked quote commission on the delivery fare only');
   const journals=(await c.query("SELECT j.id FROM finance_journals j WHERE j.event_key=$1",['shipment:'+booked.id+':cash-commission'])).rows;
   assert.equal(journals.length,1);
   const again=await settle(db,done);
   assert.equal(again.cashCommission.duplicate,true,'duplicate completion cannot debit commission twice');
   const w=await walletSummary(db,riderActor(rider));
   assert.equal(w.outstandingDebtMinor,commission);
   assert.equal(w.walletBalanceMinor,-commission);
   assert.equal(w.withdrawableMinor,0);
   assert.equal(w.lifetime.cashCommissionAssessedMinor,commission);
  }));

  await t.test('prepaid earnings automatically recover debt: -GH₵100 -> -GH₵60 -> +GH₵20, withdrawable only after recovery, no waiting period',()=>fixture(async({db,c,customer})=>{
   const rider=await mkRider(c);
   const cod=await mkCompleted(c,{customer,riderId:rider,amount:100000,commission:10000,method:'CASH'});
   await settle(db,cod);
   let w=await walletSummary(db,riderActor(rider));
   assert.equal(w.walletBalanceMinor,-10000);assert.equal(w.withdrawableMinor,0);
   const a=await mkCompleted(c,{customer,riderId:rider,amount:5000,commission:1000});
   const ra=await settle(db,a);
   assert.equal(ra.recovery.recoveredMinor,4000);
   w=await walletSummary(db,riderActor(rider));
   assert.equal(w.walletBalanceMinor,-6000);assert.equal(w.outstandingDebtMinor,6000);assert.equal(w.availableEarningsMinor,0);assert.equal(w.withdrawableMinor,0);
   const b=await mkCompleted(c,{customer,riderId:rider,amount:10000,commission:2000});
   await settle(db,b);
   w=await walletSummary(db,riderActor(rider));
   assert.equal(w.walletBalanceMinor,2000);assert.equal(w.outstandingDebtMinor,0);
   assert.equal(w.withdrawableMinor,2000,'eligible digital earnings are withdrawable immediately');
   assert.equal(w.lifetime.debtRecoveredFromEarningsMinor,10000);
   assert.deepEqual((await c.query('SELECT amount_minor FROM rider_debt_recoveries WHERE rider_id=$1 ORDER BY created_at,seq',[rider])).rows.map(r=>Number(r.amount_minor)),[4000,6000]);
   // Delivery commission is assessed once per delivery; recovery never re-charges commission.
   const fees=(await c.query(`SELECT j.shipment_id,sum(l.amount_minor)::bigint AS fee FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE l.account='platform_commission_revenue' AND j.shipment_id=ANY($1::uuid[]) GROUP BY j.shipment_id`,[[a.id,b.id]])).rows;
   assert.deepEqual(Object.fromEntries(fees.map(r=>[r.shipment_id,Number(r.fee)])),{[a.id]:1000,[b.id]:2000});
   assert.equal((await settle(db,b)).recovery.recoveredMinor,0,'repeated settlement is idempotent');
   assert.equal((await walletSummary(db,riderActor(rider))).walletBalanceMinor,2000);
   const tx=(await walletTransactions(db,riderActor(rider))).items.map(i=>i.type);
   for(const type of ['cash_commission','digital_delivery_earnings','debt_recovered_from_earnings'])assert.ok(tx.includes(type),type);
   assert.equal((await walletDebt(db,riderActor(rider))).obligations.length,0,'debt history retained, nothing outstanding');
   assert.equal((await c.query("SELECT count(*)::int AS n FROM finance_journals WHERE rider_id=$1 AND kind='cash_commission'",[rider])).rows[0].n,1);
   const rec=await walletReconciliation(c);
   assert.ok(!rec.anomalies.some(x=>['RECOVERY_CLEARING_MISMATCH','RECOVERY_EVIDENCE_MISMATCH','NEGATIVE_RIDER_PAYABLE'].includes(x.code)),JSON.stringify(rec.anomalies.map(x=>x.code)));
   for(const code of ['DEBT_OBLIGATION_MISMATCH','UNRECOVERED_DEBT_WITH_EARNINGS'])
    assert.ok(!(rec.anomalies.find(x=>x.code===code)?.sample??[]).some(r=>r.rider_id===rider),code);
  }));

  await t.test('debt limit: below eligible, at/above restricted, repayment lifts it, fraud suspension persists, restricted rider can still repay',()=>fixture(async({db,c,customer})=>{
   const admin=await mkUser(c,'admin',['finance:configure']);
   const reader=await mkUser(c,'admin',['finance:read']);
   await assert.rejects(updateWalletPolicy(db,{id:reader,kind:'admin'},{maxDebtMinor:20000,reason:'Unauthorized change attempt'}),err=>err.status===403);
   await assert.rejects(updateWalletPolicy(db,{id:admin,kind:'admin'},{maxDebtMinor:-1,reason:'Invalid negative limit test'}));
   await assert.rejects(updateWalletPolicy(db,{id:admin,kind:'admin'},{maxDebtMinor:20000,reason:'short'}));
   const updated=await updateWalletPolicy(db,{id:admin,kind:'admin'},{maxDebtMinor:20000,reason:'Pilot rider debt limit of GH₵200 approved'});
   assert.equal(updated.max_debt_minor,20000);
   const view=await walletPolicyView(db,{id:reader,kind:'admin'});
   assert.equal(view.history[0].changed_by,admin);
   const rider=await mkRider(c);
   await settle(db,await mkCompleted(c,{customer,riderId:rider,amount:200000,commission:19999,method:'CASH'}));
   assert.equal((await assignmentEligibility(c,rider)).eligible,true,'below limit');
   await db.tx(cc=>requireDebtEligible(cc,rider));
   await settle(db,await mkCompleted(c,{customer,riderId:rider,amount:1000,commission:1,method:'CASH'}));
   await assert.rejects(db.tx(cc=>requireDebtEligible(cc,rider)),/DEBT_LIMIT_REACHED/,'at limit');
   assert.ok((await c.query("SELECT 1 FROM settlement_notifications WHERE rider_id=$1 AND notification_type='DEBT_LIMIT_RESTRICTION'",[rider])).rowCount);
   await settle(db,await mkCompleted(c,{customer,riderId:rider,amount:50000,commission:5000,method:'CASH'}));
   const elig=await assignmentEligibility(c,rider);
   assert.equal(elig.eligible,false);assert.ok(elig.restrictions.some(r=>r.code==='DEBT_LIMIT_REACHED'),'above limit');
   // Restricted rider can still see debt and start a repayment through the configured gateway.
   const provider=fixtureProvider();
   const finance=financeService(db,{provider});
   const w=await walletSummary(db,riderActor(rider));
   assert.equal(w.debtRestricted,true);assert.equal(w.repayment.canRepay,true);
   const intent=await finance.initiate(riderActor(rider),{kind:'commission_repayment',amountMinor:10000,idempotencyKey:'repay-limit-001'});
   assert.equal(intent.status,'pending');
   assert.deepEqual(provider.createCalls[0].allowedChannels,['mobile_money','card'],'policy channels passed to the adapter');
   assert.equal(await debtOf(c,rider),25000,'pending top-up does not reduce debt');
   await finance.confirmed({providerName:provider.name,eventId:'evt_'+randomUUID(),intentId:intent.intentId,amountMinor:10000,currency:'GHS'});
   assert.equal(await debtOf(c,rider),15000);
   assert.equal((await assignmentEligibility(c,rider)).eligible,true,'debt restriction lifted automatically');
   assert.ok((await c.query("SELECT 1 FROM settlement_notifications WHERE rider_id=$1 AND notification_type='DEBT_LIMIT_RESTORED'",[rider])).rowCount);
   await c.query("UPDATE riders SET status='suspended' WHERE id=$1",[rider]);
   const fraud=await assignmentEligibility(c,rider);
   assert.equal(fraud.eligible,false);assert.ok(fraud.restrictions.some(r=>r.code==='ACCOUNT_STATUS'),'independent suspension is not cleared by repayment');
   assert.equal((await walletSummary(db,riderActor(rider))).outstandingDebtMinor,15000,'suspended rider keeps wallet access');
  }));

  await t.test('top-ups credit only after verified evidence; pending/failed never reduce debt; duplicates once; channel policy; reversal reinstates',()=>fixture(async({db,c,customer})=>{
   const admin=await mkUser(c,'admin',['finance:configure']);
   const rider=await mkRider(c);
   await settle(db,await mkCompleted(c,{customer,riderId:rider,amount:150000,commission:15000,method:'CASH'}));
   const provider=fixtureProvider();
   const finance=financeService(db,{provider});
   const hook=paymentWebhook({db,provider,checkout:null,finance,money:null});
   const failedIntent=await finance.initiate(riderActor(rider),{kind:'commission_repayment',amountMinor:10000,idempotencyKey:'topup-fail-01'});
   provider.verifyResult={verified:true,status:'failed',failureReason:'insufficient_funds'};
   assert.equal((await finance.reconcileIntent(failedIntent.intentId)).status,'failed');
   assert.equal(await debtOf(c,rider),15000,'failed top-up does not reduce debt');
   provider.verifyResult={verified:true,status:'pending'};
   const ok=await finance.initiate(riderActor(rider),{kind:'commission_repayment',amountMinor:10000,idempotencyKey:'topup-card-01'});
   const eventId='evt_card_'+randomUUID();
   provider.webhookRecord={status:'success',reference:commissionRef(ok.intentId),amountMinor:10000,currency:'GHS',channel:'card',eventId};
   assert.equal((await hook(Buffer.from('{}'),{})).status,'confirmed','card repayment accepted by default policy');
   assert.equal((await hook(Buffer.from('{}'),{})).duplicate,true,'duplicate webhook');
   assert.equal(await debtOf(c,rider),5000);
   provider.webhookRecord={status:'success',reference:commissionRef(ok.intentId),amountMinor:9999,currency:'GHS',channel:'card',eventId:'evt_wrong_'+randomUUID()};
   await assert.rejects(hook(Buffer.from('{}'),{}),/does not match/,'wrong amount rejected');
   await updateWalletPolicy(db,{id:admin,kind:'admin'},{repaymentChannels:['mobile_money'],reason:'Restrict repayments to mobile money only'});
   const momoOnly=await finance.initiate(riderActor(rider),{kind:'commission_repayment',amountMinor:5000,idempotencyKey:'topup-momo-only'});
   assert.deepEqual(provider.createCalls.at(-1).allowedChannels,['mobile_money']);
   provider.webhookRecord={status:'success',reference:commissionRef(momoOnly.intentId),amountMinor:5000,currency:'GHS',channel:'card',eventId:'evt_card2_'+randomUUID()};
   await assert.rejects(hook(Buffer.from('{}'),{}),/not verified/,'card rejected when policy disallows it');
   assert.equal(await debtOf(c,rider),5000);
   provider.webhookRecord={status:'reversed',reference:commissionRef(ok.intentId),eventId:'evt_rev_'+randomUUID(),failureReason:'chargeback'};
   assert.equal((await hook(Buffer.from('{}'),{})).status,'reversed');
   assert.equal((await hook(Buffer.from('{}'),{})).duplicate,true,'duplicate reversal applied once');
   assert.equal(await debtOf(c,rider),15000,'reversal reinstates debt; no unbacked balance remains');
  }));

  await t.test('approved reinstatement correction is recovered from unpaid earnings with two-person control',()=>fixture(async({db,c,customer})=>{
   const [a1,a2]=[await mkUser(c,'admin',['finance:adjust','finance:approve']),await mkUser(c,'admin',['finance:adjust','finance:approve'])];
   const rider=await mkRider(c);
   const dig=await mkCompleted(c,{customer,riderId:rider,amount:5000,commission:1000});
   await settle(db,dig);
   const finance=financeService(db,{});
   const req=await finance.adjustmentRequest({id:a1,kind:'admin'},{riderId:rider,direction:'reinstate',amountMinor:2500,reason:'Correction: missed cash commission on disputed trip'});
   await assert.rejects(finance.approveAdjustment({id:a1,kind:'admin'},req.id),err=>err.status===403);
   await finance.approveAdjustment({id:a2,kind:'admin'},req.id);
   assert.equal(await debtOf(c,rider),0);
   assert.equal(await payableOf(c,dig.id),1500);
   assert.equal((await walletSummary(db,riderActor(rider))).walletBalanceMinor,1500);
  }));

  await t.test('withdrawals: debt blocks payout, approval reduces or supersedes stale proposals, company earnings never offset rider debt',()=>fixture(async({db,c,customer})=>{
   const [proposer,approver]=[await mkUser(c,'admin',['finance:configure','finance:approve']),await mkUser(c,'admin',['finance:configure','finance:approve'])];
   const provider=fixtureProvider('wallet_payout_fx');
   const money=moneyOperations(db,{provider});
   const rider=await mkRider(c);
   await c.query('INSERT INTO payout_beneficiaries(user_id,provider,recipient_reference) VALUES($1,$2,$3)',[rider,provider.name,'momo:0244000000']);
   const p1=await mkCompleted(c,{customer,riderId:rider,amount:10000,commission:2000});
   await settle(db,p1);
   const prop=await money.proposePayout({id:proposer,kind:'admin'},{shipmentId:p1.id,kind:'rider'});
   assert.equal(Number(prop.amount_minor),8000);
   await settle(db,await mkCompleted(c,{customer,riderId:rider,amount:30000,commission:3000,method:'CASH'}));
   assert.equal(await payableOf(c,p1.id),5000,'new COD debt recovered from the proposed (not yet submitted) earnings');
   await money.approvePayout({id:approver,kind:'admin'},prop.id);
   assert.equal(provider.payoutCalls.length,1);assert.equal(provider.payoutCalls[0].amountMinor,5000,'payout never includes money owed to ELESEND');
   const p2=await mkCompleted(c,{customer,riderId:rider,amount:5000,commission:1000});
   await settle(db,p2);
   const prop2=await money.proposePayout({id:proposer,kind:'admin'},{shipmentId:p2.id,kind:'rider'});
   await settle(db,await mkCompleted(c,{customer,riderId:rider,amount:90000,commission:9000,method:'CASH'}));
   assert.equal((await money.approvePayout({id:approver,kind:'admin'},prop2.id)).status,'superseded');
   assert.equal(provider.payoutCalls.length,1,'no provider call for superseded payout');
   assert.equal(await debtOf(c,rider),5000);
   const admin=await mkUser(c,'admin',['finance:configure']);
   await updateWalletPolicy(db,{id:admin,kind:'admin'},{autoRecoverFromEarnings:false,reason:'Temporarily disable automatic recovery for test'});
   const p3=await mkCompleted(c,{customer,riderId:rider,amount:5000,commission:500});
   await settle(db,p3);
   await assert.rejects(money.proposePayout({id:proposer,kind:'admin'},{shipmentId:p3.id,kind:'rider'}),/outstanding ELESEND commission debt/,'negative wallet cannot withdraw');
   await updateWalletPolicy(db,{id:admin,kind:'admin'},{autoRecoverFromEarnings:true,reason:'Re-enable automatic debt recovery'});
   // Company rider: job earnings belong to the company and are not used against the rider's personal debt.
   const owner=await mkUser(c,'company');const company=randomUUID();
   await c.query("INSERT INTO companies(id,owner_id,name,status) VALUES($1,$2,'Fleet Co','approved')",[company,owner]);
   const fleetRider=await mkRider(c,{companyId:company});
   await settle(db,await mkCompleted(c,{customer,riderId:fleetRider,amount:20000,commission:2000,method:'CASH'}));
   await settle(db,await mkCompleted(c,{customer,riderId:fleetRider,amount:6000,commission:1000,companyId:company}));
   const fw=await walletSummary(db,riderActor(fleetRider));
   assert.equal(fw.outstandingDebtMinor,2000);assert.equal(fw.companyEarningsMinor,5000);assert.equal(fw.withdrawableMinor,0);
  }));

  await t.test('object/function-level authorization on wallet and finance views',()=>fixture(async({db,c,customer})=>{
   const riderA=await mkRider(c),riderB=await mkRider(c);
   await settle(db,await mkCompleted(c,{customer,riderId:riderA,amount:50000,commission:5000,method:'CASH'}));
   const provider=fixtureProvider();const finance=financeService(db,{provider});
   const intent=await finance.initiate(riderActor(riderA),{kind:'commission_repayment',amountMinor:5000,idempotencyKey:'authz-intent-1'});
   await assert.rejects(finance.paymentStatus(riderActor(riderB),intent.intentId),err=>err.status===404,'rider cannot read another rider top-up');
   await assert.rejects(walletSummary(db,{id:customer,kind:'customer'}),err=>err.status===403);
   assert.equal((await walletSummary(db,riderActor(riderB))).outstandingDebtMinor,0,'wallet is always the caller’s own');
   const noPerm=await mkUser(c,'admin',[]),reader=await mkUser(c,'admin',['finance:read']);
   await assert.rejects(adminWalletOverview(db,{id:noPerm,kind:'admin'}),err=>err.status===403);
   await assert.rejects(adminWalletReconciliation(db,{id:riderA,kind:'rider'}),err=>err.status===403);
   const ov=await adminWalletOverview(db,{id:reader,kind:'admin'});
   assert.ok(ov.outstandingRiderDebtMinor>=5000);assert.ok(ov.recognizedDeliveryCommissionMinor.cash>=5000);
   assert.equal(JSON.stringify(ov).includes('secret'),false);
  }));

  await t.test('food can never use cash terms; locked financial terms are immutable',()=>fixture(async({c,customer})=>{
   const rider=await mkRider(c);
   const cod=await mkCompleted(c,{customer,riderId:rider,amount:10000,commission:1000,method:'CASH'});
   await c.query('SAVEPOINT f2');
   await assert.rejects(c.query("INSERT INTO food_orders(id,shipment_id,payment_method) VALUES($1,$2,'MOMO')",[randomUUID(),cod.id]),/Food orders require upfront digital payment/);
   await c.query('ROLLBACK TO SAVEPOINT f2');
   await c.query('SAVEPOINT f3');
   await assert.rejects(c.query('UPDATE shipments SET commission_minor=commission_minor+1 WHERE id=$1',[cod.id]),/immutable/);
   await c.query('ROLLBACK TO SAVEPOINT f3');
   await c.query('SAVEPOINT f4');
   await assert.rejects(c.query("UPDATE shipments SET payment_method='MOMO' WHERE id=$1",[cod.id]),/immutable/);
   await c.query('ROLLBACK TO SAVEPOINT f4');
  }));

  await t.test('reconciliation detects missing COD commission and unrecovered debt; scheduled recovery repairs idempotently',()=>fixture(async({db,c,customer})=>{
   const admin=await mkUser(c,'admin',['finance:configure']);
   const rider=await mkRider(c);
   const unsettled=await mkCompleted(c,{customer,riderId:rider,amount:20000,commission:2000,method:'CASH'});
   let rec=await walletReconciliation(c);
   assert.ok(rec.anomalies.find(a=>a.code==='COD_COMPLETED_WITHOUT_COMMISSION')?.sample.some(r=>r.shipment_id===unsettled.id));
   assert.equal(rec.ok,false);
   await settle(db,unsettled);
   await updateWalletPolicy(db,{id:admin,kind:'admin'},{autoRecoverFromEarnings:false,reason:'Simulate a missed recovery for reconciliation'});
   const dig=await mkCompleted(c,{customer,riderId:rider,amount:4000,commission:500});
   await settle(db,dig);
   await updateWalletPolicy(db,{id:admin,kind:'admin'},{autoRecoverFromEarnings:true,reason:'Restore automatic recovery after simulation'});
   rec=await walletReconciliation(c);
   assert.ok(rec.anomalies.find(a=>a.code==='UNRECOVERED_DEBT_WITH_EARNINGS')?.sample.some(r=>r.rider_id===rider));
   const run=await runScheduledRecovery(db);
   assert.equal(run.results.find(r=>r.riderId===rider)?.recoveredMinor,2000);
   assert.equal(await debtOf(c,rider),0);assert.equal(await payableOf(c,dig.id),1500);
   const run2=await runScheduledRecovery(db);
   assert.equal(run2.results.some(r=>r.riderId===rider),false,'second pass finds nothing to recover');
  }));

  // ---- Concurrency: real committed transactions on separate pooled connections ----
  const seedCommitted=async()=>({customer:await mkUser(root,'customer')});

  await t.test('concurrent duplicate completions settle once; concurrent prepaid credits recover debt exactly once',async()=>{
   const {customer}=await seedCommitted();
   const rider=await mkRider(root);
   const dig=await mkCompleted(root,{customer,riderId:rider,amount:6000,commission:1000});
   const outs=await Promise.all([settle(root,dig),settle(root,dig),settle(root,dig)]);
   assert.equal(outs.filter(o=>o.digitalSettlement.duplicate===false).length,1);
   assert.equal(await payableOf(root,dig.id),5000);
   const r2=await mkRider(root);
   await settle(root,await mkCompleted(root,{customer,riderId:r2,amount:50000,commission:5000,method:'CASH'}));
   const [x,y]=[await mkCompleted(root,{customer,riderId:r2,amount:5000,commission:1000}),await mkCompleted(root,{customer,riderId:r2,amount:5000,commission:1000})];
   await Promise.all([settle(root,x),settle(root,y)]);
   assert.equal(await debtOf(root,r2),0);
   assert.equal((await payableOf(root,x.id))+(await payableOf(root,y.id)),3000,'8000 earned - 5000 recovered, never over-recovered');
   assert.equal(Number((await root.query('SELECT sum(amount_minor)::bigint AS v FROM rider_debt_recoveries WHERE rider_id=$1',[r2])).rows[0].v),5000);
  });

  await t.test('repayment racing with a new COD commission and duplicate concurrent webhooks yield one correct balance',async()=>{
   const {customer}=await seedCommitted();
   const rider=await mkRider(root);
   await settle(root,await mkCompleted(root,{customer,riderId:rider,amount:60000,commission:6000,method:'CASH'}));
   const provider=fixtureProvider('wallet_race_fx');
   const finance=financeService(root,{provider});
   const hook=paymentWebhook({db:root,provider,checkout:null,finance,money:null});
   const intent=await finance.initiate(riderActor(rider),{kind:'commission_repayment',amountMinor:6000,idempotencyKey:'race-'+randomUUID().slice(0,12)});
   provider.webhookRecord={status:'success',reference:commissionRef(intent.intentId),amountMinor:6000,currency:'GHS',channel:'mobile_money',eventId:'evt_race_'+randomUUID()};
   const cod=await mkCompleted(root,{customer,riderId:rider,amount:20000,commission:2000,method:'CASH'});
   const results=await Promise.allSettled([hook(Buffer.from('{}'),{}),hook(Buffer.from('{}'),{}),settle(root,cod)]);
   assert.ok(results.every(r=>r.status==='fulfilled'),JSON.stringify(results.filter(r=>r.status==='rejected').map(r=>r.reason?.message)));
   assert.equal(await debtOf(root,rider),2000);
   assert.equal((await root.query('SELECT count(*)::int AS n FROM settlement_provider_events WHERE intent_id=$1',[intent.intentId])).rows[0].n,1);
   const rec=await walletReconciliation(root);
   assert.ok(!(rec.anomalies.find(a=>a.code==='DEBT_OBLIGATION_MISMATCH')?.sample??[]).some(r=>r.rider_id===rider));
  });

  await t.test('assignment cannot race past a concurrent debt increase (shared commission-account lock)',async()=>{
   const {customer}=await seedCommitted();
   const rider=await mkRider(root,{limitMinor:3000});
   const cod=await mkCompleted(root,{customer,riderId:rider,amount:30000,commission:3000,method:'CASH'});
   const c1=await root.pool.connect();
   try{
    await c1.query('BEGIN');
    await settleCompletedDelivery(c1,cod); // holds commission_accounts row lock, uncommitted
    let settled=false;
    const gate=root.tx(c=>requireDebtEligible(c,rider)).finally(()=>{settled=true;});
    gate.catch(()=>{});
    await new Promise(r=>setTimeout(r,300));
    assert.equal(settled,false,'eligibility check waits for the in-flight debt posting');
    await c1.query('COMMIT');
    await assert.rejects(gate,/DEBT_LIMIT_REACHED/);
   }finally{c1.release();}
  });

  await t.test('withdrawal racing with automatic debt recovery and concurrent approvals pay out exactly once and never include owed commission',async()=>{
   const {customer}=await seedCommitted();
   const [proposer,approver]=[await mkUser(root,'admin',['finance:configure','finance:approve']),await mkUser(root,'admin',['finance:configure','finance:approve'])];
   const provider=fixtureProvider('wallet_wd_fx_'+randomInt(1000,9999));
   const money=moneyOperations(root,{provider});
   const rider=await mkRider(root);
   await root.query('INSERT INTO payout_beneficiaries(user_id,provider,recipient_reference) VALUES($1,$2,$3)',[rider,provider.name,'momo:0244111111']);
   const p=await mkCompleted(root,{customer,riderId:rider,amount:10000,commission:2000});
   await settle(root,p);
   const cod=await mkCompleted(root,{customer,riderId:rider,amount:30000,commission:3000,method:'CASH'});
   const [props]=await Promise.all([
    Promise.allSettled([money.proposePayout({id:proposer,kind:'admin'},{shipmentId:p.id,kind:'rider'}),money.proposePayout({id:proposer,kind:'admin'},{shipmentId:p.id,kind:'rider'})]),
    settle(root,cod)
   ]);
   const ok=props.filter(r=>r.status==='fulfilled').map(r=>r.value.id);
   assert.ok(ok.length>=1);assert.equal(new Set(ok).size,1,'one live payout per shipment');
   const approvals=await Promise.allSettled([money.approvePayout({id:approver,kind:'admin'},ok[0]),money.approvePayout({id:approver,kind:'admin'},ok[0])]);
   assert.ok(approvals.every(r=>r.status==='fulfilled'));
   assert.equal(provider.payoutCalls.length,1,'exactly one provider payout');
   assert.equal(provider.payoutCalls[0].amountMinor,5000);
   assert.equal(await debtOf(root,rider),0);
   assert.equal(await payableOf(root,p.id),5000);
  });

   await t.test('100 simultaneous duplicate webhook requests process idempotently with single financial effect',async()=>{
    const rider=await mkRider(root);
    const {customer}=await seedCommitted();
    await settle(root,await mkCompleted(root,{customer,riderId:rider,amount:50000,commission:5000,method:'CASH'}));
    assert.equal(await debtOf(root,rider),5000);
    const provider=fixtureProvider('wallet_100_fx_'+randomInt(1000,9999));
    const finance=financeService(root,{provider});
    const hook=paymentWebhook({db:root,provider,checkout:null,finance,money:null});
    const intent=await finance.initiate(riderActor(rider),{kind:'commission_repayment',amountMinor:5000,idempotencyKey:'idem100-'+randomUUID()});
    const fixedEventId='evt_100_'+randomUUID();
    provider.webhookRecord={status:'success',reference:commissionRef(intent.intentId),amountMinor:5000,currency:'GHS',channel:'mobile_money',eventId:fixedEventId};
    const requests=Array.from({length:100},()=>hook(Buffer.from('{}'),{}));
    const results=await Promise.allSettled(requests);
    assert.ok(results.every(r=>r.status==='fulfilled'),'all 100 concurrent requests fulfilled');
    assert.equal(await debtOf(root,rider),0,'debt reduced exactly once');
    const eventsCount=Number((await root.query('SELECT count(*)::int AS c FROM settlement_provider_events WHERE intent_id=$1',[intent.intentId])).rows[0].c);
    assert.equal(eventsCount,1,'exactly 1 provider event stored');
    const journalsCount=Number((await root.query("SELECT count(*)::int AS c FROM finance_journals WHERE rider_id=$1 AND kind='commission_repayment'",[rider])).rows[0].c);
    assert.equal(journalsCount,1,'exactly 1 repayment journal recorded');
   });

   await t.test('deterministic integer arithmetic, fractional rounding boundaries, zero rates and extreme bounds',async()=>{
    const policy={base_minor:0,per_km_minor:0,commission_bps:1300,minimum_minor:0};
    // 15 pesewas at 13%: (15 * 1300 + 5000) / 10000 = (19500 + 5000) / 10000 = 24500 / 10000 = 2
    const q15=calculateQuote(policy,0,{surchargeMinor:15});
    assert.equal(q15.amountMinor,15);
    assert.equal(q15.commissionMinor,2);
    assert.equal(q15.riderEarningsMinor,13);
    assert.equal(q15.commissionMinor+q15.riderEarningsMinor,q15.amountMinor);

    // 35 pesewas at 13%: (35 * 1300 + 5000) / 10000 = (45500 + 5000) / 10000 = 50500 / 10000 = 5
    const q35=calculateQuote(policy,0,{surchargeMinor:35});
    assert.equal(q35.amountMinor,35);
    assert.equal(q35.commissionMinor,5);
    assert.equal(q35.riderEarningsMinor,30);
    assert.equal(q35.commissionMinor+q35.riderEarningsMinor,q35.amountMinor);

    // Required comprehensive commission configuration tests (0%, 3%, 10%, 13%, 20%, 50%, 99.99%, 100%)
    const fareMinor = 10000; // GH₵ 100.00
    const testRates = [
      { name: '0%', bps: 0, expComm: 0, expRider: 10000 },
      { name: '3%', bps: 300, expComm: 300, expRider: 9700 },
      { name: '10%', bps: 1000, expComm: 1000, expRider: 9000 },
      { name: '13%', bps: 1300, expComm: 1300, expRider: 8700 },
      { name: '20%', bps: 2000, expComm: 2000, expRider: 8000 },
      { name: '50%', bps: 5000, expComm: 5000, expRider: 5000 },
      { name: '99.99%', bps: 9999, expComm: 9999, expRider: 1 },
      { name: '100%', bps: 10000, expComm: 10000, expRider: 0 }
    ];

    for (const r of testRates) {
      // Test through calculateQuote
      const q = calculateQuote({ ...policy, commission_bps: r.bps }, 0, { surchargeMinor: fareMinor });
      assert.equal(q.amountMinor, fareMinor, `${r.name} amount mismatch`);
      assert.equal(q.commissionMinor, r.expComm, `${r.name} commission mismatch`);
      assert.equal(q.riderEarningsMinor, r.expRider, `${r.name} rider earnings mismatch`);
      assert.equal(q.commissionMinor + q.riderEarningsMinor, q.amountMinor, `${r.name} total balance`);
      assert.ok(q.riderEarningsMinor >= 0, `${r.name} rider earnings cannot be negative`);

      // Test through commission-engine calculateCommissionBreakdown
      const b = calculateCommissionBreakdown(fareMinor, r.bps);
      assert.equal(b.commissionMinor, r.expComm, `commissionEngine ${r.name} commission`);
      assert.equal(b.netEarningsMinor, r.expRider, `commissionEngine ${r.name} net earnings`);
      assert.equal(b.commissionMinor + b.netEarningsMinor, b.amountMinor, `commissionEngine ${r.name} balanced`);
      assert.ok(b.netEarningsMinor >= 0, `commissionEngine ${r.name} net earnings non-negative`);
    }

    // Input boundary and invalid rate rejection
    assert.throws(() => calculateCommissionBreakdown(10000, -1), /Invalid rateBps/);
    assert.throws(() => calculateCommissionBreakdown(10000, 10001), /Invalid rateBps/);
    assert.throws(() => calculateCommissionBreakdown(10000, 13.5), /Invalid rateBps/);
    assert.throws(() => calculateCommissionBreakdown(10000, NaN), /Invalid rateBps/);
    assert.throws(() => calculateQuote({ ...policy, commission_bps: 10001 }, 0, { surchargeMinor: 10000 }), /Commission basis points exceed 100% limit/);

    // Extreme values: 10,000,000 pesewas (GH₵ 100,000.00)
    const qExtreme=calculateQuote(policy,0,{surchargeMinor:10000000});
    assert.equal(qExtreme.amountMinor,10000000);
    assert.equal(qExtreme.commissionMinor,1300000);
    assert.equal(qExtreme.riderEarningsMinor,8700000);
    assert.equal(qExtreme.commissionMinor+qExtreme.riderEarningsMinor,qExtreme.amountMinor);

    // Double-entry balancing with odd amounts
    const rider=await mkRider(root);
    const {customer}=await seedCommitted();
    const odd=await mkCompleted(root,{customer,riderId:rider,amount:35,commission:5});
    await settle(root,odd);
    assert.equal(await payableOf(root,odd.id),30);

    // Database transactional verification of 100% commission COD order
    const r100 = await mkRider(root);
    const cod100 = await mkCompleted(root, { customer, riderId: r100, amount: 10000, commission: 10000, method: 'CASH' });
    await settle(root, cod100);
    assert.equal(await debtOf(root, r100), 10000, '100% commission creates full debt');
    const s100 = await walletSummary(root, riderActor(r100));
    assert.equal(s100.walletBalanceMinor, -10000, 'net balance exactly -10000 pesewas');
    assert.equal(s100.withdrawableMinor, 0, 'zero withdrawable earnings');

    // Database transactional verification of 0% commission COD order
    const r0 = await mkRider(root);
    const cod0 = await mkCompleted(root, { customer, riderId: r0, amount: 10000, commission: 0, method: 'CASH' });
    await settle(root, cod0);
    assert.equal(await debtOf(root, r0), 0, '0% commission creates zero debt');
    const s0 = await walletSummary(root, riderActor(r0));
    assert.equal(s0.walletBalanceMinor, 0);
   });

   await t.test('concurrent scheduled recovery runs under advisory lock avoid duplicate work',async()=>{
    const {customer}=await seedCommitted();
    const rider=await mkRider(root);
    await settle(root,await mkCompleted(root,{customer,riderId:rider,amount:40000,commission:4000,method:'CASH'}));
    const dig=await mkCompleted(root,{customer,riderId:rider,amount:10000,commission:1000});
    await root.tx(c=>digitalDeliveryCompleted(c,dig));
    // Run 5 concurrent recovery sweeps
    const runs=await Promise.allSettled(Array.from({length:5},()=>runScheduledRecovery(root)));
    assert.ok(runs.every(r=>r.status==='fulfilled'));
    assert.equal(await debtOf(root,rider),0);
    assert.equal(await payableOf(root,dig.id),5000);
    const recCount=Number((await root.query('SELECT count(*)::int AS c FROM rider_debt_recoveries WHERE shipment_id=$1',[dig.id])).rows[0].c);
    assert.equal(recCount,1,'exactly 1 recovery record created despite 5 concurrent workers');
   });

   await t.test('provider reversal after repayment reinstates debt and triggers restriction',async()=>{
    const {customer}=await seedCommitted();
    const rider=await mkRider(root,{limitMinor:2500});
    await settle(root,await mkCompleted(root,{customer,riderId:rider,amount:30000,commission:3000,method:'CASH'}));
    assert.equal((await debtState(root,rider)).restricted,true,'debt 3000 >= limit 2500 -> restricted');
    const provider=fixtureProvider('wallet_rev_fx_'+randomInt(1000,9999));
    const finance=financeService(root,{provider});
    const hook=paymentWebhook({db:root,provider,checkout:null,finance,money:null});
    const intent=await finance.initiate(riderActor(rider),{kind:'commission_repayment',amountMinor:3000,idempotencyKey:'pay-'+randomUUID()});
    provider.webhookRecord={status:'success',reference:commissionRef(intent.intentId),amountMinor:3000,currency:'GHS',channel:'mobile_money',eventId:'evt_pay_'+randomUUID()};
    await hook(Buffer.from('{}'),{});
    assert.equal((await debtState(root,rider)).debtMinor,0);
    assert.equal((await debtState(root,rider)).restricted,false,'repayment clears debt and lifts restriction');

    // Provider issues reversal / chargeback
    provider.webhookRecord={status:'reversed',reference:commissionRef(intent.intentId),amountMinor:3000,currency:'GHS',channel:'mobile_money',eventId:'evt_rev_'+randomUUID(),reason:'MoMo customer disputed charge'};
    await hook(Buffer.from('{}'),{});
    assert.equal((await debtState(root,rider)).debtMinor,3000,'debt reinstated');
    assert.equal((await debtState(root,rider)).restricted,true,'debt restriction reinstated');
   });

   await t.test('independent ledger reconstruction and global clearing zero-sum invariants',async()=>{
    const rider=await mkRider(root);
    const {customer}=await seedCommitted();
    await settle(root,await mkCompleted(root,{customer,riderId:rider,amount:30000,commission:3000,method:'CASH'}));
    const dig=await mkCompleted(root,{customer,riderId:rider,amount:8000,commission:1000});
    await settle(root,dig);
    const summary=await walletSummary(root,riderActor(rider));
    // Independent raw SQL projection
    const raw=await root.query(`
     WITH recv AS (
      SELECT coalesce(sum(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END),0)::bigint AS debt
      FROM finance_lines l JOIN finance_journals j ON j.id=l.journal_id
      WHERE j.rider_id=$1 AND l.ledger_code='rider_receivable'
     ),
     pay AS (
      SELECT coalesce(sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END),0)::bigint AS payable
      FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id
      JOIN shipments s ON s.id=j.shipment_id
      WHERE s.rider_id=$1 AND s.company_id IS NULL AND l.account='rider_payable'
     )
     SELECT recv.debt, pay.payable FROM recv, pay
    `,[rider]);
    assert.equal(Number(raw.rows[0].debt),summary.outstandingDebtMinor);
    assert.equal(Number(raw.rows[0].payable),summary.withdrawableMinor);
    assert.equal(summary.walletBalanceMinor,summary.availableEarningsMinor-summary.outstandingDebtMinor);

    // Verify global zero-sum clearing accounts
    const offsetClearing=Number((await root.query("SELECT coalesce(sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END),0)::bigint AS b FROM finance_lines WHERE ledger_code='rider_earnings_offset_clearing'")).rows[0].b);
    const recoveryClearing=Number((await root.query("SELECT coalesce(sum(CASE WHEN side='credit' THEN amount_minor ELSE -amount_minor END),0)::bigint AS b FROM checkout_accounting_lines WHERE account='rider_debt_recovery_clearing'")).rows[0].b);
    assert.equal(offsetClearing,recoveryClearing,'clearing accounts across both ledgers balance exactly');
   });
 }finally{await root.close();}
});
