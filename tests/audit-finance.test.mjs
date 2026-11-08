import test from 'node:test';
import assert from 'node:assert/strict';
import {randomInt,randomUUID} from 'node:crypto';
import {moolreCheckout} from '../services/api/modules/payments/providers/moolre-payment.mjs';

/**
 * Finance audit. Every payment provider here is a MOCK (labelled audit_mock / Moolre fetch fixture): no real
 * Mobile Money, card or bank transaction is made. The database is a real PostgreSQL/PostGIS database created
 * for this file only, so these tests can run beside the other database tests.
 */

// ---------- Moolre refund destination (no database) ----------
const MOOLRE_ACCOUNT='100000100002';
function moolre(answer){
 const calls=[];
 const p=moolreCheckout({apiUser:'elesend',publicKey:'pub',privateKey:'priv',accountNumber:MOOLRE_ACCOUNT,callbackSecret:'callback-secret-value',merchantEmail:'pay@example.test',
  callbackBaseUrl:'https://api.example.test',returnBaseUrl:'https://app.example.test',production:false,
  fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);calls.push({url:String(url),body});const r=answer(String(url),body);if(r instanceof Error)throw r;return {ok:r.httpOk??true,json:async()=>r};}});
 return {p,calls};
}
const paidStatus=id=>({status:1,code:'SS01',data:{txstatus:1,accountnumber:MOOLRE_ACCOUNT,amount:'62.50',transactionid:'31772290',externalref:id}});
const transfers=calls=>calls.filter(c=>c.url.endsWith('/open/transact/transfer'));
const refundInput=over=>({requestId:randomUUID(),reference:'es_abc12345',amountMinor:6250,currency:'GHS',customerPhone:'+233241234567',...over});

test('FIN-01 a Moolre refund to a number ported away from its prefix network goes to the network Moolre confirms',async()=>{
 // 024 is an MTN prefix, but this number now lives on Telecel (channel 6). Only Telecel knows the wallet.
 const {p,calls}=moolre((u,b)=>u.endsWith('/status')?paidStatus(b.id):u.endsWith('/validate')?(b.channel==='6'?{status:1,code:'AVD01',data:'AMA OWUSU'}:{status:0,code:'AVD02',data:'Phone No. not found',httpOk:false}):{status:'1',code:'OBGH01',data:{transactionid:'7'}});
 await p.createRefund(refundInput());
 const sent=transfers(calls);
 assert.equal(sent.length,1);
 assert.equal(sent[0].body.channel,'6','money goes to the confirmed network, not the prefix guess');
 assert.equal(sent[0].body.receiver,'0241234567');
});

test('FIN-01 a Moolre refund is never sent when the network cannot be confirmed',async()=>{
 const cases={
  'no network knows the number':()=>({status:0,code:'AVD02',httpOk:false}),
  'the name check is unavailable':()=>new Error('timeout'),
  'an unexpected answer':()=>({status:0,code:'AVD99',httpOk:false}),
  'two networks claim the number':b=>b.channel==='7'?{status:0,code:'AVD02',httpOk:false}:{status:1,code:'AVD01',data:'KOFI'}
 };
 for(const [name,validate] of Object.entries(cases)){
  const {p,calls}=moolre((u,b)=>u.endsWith('/status')?paidStatus(b.id):u.endsWith('/validate')?validate(b):{status:'1',code:'OBGH01',data:{transactionid:'7'}});
  await assert.rejects(p.createRefund(refundInput()),/needs staff|timeout/,name);
  assert.equal(transfers(calls).length,0,name+': nothing is sent');
 }
});

