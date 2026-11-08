import test from 'node:test';
import assert from 'node:assert/strict';
import {randomInt,randomUUID} from 'node:crypto';
const base=process.env.TEST_DATABASE_URL;
const ID=()=>randomUUID();
/**
 * Security audit, run over HTTP against a real PostgreSQL/PostGIS server in a database of its own.
 * SMS and the payment provider are fakes (labelled below); no live provider is contacted.
 */
test('security audit: object and function level authorization, SMS-free handover abuse',{skip:!base,timeout:600000},async t=>{
 assert.match(new URL(base).pathname,/^\/elesend_test/);
 const previous=process.env.NODE_ENV,previousLegacy=process.env.HANDOVER_SMS_LEGACY_ENABLED;
 process.env.NODE_ENV='production';process.env.HANDOVER_SMS_LEGACY_ENABLED='false';process.env.OTP_KEY??='d'.repeat(64);
 const {database}=await import('../services/api/db.mjs');
 const name='elesend_test_audit_security_'+randomInt(1e9);
 const root=database(base);await root.query(`CREATE DATABASE ${name}`);
 const url=new URL(base);url.pathname='/'+name;
 const db=database(url.toString());
 const {migrate}=await import('../scripts/migrate.mjs');
 const {platform}=await import('../services/api/platform.mjs');
 const {httpServer}=await import('../services/api/http.mjs');
 const {dispatchEngine}=await import('../services/api/dispatch.mjs');
 const {hash}=await import('../services/api/security.mjs');
 const {checkoutService,financeService,moneyOperations}=await import('../services/api/modules/payments/index.mjs');
 const {restaurantOrderService}=await import('../services/api/restaurant-orders.mjs');
 await migrate(db);
 // FAKE SMS gateway: records account codes in memory, sends nothing.
 const texts=[];const sms={async send(m){texts.push(m);return {accepted:true};},async sendNotification(m){texts.push(m);return {accepted:true};}};
 const meters=(a,b)=>Math.max(1,Math.round(Math.hypot((a.latitude-b.latitude)*111000,(a.longitude-b.longitude)*111000)));
 const routing={async route(a,b){const m=meters(a,b);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};},async matrix(o,d){return o.map(x=>{const m=meters(x,d);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};});}};
 const dispatch=dispatchEngine(db,{routing});
 // FAKE payment provider: no money moves; payments are confirmed through checkout.confirmVerified as a verified webhook would.
 const provider={name:'audit_fx',methods:['MOMO','CARD'],allowedCheckoutHosts:['checkout.test'],async createCheckout(x){return {reference:x.reference,checkoutUrl:'https://checkout.test/'+x.reference};},async verifyPayment(ref){return {verified:true,status:'pending',reference:ref};},commissionIntentId:()=>null,async parseVerifiedWebhook(){return null;},async createPayout(x){return {providerId:'po_'+x.requestId};},async verifyPayout(){return {verified:true,status:'pending'};}};
 const app=platform(db,{otpKey:process.env.OTP_KEY,routing,dispatch,sms});
 const checkout=checkoutService(db,{provider,sms,dispatch,routing});
 const restaurantOrders=restaurantOrderService(db,{platform:app,dispatcher:dispatch,routing,sms});
 const server=httpServer(db,app,dispatch,financeService(db,{provider}),checkout,{restaurantOrders,moneyOperations:moneyOperations(db,{provider})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const host='http://127.0.0.1:'+server.address().port;
 const api=async(token,method,path,body,headers={})=>{const res=await fetch(host+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json().catch(()=>null)};};
 const phone=()=>'+23324'+String(randomInt(0,10000000)).padStart(7,'0');
 const P={address:'Accra Mall, Tetteh Quarshie',latitude:5.6221,longitude:-0.1735},D={address:'Osu Oxford Street, Accra',latitude:5.5571,longitude:-0.1817};
 const trip=(over={})=>({pickup:P,destination:D,vehicle:'motorcycle',recipientPhone:phone(),weightG:1000,description:'Documents',paymentMethod:'MOMO',...over});
 async function signUp(kind,extra={}){
  const number=phone();
  assert.equal((await api(null,'POST','/api/v1/auth/register',{phone:number,password:'mango river lantern',kind,...extra})).status,201);
  const login=await api(null,'POST','/api/v1/auth/login',{phone:number,password:'mango river lantern'});assert.equal(login.status,200);
  await db.query('UPDATE users SET phone_verified_at=now() WHERE id=$1',[login.data.user.id]);
  return {number,token:login.data.token,id:login.data.user.id};
 }
 const customer=()=>signUp('customer');
 const gps=(r,at=P)=>api(r.token,'POST','/api/v1/rider/location',{latitude:at.latitude,longitude:at.longitude,accuracyMeters:15,observedAt:new Date().toISOString()});
 async function readyRider(){const r=await signUp('rider',{vehicle:'motorcycle',maxWeightG:20000});await db.query("UPDATE riders SET status='approved' WHERE id=$1",[r.id]);assert.equal((await api(r.token,'POST','/api/v1/rider/availability',{online:true})).status,200);assert.equal((await gps(r)).status,200);return r;}
 const offline=()=>db.query('UPDATE riders SET online=false');
 async function staff(permissions=[]){
  const id=ID(),token=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
  await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'test-only','admin',now())",[id,phone()]);
  for(const p of permissions)await db.query('INSERT INTO permissions(user_id,permission) VALUES($1,$2)',[id,p]);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at,admin_mfa_verified,last_seen_at) VALUES($1,$2,now()+interval '1 hour',true,now())",[hash(token),id]);
  return {id,token};
 }
 async function paidOrder(c,over){
  const q=await api(c.token,'POST','/api/v1/quotes',trip(over));assert.equal(q.status,200,JSON.stringify(q.data));
  const key='sec-'+randomInt(1e9);
  const s=await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':key});assert.equal(s.status,200);
  const pay=await api(c.token,'POST','/api/v1/shipments/'+s.data.id+'/checkout',{idempotencyKey:key,email:'owner@example.com'});assert.equal(pay.status,200,JSON.stringify(pay.data));
  const row=(await db.query('SELECT amount_minor FROM shipment_checkout_intents WHERE reference=$1',[pay.data.reference])).rows[0];
  await checkout.confirmVerified({status:'success',reference:pay.data.reference,amountMinor:Number(row.amount_minor),currency:'GHS',eventId:'ev'+randomInt(1e9),channel:'mobile_money'});
  return s.data.id;
 }
 const offerFor=async(r,id)=>(await api(r.token,'GET','/api/v1/rider/offers')).data.find(o=>o.id===id);
 async function assigned(c,r,over){await offline();await db.query('UPDATE riders SET online=true WHERE id=$1',[r.id]);const id=await paidOrder(c,over);await dispatch.tick();const o=await offerFor(r,id);assert.ok(o,'offer');assert.equal((await api(r.token,'POST','/api/v1/shipments/'+id+'/accept',{offerId:o.offerId})).status,200);return id;}
 const refused=(res,label)=>assert.ok([403,404].includes(res.status),`${label}: expected 403/404, got ${res.status} ${JSON.stringify(res.data)}`);
 try{
  await t.test('BOLA: other customers, riders, businesses and companies cannot read or act on a shipment',async()=>{
   const c=await customer(),r=await readyRider();
   const sid=await assigned(c,r);
   const conv=await api(c.token,'POST','/api/v1/chat/conversations',{conversationType:'CUSTOMER_RIDER',shipmentId:sid});assert.equal(conv.status,200,JSON.stringify(conv.data));
   const msg=await api(c.token,'POST','/api/v1/chat/conversations/'+conv.data.id+'/messages',{bodyText:'Gate is blue',clientMessageId:ID()});assert.equal(msg.status,200,JSON.stringify(msg.data));
   const outsiders={customer:await customer(),rider:await readyRider(),business:await signUp('business'),company:await signUp('company',{name:'Other Logistics',services:['delivery','riders']})};
   await db.query("UPDATE companies SET status='approved' WHERE owner_id=$1",[outsiders.company.id]);
   const S='/api/v1/shipments/'+sid,C='/api/v1/chat/conversations/'+conv.data.id;
   const probes=[
    ['GET',S],['GET',S+'/tracking'],['GET',S+'/cancel-terms'],['GET',S+'/dispatch'],['GET',S+'/rider-photo'],['GET',S+'/checkout'],['GET',S+'/unmapped-navigation'],
    ['POST',S+'/checkout',{idempotencyKey:'steal-'+randomInt(1e9),email:'x@example.com'}],
    ['POST',S+'/transition',{action:'cancel',reason:'Not mine to cancel'}],['POST',S+'/transition',{action:'fail',reason:'Not my parcel'}],
    ['POST',S+'/recipient',{recipientPhone:phone()}],
    ['POST',S+'/disputes',{category:'other',detail:'Probing someone else'}],
    ['POST',S+'/location',{latitude:5.6,longitude:-0.18}],
    ['POST',S+'/handover',{kind:'pickup',confirmed:true}],['POST',S+'/handover',{kind:'delivery',confirmed:true}],
    ['POST',S+'/receipt',{received:true}],
    ['POST',S+'/accept',{offerId:ID()}],
    ['POST','/api/v1/rider/navigation',{shipmentId:sid,latitude:5.6,longitude:-0.18}],
    ['POST','/api/v1/rider/assignments/release',{shipmentId:sid,reason:'Not my job at all'}],
    ['POST','/api/v1/rider/cash-report',{shipmentId:sid,reportedMinor:0,cashPayer:'recipient',idempotencyKey:'cash-'+randomInt(1e9)}],
    ['GET','/api/v1/public-track/'+sid],
    ['POST','/api/v1/chat/conversations',{conversationType:'CUSTOMER_RIDER',shipmentId:sid}],
    ['GET',C+'/messages'],['POST',C+'/messages',{bodyText:'Intruder',clientMessageId:ID()}],
    ['POST',C+'/voice-notes',{clientMessageId:ID(),durationSeconds:2,audioBase64:Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypM4A '),Buffer.alloc(64)]).toString('base64')}],
    ['GET',C+'/messages/'+msg.data.id+'/audio'],['POST',C+'/read',{upToSeq:1}],['POST',C+'/delivered',{upToSeq:1}],['POST',C+'/typing',{isTyping:true}],
    ['POST',C+'/mute',{muted:true}],['POST',C+'/report',{reason:'harassment',detail:'Probing someone else chat'}],['POST',C+'/escalate',{reason:'Probing someone else chat'}]
   ];
   const seen=[];
   for(const [who,o] of Object.entries(outsiders))for(const [m,p,b] of probes){
    const res=await api(o.token,m,p,b);seen.push(`${who} ${m} ${p.replace(sid,':sid').replace(conv.data.id,':conv')} -> ${res.status}`);
    if(m==='GET'&&p.startsWith('/api/v1/public-track'))assert.equal(res.status,404,`${who} public-track with raw id`);else refused(res,`${who} ${m} ${p}`);
   }
   t.diagnostic(seen.join('\n'));
   const row=(await db.query('SELECT state,rider_id,recipient_phone FROM shipments WHERE id=$1',[sid])).rows[0];
   assert.equal(row.state,'RIDER_ASSIGNED');assert.equal(row.rider_id,r.id);
   assert.equal((await db.query('SELECT count(*)::int n FROM shipment_handover_events WHERE shipment_id=$1',[sid])).rows[0].n,0);
   await api(c.token,'POST',S+'/transition',{action:'cancel',reason:'Audit finished'});
  });
  await t.test('handover: a released or replaced rider cannot declare custody, and API keys cannot either',async()=>{
   const c=await customer(),r=await readyRider(),r2=await readyRider();
   const sid=await assigned(c,r);
   assert.equal((await api(r.token,'POST','/api/v1/rider/assignments/release',{shipmentId:sid,reason:'Bike broke down'})).status,200);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+sid+'/handover',{kind:'pickup',confirmed:true})).status,403,'released rider');
   await db.query('UPDATE riders SET online=false WHERE id=$1',[r.id]);await db.query('UPDATE riders SET online=true WHERE id=$1',[r2.id]);
   await db.query('UPDATE shipments SET next_dispatch_at=now() WHERE id=$1',[sid]);await dispatch.tick();
   const o=await offerFor(r2,sid);assert.ok(o,'new rider offered');assert.equal((await api(r2.token,'POST','/api/v1/shipments/'+sid+'/accept',{offerId:o.offerId})).status,200);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+sid+'/handover',{kind:'pickup',confirmed:true})).status,403,'old rider after reassignment');
   const b=await signUp('business');const k=await api(b.token,'POST','/api/v1/business/api-keys',{name:'Shop',scopes:['shipments:read','shipments:write','quotes:write','payments:write']});assert.equal(k.status,200,JSON.stringify(k.data));
   for(const [p,body] of [['/handover',{kind:'pickup',confirmed:true}],['/receipt',{received:true}]])assert.equal((await api(k.data.key,'POST','/api/v1/shipments/'+sid+p,body)).status,403,'API key '+p);
   assert.equal((await api(r2.token,'POST','/api/v1/shipments/'+sid+'/handover',{kind:'pickup',confirmed:true})).status,200);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+sid+'/handover',{kind:'delivery',confirmed:true})).status,403);
   const ev=(await db.query("SELECT rider_id FROM shipment_handover_events WHERE shipment_id=$1",[sid])).rows;assert.deepEqual(ev.map(e=>e.rider_id),[r2.id]);
   await offline();
  });
  await t.test('handover evidence: no GPS stays empty, stale GPS keeps its real time, nothing claims recipient receipt',async()=>{
   const c=await customer(),r=await readyRider();
   const sid=await assigned(c,r);
   const old=new Date(Date.now()-3*3600*1000);
   await db.query('UPDATE riders SET position_at=$2 WHERE id=$1',[r.id,old]);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+sid+'/handover',{kind:'pickup',confirmed:true})).status,200);
   const pick=(await db.query("SELECT position IS NOT NULL AS has,position_at,confirmed_at FROM shipment_handover_events WHERE shipment_id=$1 AND kind='pickup'",[sid])).rows[0];
   assert.equal(pick.has,true);assert.equal(new Date(pick.position_at).getTime(),old.getTime(),'stale fix keeps its own time, not the confirmation time');
   assert.ok(Math.abs(new Date(pick.confirmed_at).getTime()-Date.now())<60000,'confirmation time is the server clock');
   await db.query('UPDATE riders SET current_position=NULL,position_at=NULL,position_accuracy_m=NULL WHERE id=$1',[r.id]);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+sid+'/handover',{kind:'delivery',confirmed:true})).status,200);
   const drop=(await db.query("SELECT position,position_at,accuracy_m FROM shipment_handover_events WHERE shipment_id=$1 AND kind='delivery'",[sid])).rows[0];
   assert.deepEqual([drop.position,drop.position_at,drop.accuracy_m],[null,null,null],'missing GPS is never filled in');
   const seen=(await api(c.token,'GET','/api/v1/shipments/'+sid)).data;
   assert.equal(seen.receipt_confirmed_at,null,'a rider declaration is not a customer receipt');assert.ok(seen.rider_reported_at);
   await assert.rejects(db.query("UPDATE shipment_handover_events SET position_at=now() WHERE shipment_id=$1",[sid]),'evidence cannot be rewritten');
  });
  await t.test('race: concurrent delivery declarations and receipts settle exactly once',async()=>{
   const c=await customer(),r=await readyRider();
   const sid=await assigned(c,r);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+sid+'/receipt',{received:true})).status,403);
   assert.equal((await api(c.token,'POST','/api/v1/shipments/'+sid+'/receipt',{received:true})).status,409,'no receipt before delivery is reported');
   const pickups=await Promise.all(Array.from({length:8},()=>api(r.token,'POST','/api/v1/shipments/'+sid+'/handover',{kind:'pickup',confirmed:true})));
   assert.equal(pickups.filter(x=>x.status===200&&!x.data.duplicate).length,1,JSON.stringify(pickups.map(x=>x.status)));
   const drops=await Promise.all(Array.from({length:12},()=>api(r.token,'POST','/api/v1/shipments/'+sid+'/handover',{kind:'delivery',confirmed:true})));
   assert.equal(drops.filter(x=>x.status===200&&!x.data.duplicate).length,1,JSON.stringify(drops.map(x=>[x.status,x.data])));
   assert.ok(drops.every(x=>x.status===200),JSON.stringify(drops.map(x=>[x.status,x.data])));
   assert.equal((await db.query('SELECT count(*)::int n FROM financial_entries WHERE shipment_id=$1',[sid])).rows[0].n,1);
   assert.equal((await db.query("SELECT count(*)::int n FROM checkout_accounting_journals WHERE shipment_id=$1 AND kind='delivery_completed'",[sid])).rows[0].n,1);
   const receipts=await Promise.all(Array.from({length:8},()=>api(c.token,'POST','/api/v1/shipments/'+sid+'/receipt',{received:true})));
   assert.ok(receipts.every(x=>x.status===200),JSON.stringify(receipts.map(x=>x.status)));
   assert.equal(receipts.filter(x=>!x.data.duplicate).length,1);
   assert.equal((await db.query('SELECT count(*)::int n FROM shipment_receipt_confirmations WHERE shipment_id=$1',[sid])).rows[0].n,1);
  });
  await t.test('handover: a suspended rider can finish the parcel in custody without SMS, and take nothing new',async()=>{
   const c=await customer(),r=await readyRider();
   const sid=await assigned(c,r);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+sid+'/handover',{kind:'pickup',confirmed:true})).status,200);
   await db.query("UPDATE riders SET status='suspended',online=false WHERE id=$1",[r.id]);
   assert.equal((await api(r.token,'GET','/api/v1/me')).data.custodyOnly,true);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+sid+'/delivery-challenge',{})).status,410,'legacy SMS is off in production');
   const done=await api(r.token,'POST','/api/v1/shipments/'+sid+'/handover',{kind:'delivery',confirmed:true});
   assert.equal(done.status,200,'the parcel in custody can be delivered: '+JSON.stringify(done.data));
   assert.equal((await db.query('SELECT state FROM shipments WHERE id=$1',[sid])).rows[0].state,'COMPLETED');
   assert.equal((await api(r.token,'GET','/api/v1/me')).status,403,'locked out once delivered');
  });
  await t.test('handover: a suspended rider cannot declare pickup of a parcel not yet in custody',async()=>{
   const c=await customer(),r=await readyRider();
   const held=await assigned(c,r);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+held+'/handover',{kind:'pickup',confirmed:true})).status,200);
   // A second parcel assigned before the suspension, still at its pickup point.
   const c2=await customer();const q=await api(c2.token,'POST','/api/v1/quotes',trip({paymentMethod:'CASH'}));const b2=await api(c2.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':'susp2-'+randomInt(1e9)});assert.equal(b2.status,200);
   const waiting=b2.data.id;
   await db.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[waiting,r.id]);
   await db.query('DELETE FROM rider_dispatch_plans WHERE rider_id=$1',[r.id]);
   await db.query("UPDATE riders SET status='suspended',online=false WHERE id=$1",[r.id]);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+waiting+'/handover',{kind:'pickup',confirmed:true})).status,403,'no new custody while suspended');
   assert.equal((await db.query('SELECT state FROM shipments WHERE id=$1',[waiting])).rows[0].state,'RIDER_ASSIGNED');
  });
  await t.test('function level: an administrator without the needed permission is refused on every admin route',async()=>{
   const bare=await staff([]),cust=await customer();
   const U=ID();
   const routes=[['GET','/api/v1/admin/algorithm-features'],['GET','/api/v1/admin/chat/policy'],['GET','/api/v1/admin/chat/support-queue'],['GET','/api/v1/admin/commission/audit-logs'],['GET','/api/v1/admin/commission/restaurant-settings'],['GET','/api/v1/admin/commission/rules'],['GET','/api/v1/admin/custody-incidents'],['GET','/api/v1/admin/dispatch-policy'],['GET','/api/v1/admin/dispatch/exceptions'],['GET','/api/v1/admin/eta/accuracy'],['GET','/api/v1/admin/finance/adjustments'],['GET','/api/v1/admin/finance/aging'],['GET','/api/v1/admin/finance/settlement-exceptions'],['GET','/api/v1/admin/finance/wallet-overview'],['GET','/api/v1/admin/finance/wallet-policy'],['GET','/api/v1/admin/finance/reconciliation'],['GET','/api/v1/admin/fleet-batch-preview'],['GET','/api/v1/admin/geo-intelligence/dashboard'],['GET','/api/v1/admin/geo-intelligence/review-queue'],['GET','/api/v1/admin/markets'],['GET','/api/v1/admin/payments/exceptions'],['GET','/api/v1/admin/payments/methods'],['GET','/api/v1/admin/payments/operation-exceptions'],['GET','/api/v1/admin/payments/payouts'],['GET','/api/v1/admin/payments/refunds'],['GET','/api/v1/admin/payments/withdrawals'],['GET','/api/v1/admin/disputes'],['GET','/api/v1/admin/pricing'],['GET','/api/v1/admin/pricing/tolls'],['GET','/api/v1/admin/promotions'],['GET','/api/v1/admin/restaurants'],['GET','/api/v1/admin/review'],['GET','/api/v1/admin/rider-settlements'],['GET','/api/v1/admin/rider-settlements/settings'],['GET','/api/v1/admin/risk-signals'],['GET','/api/v1/admin/safety-alerts'],['GET','/api/v1/admin/system-health'],['GET','/api/v1/admin/vehicle-policy'],['GET','/api/v1/admin/shipments/'+U+'/eta'],['GET','/api/v1/admin/riders/'+U+'/documents/profile_photo'],
    ['POST','/api/v1/admin/algorithm-features'],['POST','/api/v1/admin/chat/policy'],['POST','/api/v1/admin/commission/founding-rider'],['POST','/api/v1/admin/commission/restaurant-settings'],['POST','/api/v1/admin/commission/rules'],['POST','/api/v1/admin/dispatch-policy'],['POST','/api/v1/admin/dispatch/watchdog'],['POST','/api/v1/admin/finance/adjustments'],['POST','/api/v1/admin/finance/wallet-policy'],['POST','/api/v1/admin/finance/reconciliation',{repair:true}],['POST','/api/v1/admin/geo-intelligence/publish-landmark'],['POST','/api/v1/admin/geo-intelligence/publish-road'],['POST','/api/v1/admin/geo-intelligence/reject'],['POST','/api/v1/admin/geo-intelligence/road-details'],['POST','/api/v1/admin/geo-intelligence/rollback-landmark'],['POST','/api/v1/admin/geo-intelligence/rollback-road'],['POST','/api/v1/admin/markets/activate'],['POST','/api/v1/admin/markets/stage'],['POST','/api/v1/admin/payments/methods'],['POST','/api/v1/admin/payments/payouts'],['POST','/api/v1/admin/pricing'],['POST','/api/v1/admin/pricing/commission'],['POST','/api/v1/admin/pricing/surge-zones'],['POST','/api/v1/admin/pricing/tolls'],['POST','/api/v1/admin/pricing/vehicles'],['POST','/api/v1/admin/promotions'],['POST','/api/v1/admin/reward-campaigns'],['POST','/api/v1/admin/rider-settlements/reconcile'],['POST','/api/v1/admin/rider-settlements/settings'],['POST','/api/v1/admin/risk-signals/review'],['POST','/api/v1/admin/vehicle-policy'],
    ['POST','/api/v1/admin/riders/'+U,{status:'approved'}],['POST','/api/v1/admin/companies/'+U,{status:'approved'}],['POST','/api/v1/admin/disputes/'+U+'/resolve'],['POST','/api/v1/admin/chat/abuse-reports/'+U+'/moderate'],['POST','/api/v1/admin/commission/rules/'+U+'/pause'],['POST','/api/v1/admin/commission/rules/'+U+'/revoke'],['POST','/api/v1/admin/custody-incidents/'+U+'/resolve'],['POST','/api/v1/admin/finance/adjustments/'+U+'/approve'],['POST','/api/v1/admin/finance/riders/'+U+'/policy'],['POST','/api/v1/admin/payments/payouts/'+U+'/approve'],['POST','/api/v1/admin/payments/refunds/'+U+'/submit'],['POST','/api/v1/admin/payments/withdrawals/'+U+'/release-unsent'],['POST','/api/v1/admin/pricing/tolls/'+U+'/retire'],['POST','/api/v1/admin/promotions/'+U+'/status'],['POST','/api/v1/admin/restaurants/'+U+'/commission-agreement'],['POST','/api/v1/admin/riders/'+U+'/documents/profile_photo/reject'],['POST','/api/v1/admin/riders/'+U+'/licence/reject'],['POST','/api/v1/admin/safety-alerts/'+U+'/resolve'],['POST','/api/v1/admin/vehicles/'+U+'/review']];
   const out=[],open=[];
   for(const [m,p,b] of routes){
    const res=await api(bare.token,m,p,b??(m==='POST'?{}:undefined));out.push(`${m} ${p.replace(U,':id')} -> ${res.status}`);
    if(res.status<300)open.push(`${m} ${p} ${JSON.stringify(res.data).slice(0,120)}`);
    assert.equal((await api(cust.token,m,p,b??(m==='POST'?{}:undefined))).status,403,'customer '+p);
   }
   t.diagnostic(out.join('\n'));
   assert.deepEqual(open,[],'admin routes answered without the needed permission');
  });
  await t.test('BOLA: restaurants, menus and food orders belong to their owner and customer',async()=>{
   const owner=await signUp('business'),rival=await signUp('business'),c=await customer(),c2=await customer(),r=await readyRider();
   const made=await api(owner.token,'POST','/api/v1/restaurants',{name:'Audit Kitchen '+randomInt(1e6),phone:'0241234567',address:'Oxford Street, Osu',latitude:P.latitude,longitude:P.longitude});assert.equal(made.status,200);
   const R='/api/v1/restaurants/'+made.data.id;
   const cat=await api(owner.token,'POST',R+'/categories',{name:'Mains'});const item=await api(owner.token,'POST',R+'/items',{name:'Jollof',priceMinor:4000,categoryId:cat.data.id});
   const mod=await api(owner.token,'POST',R+'/items/'+item.data.id+'/modifiers',{name:'Size'});assert.equal(mod.status,200,JSON.stringify(mod.data));
   await db.query("UPDATE restaurants SET status='approved' WHERE id=$1",[made.data.id]);await db.query("UPDATE checkout_method_policies SET enabled=true WHERE method='MOMO'");
   const rivalMade=await api(rival.token,'POST','/api/v1/restaurants',{name:'Rival Kitchen '+randomInt(1e6),phone:'0241234568',address:'Ring Road, Accra',latitude:P.latitude,longitude:P.longitude});
   const RR='/api/v1/restaurants/'+rivalMade.data.id;
   const order=await restaurantOrders.createFoodOrder({id:c.id,kind:'customer'},{restaurantId:made.data.id,items:[{itemId:item.data.id,quantity:1,options:[]}],deliveryAddress:D.address,deliveryLatitude:D.latitude,deliveryLongitude:D.longitude,customerPhone:'0241234567'},{paymentMethod:'MOMO',idempotencyKey:ID()});
   const F='/api/v1/food-orders/'+order.id;
   const probes=[[rival,'POST',R,{isOpen:false}],[rival,'POST',R,{imageUrl:'https://example.com/x.png'}],[rival,'POST',R+'/categories',{name:'Hijack'}],[rival,'POST',R+'/categories/'+cat.data.id,{name:'Hijack'}],[rival,'POST',RR+'/categories/'+cat.data.id,{name:'Hijack'}],[rival,'POST',R+'/categories/'+cat.data.id+'/delete',{}],
    [rival,'POST',R+'/items',{name:'Fake',priceMinor:1}],[rival,'POST',R+'/items/'+item.data.id,{priceMinor:1}],[rival,'POST',RR+'/items/'+item.data.id,{priceMinor:1}],[rival,'POST',R+'/items/'+item.data.id+'/delete',{}],[rival,'POST',RR+'/items/'+item.data.id+'/modifiers',{name:'X'}],[rival,'POST',RR+'/modifiers/'+mod.data.id+'/options',{name:'X'}],[rival,'POST',R+'/modifiers/'+mod.data.id+'/options',{name:'X'}],
    [rival,'GET',R+'/settlements'],[rival,'POST',R+'/batch-dispatch',{}],[rival,'GET',R+'/promotions'],[rival,'POST',R+'/promotions/preview',{}],[rival,'GET',R+'/promotions/analytics'],[rival,'POST',R+'/commission-preview',{subtotalMinor:1000}],
    [c2,'GET',F],[rival,'GET',F],[r,'GET',F],[c2,'POST',F+'/cancel',{}],[rival,'POST',F+'/accept',{}],[rival,'POST',F+'/reject',{reason:'Nope'}],[rival,'POST',F+'/prepare',{}],[rival,'POST',F+'/ready',{}],[c2,'POST',F+'/resolve',{action:'cancel_refund',reason:'Not mine'}],[rival,'POST',F+'/resolve',{action:'cancel_refund',reason:'Not mine'}],
    [c2,'POST','/api/v1/chat/conversations',{conversationType:'CUSTOMER_RESTAURANT',foodOrderId:order.id}]];
   const seen=[];
   for(const [who,m,p,b] of probes){const res=await api(who.token,m,p,b);seen.push(`${m} ${p} -> ${res.status}`);refused(res,`${m} ${p}`);}
   t.diagnostic(seen.join('\n'));
   const it=(await db.query('SELECT price_minor FROM menu_items WHERE id=$1',[item.data.id])).rows[0];assert.equal(it.price_minor,4000);
   assert.equal((await db.query('SELECT state FROM food_orders WHERE id=$1',[order.id])).rows[0].state,'SUBMITTED');
  });
  await t.test('BOLA: companies, invitations, API keys, temporary references and wallet intents',async()=>{
   const co1=await signUp('company',{name:'First Fleet',services:['riders','delivery']}),co2=await signUp('company',{name:'Second Fleet',services:['riders','delivery']});
   await db.query("UPDATE companies SET status='approved' WHERE owner_id=ANY($1::uuid[])",[[co1.id,co2.id]]);
   const r=await readyRider(),r2=await readyRider();
   const inv=await api(co1.token,'POST','/api/v1/company/invitations',{phone:r.number});assert.equal(inv.status,200,JSON.stringify(inv.data));
   const invId=inv.data.id??inv.data.invitationId??(await db.query('SELECT id FROM company_rider_invitations WHERE rider_id=$1 ORDER BY created_at DESC LIMIT 1',[r.id]).catch(()=>({rows:[]}))).rows[0]?.id;
   const b1=await signUp('business'),b2=await signUp('business');
   const key=await api(b1.token,'POST','/api/v1/business/api-keys',{name:'Shop',scopes:['shipments:read']});assert.equal(key.status,200);
   const keyId=key.data.id??(await db.query('SELECT id FROM api_clients WHERE owner_id=$1',[b1.id])).rows[0].id;
   const c=await customer(),c2=await customer();
   const ref=await api(c.token,'POST','/api/v1/maps/egia/temporary-reference',{latitude:5.6,longitude:-0.18,description:'Blue gate behind the church',accuracyM:10,pinConfirmed:true});
   const probes=[[co2,'POST','/api/v1/company/riders/'+r.id+'/remove',{}],[co2,'POST','/api/v1/company/riders/'+r.id+'/approve',{}],[co2,'GET','/api/v1/company/riders/'+r.id+'/photo'],
    ...(invId?[[co2,'POST','/api/v1/company/invitations/'+invId+'/revoke',{}],[r2,'POST','/api/v1/rider/invitations/'+invId+'/decline',{}]]:[]),
    [b2,'POST','/api/v1/business/api-keys/'+keyId+'/revoke',{}],
    ...(ref.status===200?[[c2,'GET','/api/v1/maps/egia/temporary-reference/'+ref.data.id],[r2,'GET','/api/v1/maps/egia/temporary-reference/'+ref.data.id]]:[]),
    [r2,'GET','/api/v1/rider/wallet/topups/'+ID()],[r2,'GET','/api/v1/rider/commissions/payments/'+ID()]];
   const seen=[`invitation id ${invId?'found':'missing'}; temporary reference ${ref.status} ${JSON.stringify(ref.data).slice(0,100)}`];
   for(const [who,m,p,b] of probes){const res=await api(who.token,m,p,b);seen.push(`${m} ${p} -> ${res.status}`);refused(res,`${m} ${p}`);}
   t.diagnostic(seen.join('\n'));
   assert.equal((await db.query('SELECT revoked_at FROM api_clients WHERE id=$1',[keyId])).rows[0].revoked_at,null);
  });
  await t.test('injection: hostile text in search and filters is data, not SQL',async()=>{
   const c=await customer();
   for(const q of ["' OR 1=1 --","x'); DROP TABLE users; --","%' UNION SELECT phone,password_hash FROM users --"]){
    const a=await api(c.token,'GET','/api/v1/restaurants?q='+encodeURIComponent(q));assert.equal(a.status,200);assert.equal(a.data.length,0);
    const b=await api(c.token,'GET','/api/v1/maps/restaurants/viewport?bbox=-0.3,5.5,0,5.7&q='+encodeURIComponent(q)+'&category='+encodeURIComponent(q));assert.ok([200,500].includes(b.status));assert.notEqual(b.status,500,'viewport search must not error on quotes');
    const f=await api(c.token,'GET','/api/v1/food-orders?state='+encodeURIComponent(q));assert.equal(f.status,200);
   }
   assert.ok((await db.query('SELECT count(*)::int n FROM users')).rows[0].n>0);
  });
 }finally{
  process.env.NODE_ENV=previous;
  if(previousLegacy===undefined)delete process.env.HANDOVER_SMS_LEGACY_ENABLED;else process.env.HANDOVER_SMS_LEGACY_ENABLED=previousLegacy;
  server.closeAllConnections?.();await new Promise(r=>server.close(r));
  await db.close();
  await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(()=>{});await root.close();
 }
});