// ---------- Real PostgreSQL money lifecycle ----------
const url=process.env.TEST_DATABASE_URL;
test('finance lifecycle against real PostgreSQL with truly concurrent requests',{skip:!url,timeout:600000},async t=>{
 process.env.OTP_KEY??='e'.repeat(64);
 // Most scenarios pay out straight away; the hold itself is examined in the policy subtest.
 const previousHold=process.env.WITHDRAWAL_EARNINGS_HOLD_HOURS;process.env.WITHDRAWAL_EARNINGS_HOLD_HOURS='0';
 const {database}=await import('../services/api/db.mjs');
 const {migrate}=await import('../scripts/migrate.mjs');
 const {platform}=await import('../services/api/platform.mjs');
 const {httpServer}=await import('../services/api/http.mjs');
 const {checkoutService,financeService,moneyOperations,paymentWebhook}=await import('../services/api/modules/payments/index.mjs');
 const {walletReconciliation,walletSummary,recoverDebtFromEarnings,updateWalletPolicy,runScheduledRecovery}=await import('../services/api/modules/payments/rider-wallet.mjs');
 const {restaurantOrderService}=await import('../services/api/restaurant-orders.mjs');
 const {promotionEngine}=await import('../services/api/promotion-engine.mjs');
 const {commissionEngine}=await import('../services/api/commission-engine.mjs');
 const {foodDispatchAllowed}=await import('../services/api/modules/payments/food-payment.mjs');

 const admin=database(url,{max:2});
 const name='elesend_audit_finance_'+randomUUID().replaceAll('-','');
 await admin.query(`CREATE DATABASE "${name}"`);
 const target=new URL(url);target.pathname='/'+name;
 const db=database(target.toString(),{max:40});
 let server;
 try{
  await migrate(db);
  await db.query("UPDATE checkout_method_policies SET enabled=true WHERE method IN ('MOMO','CARD','CASH')");
  const sms={async send(){return {accepted:true};},async sendNotification(){return {accepted:true};}};
  const meters=(a,b)=>Math.max(1,Math.round(Math.hypot((a.latitude-b.latitude)*111000,(a.longitude-b.longitude)*111000)));
  const routing={async route(a,b){const m=meters(a,b);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};},async matrix(o,d){return o.map(x=>{const m=meters(x,d);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};});}};

  // MOCK provider: keeps its own record of charges, transfers and refunds, the way a real provider would.
  const psp={charges:new Map(),transfers:new Map(),payoutCalls:[],refundCalls:[],onPayout:null,payoutStatus:null,refundStatus:null,beforeCheckoutReturn:null};
  const provider={name:'audit_mock',methods:['MOMO','CARD'],allowedCheckoutHosts:['checkout.audit.invalid'],payerFields:[],commissionIntentId:()=>null,
   async createCheckout(x){if(psp.beforeCheckoutReturn)await psp.beforeCheckoutReturn(x);return {reference:x.reference,checkoutUrl:'https://checkout.audit.invalid/'+x.reference};},
   async verifyPayment(ref){const c=psp.charges.get(ref);return c?{verified:true,reference:ref,status:'success',amountMinor:c.amountMinor,currency:'GHS',channel:'mobile_money',eventId:c.eventId}:{verified:true,reference:ref,status:'pending'};},
   // The callback only names a reference; the payment is read back from the provider before it counts.
   async parseVerifiedWebhook(raw){const {reference}=JSON.parse(Buffer.from(raw).toString('utf8'));return provider.verifyPayment(reference);},
   async verifyBeneficiary({beneficiaryId,recipientReference}){return {verified:true,beneficiaryId,recipientReference};},
   async createPayout(x){psp.payoutCalls.push(x);if(psp.onPayout)return psp.onPayout(x);psp.transfers.set(x.requestId,{...x,state:'pending'});return {providerId:'po_'+x.requestId.slice(0,8)};},
   async verifyPayout(x){
    if(psp.payoutStatus)return psp.payoutStatus(x);
    const tr=psp.transfers.get(x.requestId);if(!tr)return {verified:false,status:'not_found',requestId:x.requestId};
    return tr.state==='pending'?{verified:true,status:'pending',requestId:x.requestId}:{verified:true,status:tr.state==='paid'?'paid':'failed',reversed:tr.state==='reversed',requestId:x.requestId,recipientReference:tr.recipientReference,amountMinor:tr.amountMinor,currency:tr.currency,providerId:'po_'+x.requestId.slice(0,8),eventId:'transfer:'+x.requestId+':'+tr.state};
   },
   async createRefund(x){psp.refundCalls.push(x);return {providerId:'rf_'+x.requestId.slice(0,8)};},
   async verifyRefund(x){return psp.refundStatus?psp.refundStatus(x):{verified:true,status:'pending',requestId:x.requestId};}};
  const dispatch={async tick(){return [];},async availability(){return {status:'unknown',guaranteed:false};},async offers(){return [];}};
  const app=platform(db,{otpKey:process.env.OTP_KEY,routing,dispatch,sms});
  const checkout=checkoutService(db,{provider});
  const finance=financeService(db,{provider});
  const money=moneyOperations(db,{provider,earningsHoldHours:0,withdrawalMinMinor:100});
  const food=restaurantOrderService(db,{platform:app,routing,sms});
  const webhook=paymentWebhook({db,provider,checkout,finance,moneyOperations:money});
  server=httpServer(db,app,dispatch,finance,checkout,{restaurantOrders:food,moneyOperations:money,paymentsWebhook:webhook});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const api=async(token,method,path,body)=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json().catch(()=>null)};};
  const phone=()=>'+23324'+String(randomInt(0,10000000)).padStart(7,'0');
  const PASSWORD='mango river lantern';
  async function signUp(kind,extra={}){
   const number=phone();
   const reg=await api(null,'POST','/api/v1/auth/register',{phone:number,password:PASSWORD,kind,...extra});assert.equal(reg.status,201,JSON.stringify(reg.data));
   const login=await api(null,'POST','/api/v1/auth/login',{phone:number,password:PASSWORD});assert.equal(login.status,200,JSON.stringify(login.data));
   await db.query("UPDATE users SET phone_verified_at=now() WHERE id=$1",[login.data.user.id]);
   return {token:login.data.token,id:login.data.user.id,actor:{id:login.data.user.id,kind}};
  }
  async function rider(){
   const r=await signUp('rider',{vehicle:'motorcycle',maxWeightG:20000});
   await db.query("UPDATE riders SET status='approved' WHERE id=$1",[r.id]);
   await db.query("UPDATE users SET credentials_changed_at=now()-interval '3 days' WHERE id=$1",[r.id]);
   await db.query("INSERT INTO payout_beneficiaries(user_id,provider,recipient_reference,destination_changed_at) VALUES($1,$2,$3,now()-interval '3 days') ON CONFLICT DO NOTHING",[r.id,provider.name,'mock:'+r.id]);
   return r;
  }
  const adminId=randomUUID();
  await db.query("INSERT INTO users(id,phone,password_hash,kind) VALUES($1,$2,'fixture','admin')",[adminId,phone()]);
  for(const p of ['finance:configure','finance:approve','finance:read','pricing:write','promotions:manage','payments:configure','verification:write'])await db.query('INSERT INTO permissions(user_id,permission) VALUES($1,$2)',[adminId,p]);
  const staff={id:adminId,kind:'admin'};
  const P={address:'Accra Mall, Tetteh Quarshie',latitude:5.6221,longitude:-0.1735},D={address:'Osu Oxford Street, Accra',latitude:5.5571,longitude:-0.1817};
  async function booked(c,paymentMethod='MOMO',over={}){
   const q=await app.quote(c.actor,{pickup:P,destination:D,vehicle:'motorcycle',recipientPhone:phone(),weightG:1000,description:'Documents',paymentMethod,...over});
   return app.book(c.actor,{quoteId:q.id},'fin-'+randomUUID());
  }
  /** Customer pays through hosted checkout; the provider then reports success by callback. */
  async function pay(c,shipmentId,{eventId='ev_'+randomUUID()}={}){
   const intent=await checkout.initiate(c.actor,shipmentId,{idempotencyKey:'k'+randomUUID().replaceAll('-','')});
   psp.charges.set(intent.reference,{amountMinor:intent.amountMinor,eventId});
   return {intent,eventId,result:await checkout.webhook(Buffer.from(JSON.stringify({reference:intent.reference})),{})};
  }
  /** Controlled assignment with the same pickup/drop-off manifest dispatch writes (dispatch is audited separately). */
  async function assign(r,shipmentId,{acceptedMinutesAgo=0}={}){
   const s=(await db.query('SELECT * FROM shipments WHERE id=$1',[shipmentId])).rows[0];
   await db.query(`INSERT INTO rider_dispatch_plans(rider_id,revision,stops) VALUES($1,1,$2) ON CONFLICT(rider_id) DO UPDATE SET stops=EXCLUDED.stops,revision=rider_dispatch_plans.revision+1,updated_at=now()`,
    [r.id,JSON.stringify([{shipmentId,kind:'pickup',latitude:P.latitude,longitude:P.longitude,weightG:1000},{shipmentId,kind:'dropoff',latitude:D.latitude,longitude:D.longitude,weightG:1000}])]);
   await db.query("INSERT INTO dispatch_offers(id,shipment_id,rider_id,status,pickup_eta_seconds,pickup_road_meters,direction,quoted_entitlement_minor,expires_at,accepted_at) VALUES($1,$2,$3,'accepted',60,500,'approaching',$4,now()+interval '1 minute',now()-make_interval(mins=>$5))",[randomUUID(),shipmentId,r.id,Number(s.amount_minor)-Number(s.commission_minor),acceptedMinutesAgo]);
   await db.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[shipmentId,r.id]);
  }
  const handover=(r,id,kind)=>api(r.token,'POST','/api/v1/shipments/'+id+'/handover',{kind,confirmed:true});
  async function delivered(r,id){assert.equal((await handover(r,id,'pickup')).status,200);const d=await handover(r,id,'delivery');assert.equal(d.status,200,JSON.stringify(d.data));}
  async function riderWithEarnings(){const r=await rider(),c=await signUp('customer');const s=await booked(c);await pay(c,s.id);await assign(r,s.id);await delivered(r,s.id);return {r,c,s};}
  const one=async(sql,params=[])=>(await db.query(sql,params)).rows[0];
  const count=async(sql,params=[])=>Number((await one(sql,params)).n);
  const accountNet=async(shipmentId,account)=>Number((await one(`SELECT coalesce(sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END),0)::bigint AS n FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE j.shipment_id=$1 AND l.account=$2`,[shipmentId,account])).n);
  /** Double-entry invariants checked after every scenario. */
  async function ledgerHolds(label){
   assert.deepEqual((await db.query(`SELECT j.id FROM checkout_accounting_journals j LEFT JOIN checkout_accounting_lines l ON l.journal_id=j.id GROUP BY j.id HAVING count(l.journal_id)<2 OR sum(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END)<>0`)).rows,[],label+': every shipment journal balances');
   assert.deepEqual((await db.query(`SELECT j.id FROM finance_journals j LEFT JOIN finance_lines l ON l.journal_id=j.id GROUP BY j.id HAVING count(l.journal_id)<2 OR sum(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END)<>0`)).rows,[],label+': every commission journal balances');
   assert.equal(await count('SELECT count(*)::int AS n FROM checkout_accounting_lines l WHERE NOT EXISTS(SELECT 1 FROM checkout_accounting_journals j WHERE j.id=l.journal_id)'),0,label+': no orphan shipment lines');
   assert.equal(await count('SELECT count(*)::int AS n FROM finance_lines l WHERE NOT EXISTS(SELECT 1 FROM finance_journals j WHERE j.id=l.journal_id)'),0,label+': no orphan commission lines');
   assert.deepEqual((await db.query(`SELECT j.shipment_id,l.account FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id WHERE l.account IN ('rider_payable','restaurant_payable','customer_refund_liability','customer_delivery_liability') GROUP BY j.shipment_id,l.account HAVING sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END)<0`)).rows,[],label+': no payable or liability goes negative');
   const report=await walletReconciliation(db);
   assert.deepEqual(report.anomalies.filter(a=>['critical','high'].includes(a.severity)).map(a=>a.code),[],label+': reconciliation finds no critical or high anomaly');
  }

  await t.test('duplicate concurrent payment callbacks over HTTP confirm once',async()=>{
   const c=await signUp('customer'),s=await booked(c);
   const intent=await checkout.initiate(c.actor,s.id,{idempotencyKey:'k'+randomUUID().replaceAll('-','')});
   psp.charges.set(intent.reference,{amountMinor:intent.amountMinor,eventId:'ev_'+randomUUID()});
   const hits=await Promise.all(Array.from({length:20},()=>api(null,'POST','/api/v1/payments/webhook',{reference:intent.reference})));
   assert.ok(hits.every(h=>h.status===200),JSON.stringify(hits.filter(h=>h.status!==200).slice(0,2)));
   assert.equal(hits.filter(h=>h.data?.status==='confirmed'&&h.data.duplicate===false).length,1,'one callback applies the payment');
   assert.equal(await count('SELECT count(*)::int AS n FROM checkout_confirmed_events WHERE shipment_id=$1',[s.id]),1);
   assert.equal(await count("SELECT count(*)::int AS n FROM checkout_accounting_journals WHERE shipment_id=$1 AND kind='psp_verified'",[s.id]),1);
   assert.equal(await count('SELECT count(*)::int AS n FROM checkout_unapplied_payments WHERE shipment_id=$1',[s.id]),0,'duplicates never become refund liabilities');
   assert.equal((await one('SELECT paid FROM shipments WHERE id=$1',[s.id])).paid,true);
   await ledgerHolds('duplicate callbacks');
  });

  await t.test('a callback arriving before the checkout response still confirms once',async()=>{
   const c=await signUp('customer'),s=await booked(c);
   let callback;
   psp.beforeCheckoutReturn=async x=>{psp.charges.set(x.reference,{amountMinor:x.amountMinor,eventId:'ev_'+randomUUID()});callback=await checkout.webhook(Buffer.from(JSON.stringify({reference:x.reference})),{});};
   try{
    const out=await checkout.initiate(c.actor,s.id,{idempotencyKey:'k'+randomUUID().replaceAll('-','')});
    assert.equal(callback.status,'confirmed');
    assert.equal(out.status,'confirmed','the late checkout response does not reopen a paid intent');
   }finally{psp.beforeCheckoutReturn=null;}
   assert.equal(await count("SELECT count(*)::int AS n FROM checkout_accounting_journals WHERE shipment_id=$1 AND kind='psp_verified'",[s.id]),1);
   await ledgerHolds('callback before response');
  });

  await t.test('success after checkout expiry is recovered while the order is still payable',async()=>{
   const c=await signUp('customer'),s=await booked(c);
   const intent=await checkout.initiate(c.actor,s.id,{idempotencyKey:'k'+randomUUID().replaceAll('-','')});
   await db.query("UPDATE shipment_checkout_intents SET submitted_at=now()-interval '2 hours',created_at=now()-interval '2 hours' WHERE id=$1",[intent.intentId]);
   await checkout.reconcileIntent(intent.intentId);
   assert.equal((await one('SELECT status FROM shipment_checkout_intents WHERE id=$1',[intent.intentId])).status,'expired');
   psp.charges.set(intent.reference,{amountMinor:intent.amountMinor,eventId:'ev_'+randomUUID()});
   const late=await checkout.reconcileIntent(intent.intentId);
   assert.equal(late.status,'confirmed');assert.equal(late.lateRecovery,true);
   assert.equal((await one('SELECT paid,state FROM shipments WHERE id=$1',[s.id])).state,'AWAITING_ASSIGNMENT');
   await ledgerHolds('late success');
  });

  await t.test('a late payment on a cancelled order is held for refund, never applied',async()=>{
   const c=await signUp('customer'),s=await booked(c);
   const intent=await checkout.initiate(c.actor,s.id,{idempotencyKey:'k'+randomUUID().replaceAll('-','')});
   await app.transition(c.actor,s.id,{action:'cancel',reason:'Changed my mind'});
   psp.charges.set(intent.reference,{amountMinor:intent.amountMinor,eventId:'ev_'+randomUUID()});
   const results=await Promise.all(Array.from({length:6},()=>checkout.webhook(Buffer.from(JSON.stringify({reference:intent.reference})),{})));
   assert.ok(results.every(r=>r.status==='refund_review'));
   assert.equal(results.filter(r=>!r.duplicate).length,1);
   const sh=await one('SELECT paid,state FROM shipments WHERE id=$1',[s.id]);
   assert.equal(sh.state,'CANCELLED');assert.equal(sh.paid,false);
   assert.equal(await accountNet(s.id,'customer_refund_liability'),intent.amountMinor);
   await money.syncRefunds();
   assert.equal(Number((await one("SELECT amount_minor FROM refund_operations WHERE shipment_id=$1 AND source_key LIKE 'unapplied:%'",[s.id])).amount_minor),intent.amountMinor);
   await ledgerHolds('late payment on cancelled order');
  });

  await t.test('one provider transaction ID cannot pay two orders',async()=>{
   const c=await signUp('customer'),a=await booked(c),b=await booked(c);
   const shared='ev_'+randomUUID();
   const first=await pay(c,a.id,{eventId:shared});assert.equal(first.result.status,'confirmed');
   await assert.rejects(pay(c,b.id,{eventId:shared}),/reused/);
   assert.equal((await one('SELECT paid FROM shipments WHERE id=$1',[b.id])).paid,false);
   await ledgerHolds('duplicate provider transaction');
  });

  await t.test('full and partial refunds settle once under concurrent confirmations',async()=>{
   const c=await signUp('customer');
   const full=await booked(c);const paidFull=await pay(c,full.id);
   await app.transition(c.actor,full.id,{action:'cancel',reason:'Changed my mind'});
   const r=await rider(),part=await booked(c);const paidPart=await pay(c,part.id);
   await assign(r,part.id,{acceptedMinutesAgo:10});
   const cancelled=await app.transition(c.actor,part.id,{action:'cancel',reason:'Changed my mind'});
   assert.ok(cancelled.cancellationFeeMinor>0,'a late cancellation pays the rider');
   await money.syncRefunds();
   await money.refundUncollectedOrders({limit:100});
   const ops=(await db.query("SELECT * FROM refund_operations WHERE shipment_id=ANY($1::uuid[]) AND source_key LIKE 'cancellation:%'",[[full.id,part.id]])).rows;
   const opFull=ops.find(o=>o.shipment_id===full.id),opPart=ops.find(o=>o.shipment_id===part.id);
   assert.equal(Number(opFull.amount_minor),paidFull.intent.amountMinor,'full refund includes the processing fee');
   assert.equal(Number(opPart.amount_minor),paidPart.intent.amountMinor-cancelled.cancellationFeeMinor,'partial refund keeps only the rider fee');
   assert.equal(psp.refundCalls.filter(x=>[opFull.id,opPart.id].includes(x.requestId)).length,2,'each refund is sent once');
   await money.refundUncollectedOrders({limit:100});
   assert.equal(psp.refundCalls.filter(x=>[opFull.id,opPart.id].includes(x.requestId)).length,2,'never resent');
   for(const op of [opFull,opPart]){
    const record={verified:true,status:'refunded',requestId:op.id,reference:op.reference,amountMinor:Number(op.amount_minor),currency:'GHS',providerId:'rf_'+op.id.slice(0,8),eventId:'refund:'+op.id};
    const results=await Promise.all(Array.from({length:10},()=>money.confirmRefund(record).catch(e=>({error:e.message}))));
    assert.equal(results.filter(x=>x.duplicate===false).length,1,'one confirmation applies');
    assert.ok(results.every(x=>x.status==='refunded'),JSON.stringify(results.find(x=>x.error)));
    assert.equal(await accountNet(op.shipment_id,'customer_refund_liability'),0);
   }
   assert.equal(await accountNet(part.id,'rider_payable'),cancelled.cancellationFeeMinor);
   await ledgerHolds('refunds');
  });

  await t.test('rider withdrawals: concurrent requests pay once; timeout after submission stays locked until verified',async()=>{
   const {r}=await riderWithEarnings();
   const before=await walletSummary(db,r.actor);
   const attempts=await Promise.allSettled(Array.from({length:6},(_,i)=>money.requestWithdrawal(r.actor,{idempotencyKey:'wd-'+i+'-'+randomUUID().slice(0,8),password:PASSWORD})));
   assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1,'only one withdrawal is created: '+JSON.stringify(attempts.map(a=>a.reason?.message)));
   assert.equal(await count('SELECT count(*)::int AS n FROM payout_withdrawals WHERE beneficiary_id=$1',[r.id]),1);
   const w=await one('SELECT * FROM payout_withdrawals WHERE beneficiary_id=$1',[r.id]);
   assert.equal(Number(w.amount_minor)+Number(w.fee_minor),before.availableNowMinor,'the whole available balance, minus the fee, is sent');
   psp.transfers.get(w.id).state='paid';
   await money.reconcileDue({olderThanSeconds:0});
   assert.equal((await one('SELECT status FROM payout_withdrawals WHERE id=$1',[w.id])).status,'paid');
   assert.equal(await count("SELECT count(*)::int AS n FROM checkout_accounting_journals WHERE kind='payout_completed' AND event_key LIKE '%'||$1",[w.id]),1);

   // Timeout after the provider took the transfer: the money is locked, then settled from the provider's answer.
   const t2=await riderWithEarnings();
   psp.onPayout=x=>{psp.transfers.set(x.requestId,{...x,state:'pending'});throw Object.assign(Error('SIMULATED provider timeout'),{code:'ETIMEDOUT'});};
   let out;try{out=await money.requestWithdrawal(t2.r.actor,{idempotencyKey:'wd-timeout-'+randomUUID().slice(0,8),password:PASSWORD});}finally{psp.onPayout=null;}
   assert.equal(out.status,'needs_review');
   assert.equal((await walletSummary(db,t2.r.actor)).availableNowMinor,0,'locked while the outcome is unknown');
   await assert.rejects(money.requestWithdrawal(t2.r.actor,{idempotencyKey:'wd-again-'+randomUUID().slice(0,8),password:PASSWORD}),/in progress|once a day/);
   const w2=await one('SELECT * FROM payout_withdrawals WHERE beneficiary_id=$1',[t2.r.id]);
   psp.transfers.get(w2.id).state='paid';
   await Promise.all([money.reconcileDue({olderThanSeconds:0}),money.reconcileDue({olderThanSeconds:0})]);
   assert.equal((await one('SELECT status FROM payout_withdrawals WHERE id=$1',[w2.id])).status,'paid');
   assert.equal(psp.payoutCalls.filter(x=>x.requestId===w2.id).length,1,'never sent twice');
   await ledgerHolds('withdrawals');
  });

  await t.test('payout retried after a crash, unknown transfers, failures, reversals and late payment after release',async()=>{
   // Crash after the withdrawal was saved but before the provider heard of it: the same reference is sent later.
   const a=await riderWithEarnings();
   psp.onPayout=()=>{throw Object.assign(Error('SIMULATED process crash before the request left'),{code:'ECONNRESET'});};
   try{await money.requestWithdrawal(a.r.actor,{idempotencyKey:'wd-crash-'+randomUUID().slice(0,8),password:PASSWORD});}finally{psp.onPayout=null;}
   const wa=await one('SELECT * FROM payout_withdrawals WHERE beneficiary_id=$1',[a.r.id]);
   await money.reconcileDue({olderThanSeconds:0});
   assert.equal(psp.payoutCalls.filter(x=>x.requestId===wa.id).length,1,'no resend straight away');
   await db.query("UPDATE payout_withdrawals SET updated_at=now()-interval '10 minutes',last_reconciled_at=NULL WHERE id=$1",[wa.id]);
   await money.reconcileDue({olderThanSeconds:0});
   const resent=psp.payoutCalls.filter(x=>x.requestId===wa.id);
   assert.equal(resent.length,2);assert.ok(resent.every(x=>x.requestId===wa.id&&x.idempotencyKey===wa.id),'the retry reuses the same provider reference');
   psp.transfers.get(wa.id).state='paid';
   await money.reconcileDue({olderThanSeconds:0});
   assert.equal((await one('SELECT status FROM payout_withdrawals WHERE id=$1',[wa.id])).status,'paid');

   // The provider never finds the transfer: flagged after a day, never released automatically.
   const b=await riderWithEarnings();
   psp.onPayout=()=>({providerId:null});
   try{await money.requestWithdrawal(b.r.actor,{idempotencyKey:'wd-unknown-'+randomUUID().slice(0,8),password:PASSWORD});}finally{psp.onPayout=null;}
   const wb=await one('SELECT * FROM payout_withdrawals WHERE beneficiary_id=$1',[b.r.id]);
   await db.query("UPDATE payout_withdrawals SET created_at=now()-interval '2 days',updated_at=now()-interval '10 minutes',last_reconciled_at=NULL WHERE id=$1",[wb.id]);
   psp.onPayout=()=>({providerId:null});
   try{await money.reconcileDue({olderThanSeconds:0});}finally{psp.onPayout=null;}
   const stuck=await one('SELECT status,stuck_flagged_at FROM payout_withdrawals WHERE id=$1',[wb.id]);
   assert.ok(['pending','needs_review','initiating'].includes(stuck.status),stuck.status);assert.ok(stuck.stuck_flagged_at,'flagged for staff');
   assert.equal((await walletSummary(db,b.r.actor)).availableNowMinor,0,'still locked');

   // Definitive failure returns the money; a later "paid" puts the account on hold.
   const f=await riderWithEarnings();
   await money.requestWithdrawal(f.r.actor,{idempotencyKey:'wd-fail-'+randomUUID().slice(0,8),password:PASSWORD});
   const wf=await one('SELECT * FROM payout_withdrawals WHERE beneficiary_id=$1',[f.r.id]);
   psp.transfers.get(wf.id).state='failed';
   await money.reconcileDue({olderThanSeconds:0});
   assert.equal((await one('SELECT status FROM payout_withdrawals WHERE id=$1',[wf.id])).status,'failed');
   assert.equal((await walletSummary(db,f.r.actor)).availableNowMinor,Number(wf.amount_minor)+Number(wf.fee_minor),'money is back in the balance');
   psp.transfers.get(wf.id).state='paid';
   const lateRecord=await provider.verifyPayout({requestId:wf.id});
   const late=await Promise.all([money.confirmPayout(lateRecord),money.confirmPayout(lateRecord)]);
   assert.ok(late.every(x=>x.status==='paid_after_release'));
   assert.equal(await count('SELECT count(*)::int AS n FROM payout_holds WHERE user_id=$1',[f.r.id]),1,'withdrawals are held so the money cannot leave twice');
   await assert.rejects(money.requestWithdrawal(f.r.actor,{idempotencyKey:'wd-after-'+randomUUID().slice(0,8),password:PASSWORD}),/on hold|once a day/);

   // A paid transfer the provider later reverses goes back on the ledger once.
   const v=await riderWithEarnings();
   await money.requestWithdrawal(v.r.actor,{idempotencyKey:'wd-rev-'+randomUUID().slice(0,8),password:PASSWORD});
   const wv=await one('SELECT * FROM payout_withdrawals WHERE beneficiary_id=$1',[v.r.id]);
   psp.transfers.get(wv.id).state='paid';await money.reconcileDue({olderThanSeconds:0});
   psp.transfers.get(wv.id).state='reversed';
   const rev=await provider.verifyPayout({requestId:wv.id});
   const reversed=await Promise.all([money.reverseWithdrawal(rev),money.reverseWithdrawal(rev).catch(e=>({error:e.message}))]);
   assert.equal(reversed.filter(x=>x.status==='reversed'&&x.duplicate===false).length,1);
   assert.equal(await count("SELECT count(*)::int AS n FROM checkout_accounting_journals WHERE kind='payout_reversed' AND event_key LIKE '%'||$1",[wv.id]),1);
   assert.equal(await accountNet(v.s.id,'rider_payable'),Number(wv.amount_minor)+Number(wv.fee_minor));
   await ledgerHolds('payout failures');
  });

  await t.test('refund and withdrawal racing on the same rider never spend money twice',async()=>{
   const {r,c}=await riderWithEarnings();
   const s=await booked(c);await pay(c,s.id);await assign(r,s.id,{acceptedMinutesAgo:10});
   const [cancel,withdrawal]=await Promise.allSettled([
    app.transition(c.actor,s.id,{action:'cancel',reason:'Changed my mind'}),
    money.requestWithdrawal(r.actor,{idempotencyKey:'wd-race-'+randomUUID().slice(0,8),password:PASSWORD})
   ]);
   assert.equal(cancel.status,'fulfilled',cancel.reason?.message);assert.equal(withdrawal.status,'fulfilled',withdrawal.reason?.message);
   const w=await one('SELECT * FROM payout_withdrawals WHERE beneficiary_id=$1',[r.id]);
   const inPayout=Number((await one('SELECT coalesce(sum(amount_minor),0)::bigint AS n FROM payout_operations WHERE withdrawal_id=$1',[w.id])).n);
   assert.equal(inPayout,Number(w.amount_minor)+Number(w.fee_minor));
   const credited=Number((await one(`SELECT coalesce(sum(CASE WHEN l.side='credit' THEN l.amount_minor ELSE -l.amount_minor END),0)::bigint AS n FROM checkout_accounting_lines l JOIN checkout_accounting_journals j ON j.id=l.journal_id JOIN shipments s ON s.id=j.shipment_id WHERE s.rider_id=$1 AND l.account='rider_payable'`,[r.id])).n);
   for(const op of (await db.query('SELECT shipment_id,amount_minor FROM payout_operations WHERE withdrawal_id=$1',[w.id])).rows)
    assert.ok(Number(op.amount_minor)<=await accountNet(op.shipment_id,'rider_payable'),'a withdrawal never takes more than a delivery earned');
   assert.equal(await count('SELECT count(*)::int AS n FROM (SELECT shipment_id FROM payout_operations WHERE withdrawal_id=$1 GROUP BY shipment_id HAVING count(*)>1) d',[w.id]),0,'no delivery is paid twice');
   const summary=await walletSummary(db,r.actor);
   assert.equal(summary.availableEarningsMinor,credited,'every pesewa is either in the withdrawal or still in the balance');
   assert.ok(summary.inPayoutMinor<=credited);
   await ledgerHolds('refund and withdrawal race');
  });

  await t.test('SMS-free handover: double taps and racing calls settle once; cash needs the full report',async()=>{
   // Digital: eight simultaneous delivery confirmations.
   const r=await rider(),c=await signUp('customer');
   const s=await booked(c);await pay(c,s.id);await assign(r,s.id);
   assert.equal((await handover(r,s.id,'pickup')).status,200);
   const taps=await Promise.all(Array.from({length:8},()=>handover(r,s.id,'delivery')));
   assert.ok(taps.every(x=>x.status===200),JSON.stringify(taps.map(x=>x.status)));
   assert.equal(taps.filter(x=>!x.data.duplicate).length,1,'one confirmation settles');
   assert.equal(await count('SELECT count(*)::int AS n FROM financial_entries WHERE shipment_id=$1',[s.id]),1);
   assert.equal(await count("SELECT count(*)::int AS n FROM checkout_accounting_journals WHERE shipment_id=$1 AND kind='delivery_completed'",[s.id]),1);
   assert.equal(await accountNet(s.id,'rider_payable'),Number(s.amount_minor)-Number(s.commission_minor));

   // Cash: partial report blocks completion; full report completes once and the commission becomes debt once.
   const cr=await rider(),cc=await signUp('customer');
   const cash=await booked(cc,'CASH');await assign(cr,cash.id);
   assert.equal((await handover(cr,cash.id,'pickup')).status,200);
   const report=(minor,key)=>api(cr.token,'POST','/api/v1/rider/cash-report',{shipmentId:cash.id,reportedMinor:minor,cashPayer:'recipient',idempotencyKey:key});
   assert.equal((await handover(cr,cash.id,'delivery')).status,409,'no completion without a cash report');
   const partialKey='cash-'+randomUUID().slice(0,8);
   const partial=await Promise.all([report(Number(cash.amount_minor)-100,partialKey),report(Number(cash.amount_minor),'cash-'+randomUUID().slice(0,8))]);
   assert.equal(await count('SELECT count(*)::int AS n FROM cash_collections WHERE shipment_id=$1',[cash.id]),1,'racing reports record one collection');
   const recorded=await one('SELECT reported_status FROM cash_collections WHERE shipment_id=$1',[cash.id]);
   const done=await Promise.all(Array.from({length:6},()=>handover(cr,cash.id,'delivery')));
   if(recorded.reported_status==='reported_full'){
    assert.ok(done.every(x=>x.status===200));
    assert.equal(done.filter(x=>!x.data.duplicate).length,1);
    assert.equal(await count("SELECT count(*)::int AS n FROM finance_journals WHERE shipment_id=$1 AND kind='cash_commission'",[cash.id]),1,'cash commission posted once');
    assert.equal(await count('SELECT count(*)::int AS n FROM commission_obligations WHERE shipment_id=$1',[cash.id]),1);
   }else{
    assert.ok(done.every(x=>x.status===409),'a partial cash report never completes a delivery');
    assert.equal(await count("SELECT count(*)::int AS n FROM finance_journals WHERE shipment_id=$1",[cash.id]),0);
   }
   assert.ok(partial.some(x=>x.status===200));
   await ledgerHolds('handover');
  });

  await t.test('SMS-free handover cannot complete unpaid, cancelled or returned shipments, nor race a cancellation',async()=>{
   const r=await rider(),c=await signUp('customer');
   const unpaid=await booked(c);
   await assert.rejects(db.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[unpaid.id,r.id]),/transition|requires/,'an unpaid digital order cannot reach a rider');
   assert.equal((await handover(r,unpaid.id,'delivery')).status,403);
   const cancelled=await booked(c);await pay(c,cancelled.id);await assign(r,cancelled.id);
   await app.transition(c.actor,cancelled.id,{action:'cancel',reason:'Changed my mind'});
   for(const kind of ['pickup','delivery'])assert.ok([403,409].includes((await handover(r,cancelled.id,kind)).status));
   // Pickup and cancellation at the same moment: exactly one wins and the books agree with it.
   for(let i=0;i<3;i++){
    const rr=await rider(),s=await booked(c);await pay(c,s.id);await assign(rr,s.id);
    const [pick,cancel]=await Promise.all([handover(rr,s.id,'pickup'),api(c.token,'POST','/api/v1/shipments/'+s.id+'/transition',{action:'cancel',reason:'Changed my mind'})]);
    const state=(await one('SELECT state FROM shipments WHERE id=$1',[s.id])).state;
    assert.equal([pick.status,cancel.status].filter(x=>x===200).length,1,JSON.stringify([pick,cancel]));
    if(state==='CANCELLED')assert.equal(await count('SELECT count(*)::int AS n FROM checkout_refund_requests WHERE shipment_id=$1',[s.id]),1);
    else{assert.equal(state,'PICKUP_VERIFIED');assert.equal(await count('SELECT count(*)::int AS n FROM checkout_refund_requests WHERE shipment_id=$1',[s.id]),0);}
   }
   // Returned parcel: settles once through the return path and can never be "delivered" afterwards.
   const rr=await rider(),s=await booked(c);await pay(c,s.id);await assign(rr,s.id);
   assert.equal((await handover(rr,s.id,'pickup')).status,200);
   await app.transition(rr.actor,s.id,{action:'fail',reason:'Recipient unreachable'});
   await app.transition(rr.actor,s.id,{action:'return',reason:'Returning to sender'});
   await app.transition(staff,s.id,{action:'returned',reason:'Back with sender'});
   assert.equal((await handover(rr,s.id,'delivery')).status,409);
   assert.equal(await count("SELECT count(*)::int AS n FROM checkout_accounting_journals WHERE shipment_id=$1 AND kind='delivery_completed'",[s.id]),1);
   await ledgerHolds('handover guards');
  });

  await t.test('concurrent commission recovery recovers each pesewa once',async()=>{
   const r=await rider(),c=await signUp('customer');
   const cash=await booked(c,'CASH');await assign(r,cash.id);
   assert.equal((await handover(r,cash.id,'pickup')).status,200);
   assert.equal((await api(r.token,'POST','/api/v1/rider/cash-report',{shipmentId:cash.id,reportedMinor:Number(cash.amount_minor),cashPayer:'recipient',idempotencyKey:'cash-'+randomUUID().slice(0,8)})).status,200);
   assert.equal((await handover(r,cash.id,'delivery')).status,200);
   const debt=Number(cash.commission_minor);assert.ok(debt>0);
   await updateWalletPolicy(db,staff,{autoRecoverFromEarnings:false,reason:'Audit: hold recovery to build a backlog'});
   let earnings=0;
   try{for(let i=0;i<2;i++){const s=await booked(c);await pay(c,s.id);await assign(r,s.id);await delivered(r,s.id);earnings+=Number(s.amount_minor)-Number(s.commission_minor);}}
   finally{await updateWalletPolicy(db,staff,{autoRecoverFromEarnings:true,reason:'Audit: restore automatic recovery'});}
   const results=await Promise.allSettled([...Array.from({length:8},()=>db.tx(x=>recoverDebtFromEarnings(x,r.id,{trigger:'scheduled_recovery'}))),runScheduledRecovery(db),runScheduledRecovery(db)]);
   const recovered=Number((await one('SELECT coalesce(sum(amount_minor),0)::bigint AS n FROM rider_debt_recoveries WHERE rider_id=$1',[r.id])).n);
   assert.equal(recovered,Math.min(debt,earnings),'recovered exactly once: '+JSON.stringify(results.filter(x=>x.status==='rejected').map(x=>x.reason?.message)));
   const w=await walletSummary(db,r.actor);
   assert.equal(w.outstandingDebtMinor,Math.max(0,debt-earnings));
   assert.equal(w.walletBalanceMinor,earnings-debt);
   await ledgerHolds('commission recovery');
  });

  await t.test('zero and negative balances never produce a withdrawal or a negative payable',async()=>{
   const r=await rider();
   await assert.rejects(money.requestWithdrawal(r.actor,{idempotencyKey:'wd-zero-'+randomUUID().slice(0,8),password:PASSWORD}),/at least/);
   assert.equal(await count('SELECT count(*)::int AS n FROM payout_withdrawals WHERE beneficiary_id=$1',[r.id]),0);
   // Commission at the 0% and 100% bounds still gives balanced books.
   const original=(await one("SELECT commission_bps FROM pricing_policies WHERE active AND vehicle='motorcycle'")).commission_bps;
   for(const bps of [0,10000,1301]){
    await app.configureCommission(staff,{vehicle:'motorcycle',commissionBps:bps});
    const rr=await rider(),c=await signUp('customer'),s=await booked(c);
    assert.ok(Number(s.commission_minor)>=0&&Number(s.commission_minor)<=Number(s.amount_minor));
    await pay(c,s.id);await assign(rr,s.id);await delivered(rr,s.id);
    assert.equal(await accountNet(s.id,'rider_payable'),Number(s.amount_minor)-Number(s.commission_minor));
    if(bps===10000)await assert.rejects(money.requestWithdrawal(rr.actor,{idempotencyKey:'wd-full-'+randomUUID().slice(0,8),password:PASSWORD}),/at least/);
   }
   await app.configureCommission(staff,{vehicle:'motorcycle',commissionBps:original});
   await ledgerHolds('zero and negative balances');
  });

  await t.test('prepaid food only, ELESEND-funded discounts never reduce the restaurant payout',async()=>{
   const owner=await signUp('business');
   const restaurantId=randomUUID(),itemId=randomUUID();
   await db.query("INSERT INTO restaurants(id,owner_id,name,phone,address,latitude,longitude,status) VALUES($1,$2,'Audit Kitchen','+233241112222','Audit Kitchen, Tetteh Quarshie',5.6221,-0.1735,'approved')",[restaurantId,owner.id]);
   await db.query("INSERT INTO menu_items(id,restaurant_id,name,price_minor) VALUES($1,$2,'Jollof platter',10000)",[itemId,restaurantId]);
   const c=await signUp('customer');
   const input=over=>({restaurantId,items:[{itemId,quantity:1,options:[]}],deliveryAddress:'Airport Residential, Accra',deliveryLatitude:5.615,deliveryLongitude:-0.179,customerPhone:'0241234567',...over});
   await assert.rejects(food.createFoodOrder(c.actor,input(),{paymentMethod:'CASH',idempotencyKey:randomUUID()}),/upfront|cash/i);
   const unpaid=await food.createFoodOrder(c.actor,input(),{paymentMethod:'MOMO',idempotencyKey:randomUUID()});
   assert.equal(await foodDispatchAllowed(db,unpaid.shipment_id),false,'unpaid food is never dispatched');
   await assert.rejects(food.acceptOrder(owner.actor,unpaid.id),/paid upfront/);
   await promotionEngine(db).createAdminCampaign(staff,{code:'AUDIT20',name:'Audit 20% off food',ownerType:'elesend',fundingType:'elesend_100',targetType:'food_subtotal',discountType:'percentage',discountBps:2000});
   const order=await food.createFoodOrder(c.actor,input({promoCode:'AUDIT20'}),{paymentMethod:'MOMO',idempotencyKey:randomUUID()});
   assert.equal(Number(order.elesend_funded_discount_minor),2000);
   const settlementPromised=Number(order.net_restaurant_settlement_minor);
   await pay(c,order.shipment_id);
   await food.acceptOrder(owner.actor,order.id,{estimatedPrepMinutes:15});
   await food.startPreparing(owner.actor,order.id);
   await food.markReadyForPickup(owner.actor,order.id);
   const r=await rider();await assign(r,order.shipment_id);await delivered(r,order.shipment_id);
   const commission=Number(order.food_commission_minor);
   assert.equal(await accountNet(order.shipment_id,'restaurant_payable'),10000-commission,'the restaurant is paid on the full menu price');
   assert.equal(settlementPromised,10000-commission);
   assert.equal(await accountNet(order.shipment_id,'platform_promotion_subsidy_expense'),-2000,'ELESEND carries the discount');
   const settled=await one('SELECT net_payable_minor FROM restaurant_settlements WHERE order_id=$1',[order.id]);
   assert.equal(Number(settled.net_payable_minor),10000-commission);
   assert.equal(await count("SELECT count(*)::int AS n FROM checkout_accounting_journals WHERE shipment_id=$1 AND kind='delivery_completed'",[order.shipment_id]),1,'one restaurant commission posting');
   await ledgerHolds('food');

   // Observation for the owner: a rider can declare pickup of food the kitchen has not marked ready.
   const early=await food.createFoodOrder(c.actor,input(),{paymentMethod:'MOMO',idempotencyKey:randomUUID()});
   await pay(c,early.shipment_id);await food.acceptOrder(owner.actor,early.id,{estimatedPrepMinutes:15});
   const er=await rider();await assign(er,early.shipment_id);
   const earlyPickup=await handover(er,early.shipment_id,'pickup');
   t.diagnostic('OBSERVATION unready food pickup (kitchen state ACCEPTED) returned HTTP '+earlyPickup.status);
  });

  await t.test('policy evidence: earnings hold and delivery commission overrides (owner decisions, not changed)',async()=>{
   // (a) The default deployment holds new digital earnings for WITHDRAWAL_EARNINGS_HOLD_HOURS (24 by default).
   const held=moneyOperations(db,{provider,earningsHoldHours:24});
   const {r}=await riderWithEarnings();
   process.env.WITHDRAWAL_EARNINGS_HOLD_HOURS='24';
   let w;try{w=await walletSummary(db,r.actor);}finally{process.env.WITHDRAWAL_EARNINGS_HOLD_HOURS='0';}
   t.diagnostic(`POLICY wallet after a fresh delivery: withdrawableMinor=${w.withdrawableMinor} availableNowMinor=${w.availableNowMinor} onHoldMinor=${w.onHoldMinor}`);
   assert.ok(w.withdrawableMinor>0);
   assert.equal(w.availableNowMinor,0,'fresh earnings are on hold, not immediately withdrawable');
   await assert.rejects(held.requestWithdrawal(r.actor,{idempotencyKey:'wd-hold-'+randomUUID().slice(0,8),password:PASSWORD,finalPayout:true}),/at least/);
   // (b) A delivery commission rule for this customer (contractual override) is stored but not used for pricing.
   const c=await signUp('business');
   await commissionEngine(db).createRule(staff,{name:'Audit merchant agreement',category:'merchant_delivery',scopeType:'merchant',scopeId:c.id,rateBps:500,reason:'Audit contractual override check'});
   const q=await app.quote(c.actor,{pickup:P,destination:D,vehicle:'motorcycle',recipientPhone:phone(),weightG:1000,description:'Documents',paymentMethod:'MOMO'});
   const policyBps=Number(q.pricingEvidence.commissionBps);
   t.diagnostic(`POLICY merchant override 500 bps; quote used ${policyBps} bps (commission ${q.commission_minor} of ${q.amount_minor})`);
  });
 }finally{
  if(previousHold===undefined)delete process.env.WITHDRAWAL_EARNINGS_HOLD_HOURS;else process.env.WITHDRAWAL_EARNINGS_HOLD_HOURS=previousHold;
  if(server)await new Promise(r=>server.close(r));
  await db.close();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.close();
 }
});
