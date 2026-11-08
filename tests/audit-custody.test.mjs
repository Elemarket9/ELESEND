import test from 'node:test';
import assert from 'node:assert/strict';
import {randomInt,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
const url=process.env.TEST_DATABASE_URL;
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

/**
 * SMS-free custody audit against a real PostgreSQL/PostGIS database of its own.
 * SMS and payment providers are in-process fakes (labelled below); nothing here is a live MoMo, bank or SMS result.
 */
test('SMS-free custody: rider declarations, recipient lock, suspended carriers, incidents and disputes',{skip:!url},async t=>{
 const previous={env:process.env.NODE_ENV,legacy:process.env.HANDOVER_SMS_LEGACY_ENABLED};
 process.env.NODE_ENV='production';process.env.HANDOVER_SMS_LEGACY_ENABLED='false';process.env.OTP_KEY??='d'.repeat(64);
 const pg=(await import('pg')).default;
 const name='elesend_audit_custody_'+randomInt(1e9);
 const admin=new pg.Client({connectionString:url});await admin.connect();
 await admin.query(`CREATE DATABASE ${name}`);
 const own=new URL(url);own.pathname='/'+name;
 const {database}=await import('../services/api/db.mjs');
 const {migrate}=await import('../scripts/migrate.mjs');
 const {platform}=await import('../services/api/platform.mjs');
 const {httpServer}=await import('../services/api/http.mjs');
 const {dispatchEngine}=await import('../services/api/dispatch.mjs');
 const {checkoutService,financeService,moneyOperations}=await import('../services/api/modules/payments/index.mjs');
 const {restaurantOrderService}=await import('../services/api/restaurant-orders.mjs');
 const {flagOverdueParcels}=await import('../services/api/custody-incidents.mjs');
 const db=database(own.toString());let server;
 try{
  await migrate(db);
  // Isolated simulated PSP only: production defaults remain disabled until explicitly enabled.
  await db.query("UPDATE checkout_method_policies SET enabled=true WHERE method='MOMO'");
  // FAKE SMS boundary: records account-verification texts only. Delivery handover must never use it.
  const texts=[];
  const sms={async send(m){texts.push(m);return {accepted:true};},async sendNotification(m){texts.push(m);return {accepted:true};}};
  const meters=(a,b)=>Math.max(1,Math.round(Math.hypot((a.latitude-b.latitude)*111000,(a.longitude-b.longitude)*111000)));
  const routing={async route(a,b){const m=meters(a,b);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};},async matrix(o,d){return o.map(x=>{const m=meters(x,d);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};});}};
  const dispatch=dispatchEngine(db,{routing});
  // FAKE payment provider: webhook confirmations below are simulated, not live MoMo or card payments.
  const provider={name:'custody_fx',methods:['MOMO','CARD'],allowedCheckoutHosts:['checkout.test'],async createCheckout(x){return {reference:x.reference,checkoutUrl:'https://checkout.test/'+x.reference};},async verifyPayment(ref){return {verified:true,status:'pending',reference:ref};},commissionIntentId:()=>null,async parseVerifiedWebhook(){return null;},async createPayout(x){return {providerId:'po_'+x.requestId};},async verifyPayout(){return {verified:true,status:'pending'};}};
  const app=platform(db,{otpKey:process.env.OTP_KEY,routing,dispatch,sms});
  const checkout=checkoutService(db,{provider,sms,dispatch,routing});
  server=httpServer(db,app,dispatch,financeService(db,{provider}),checkout,{restaurantOrders:restaurantOrderService(db,{platform:app,dispatcher:dispatch,routing,sms}),moneyOperations:moneyOperations(db,{provider})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const api=async(token,method,path,body,headers={})=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json().catch(()=>null)};};
  const phone=()=>'+23324'+String(randomInt(0,10000000)).padStart(7,'0');
  const P={address:'Accra Mall, Tetteh Quarshie',latitude:5.6221,longitude:-0.1735},D={address:'Osu Oxford Street, Accra',latitude:5.5571,longitude:-0.1817};
  const trip=(over={})=>({pickup:P,destination:D,vehicle:'motorcycle',recipientPhone:phone(),weightG:1000,description:'Documents',paymentMethod:'MOMO',...over});
  async function signUp(kind,extra={}){
   const number=phone();
   assert.equal((await api(null,'POST','/api/v1/auth/register',{phone:number,password:'mango river lantern',kind,...extra})).status,201);
   const login=await api(null,'POST','/api/v1/auth/login',{phone:number,password:'mango river lantern'});assert.equal(login.status,200);
   const ch=await api(login.data.token,'POST','/api/v1/me/phone-challenge',{});assert.equal(ch.status,200,JSON.stringify(ch.data));
   assert.equal((await api(login.data.token,'POST','/api/v1/me/phone-verify',{challengeId:ch.data.challengeId,code:texts.at(-1).code})).status,200);
   return {number,token:login.data.token,id:login.data.user.id};
  }
  const gps=r=>api(r.token,'POST','/api/v1/rider/location',{latitude:P.latitude,longitude:P.longitude,accuracyMeters:15,observedAt:new Date().toISOString()});
  async function readyRider(){const r=await signUp('rider',{vehicle:'motorcycle',maxWeightG:20000});await db.query("UPDATE riders SET status='approved' WHERE id=$1",[r.id]);assert.equal((await api(r.token,'POST','/api/v1/rider/availability',{online:true})).status,200);assert.equal((await gps(r)).status,200);return r;}
  async function book(c,over){
   const q=await api(c.token,'POST','/api/v1/quotes',trip(over));assert.equal(q.status,200,JSON.stringify(q.data));
   const key='custody-'+randomInt(1e9);
   const s=await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':key});assert.equal(s.status,200,JSON.stringify(s.data));
   if(s.data.payment_method!=='CASH'){
    const pay=await api(c.token,'POST','/api/v1/shipments/'+s.data.id+'/checkout',{idempotencyKey:key,email:'owner@example.com'});assert.equal(pay.status,200,JSON.stringify(pay.data));
    const row=(await db.query('SELECT amount_minor FROM shipment_checkout_intents WHERE reference=$1',[pay.data.reference])).rows[0];
    await checkout.confirmVerified({status:'success',reference:pay.data.reference,amountMinor:Number(row.amount_minor),currency:'GHS',eventId:'ev'+randomInt(1e9),channel:'mobile_money'});
   }
   return {id:s.data.id,amount:Number(s.data.amount_minor)};
  }
  // Controlled assignment with the same complete pickup/dropoff manifest dispatch would write.
  const stop=(id,kind)=>({shipmentId:id,kind,latitude:(kind==='pickup'?P:D).latitude,longitude:(kind==='pickup'?P:D).longitude,weightG:1000});
  async function assign(r,ids,stops=[...ids.map(id=>stop(id,'pickup')),...ids.map(id=>stop(id,'dropoff'))]){
   await db.query("UPDATE dispatch_offers SET status='expired' WHERE shipment_id=ANY($1) AND status='offered'",[ids]);
   await db.tx(async c=>{
    await c.query(`INSERT INTO rider_dispatch_plans(rider_id,revision,stops) VALUES($1,1,$2) ON CONFLICT(rider_id) DO UPDATE SET stops=EXCLUDED.stops,revision=rider_dispatch_plans.revision+1,updated_at=now()`,[r.id,JSON.stringify(stops)]);
    for(const id of ids)await c.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[id,r.id]);
   });
  }
  const handover=(r,id,kind)=>api(r.token,'POST','/api/v1/shipments/'+id+'/handover',{kind,confirmed:true});
  const state=async id=>(await db.query('SELECT state FROM shipments WHERE id=$1',[id])).rows[0].state;
  const adminId=randomUUID();await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'test-only','admin',now())",[adminId,phone()]);
  const adminActor={id:adminId,kind:'admin'};

  await t.test('each declaration is bound to the shipment, assigned rider and kind, with server time and fresh GPS only',async()=>{
   const c=await signUp('customer'),r=await readyRider(),other=await readyRider();
   const s=await book(c);await assign(r,[s.id]);
   const smsBefore=texts.length;
   assert.equal((await handover(other,s.id,'pickup')).status,403,'another rider cannot declare');
   assert.equal((await api(c.token,'POST','/api/v1/shipments/'+s.id+'/handover',{kind:'pickup',confirmed:true})).status,403,'the customer cannot declare');
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+s.id+'/handover',{kind:'pickup'})).status,400,'explicit confirmation required');
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+s.id+'/handover',{kind:'return',confirmed:true})).status,400,'a rider cannot self-declare a return');
   const before=(await db.query('SELECT now() AS t')).rows[0].t;
   assert.equal((await handover(r,s.id,'pickup')).status,200);
   const ev=(await db.query("SELECT rider_id,kind,confirmed_at,ST_Y(position::geometry) AS lat,position_at,accuracy_m FROM shipment_handover_events WHERE shipment_id=$1 AND kind='pickup'",[s.id])).rows[0];
   assert.equal(ev.rider_id,r.id);assert.ok(ev.confirmed_at>=before,'server clock, not a client timestamp');
   assert.ok(Math.abs(ev.lat-P.latitude)<1e-6,'fresh rider GPS is kept');assert.ok(ev.position_at);assert.equal(Number(ev.accuracy_m),15);
   // The phone stopped reporting 10 minutes ago: that position is not evidence of where the handover happened.
   await db.query("UPDATE riders SET position_at=now()-interval '10 minutes' WHERE id=$1",[r.id]);
   assert.equal((await handover(r,s.id,'delivery')).status,200);
   const stale=(await db.query("SELECT position,position_at,accuracy_m FROM shipment_handover_events WHERE shipment_id=$1 AND kind='delivery'",[s.id])).rows[0];
   assert.deepEqual([stale.position,stale.position_at,stale.accuracy_m],[null,null,null],'stale GPS is not stored as handover evidence');
   assert.equal(await state(s.id),'COMPLETED');
   assert.equal(texts.length,smsBefore,'no SMS for pickup or delivery');
   const audits=(await db.query('SELECT action FROM audit_logs WHERE entity_id=$1 ORDER BY id',[s.id])).rows.map(x=>x.action);
   assert.ok(audits.includes('pickup.rider_confirmed')&&audits.includes('delivery.rider_confirmed'),'audit says rider-confirmed, not verified');
   // Missing GPS stays missing.
   const s2=await book(c);await assign(r,[s2.id]);
   await db.query('UPDATE riders SET current_position=NULL,position_at=NULL,position_accuracy_m=NULL WHERE id=$1',[r.id]);
   assert.equal((await handover(r,s2.id,'pickup')).status,200);
   assert.equal((await db.query("SELECT position FROM shipment_handover_events WHERE shipment_id=$1",[s2.id])).rows[0].position,null);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM locations WHERE shipment_id=$1',[s2.id])).rows[0].n,0,'no tracking point is invented');
   const view=(await api(c.token,'GET','/api/v1/shipments/'+s.id)).data;
   assert.ok(view.rider_reported_at);assert.equal(view.receipt_confirmed_at,null,'rider report is not customer receipt');
   assert.equal((await api(c.token,'POST','/api/v1/shipments/'+s2.id+'/receipt',{received:true})).status,409,'receipt acknowledgement only after completion');
  });

  await t.test('concurrent duplicate delivery taps settle exactly once',async()=>{
   const c=await signUp('customer'),r=await readyRider();
   const s=await book(c);await assign(r,[s.id]);
   assert.equal((await handover(r,s.id,'pickup')).status,200);
   const results=await Promise.all(Array.from({length:6},()=>handover(r,s.id,'delivery')));
   assert.ok(results.every(x=>x.status===200),JSON.stringify(results.map(x=>[x.status,x.data])));
   assert.equal(results.filter(x=>!x.data.duplicate).length,1);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM financial_entries WHERE shipment_id=$1',[s.id])).rows[0].n,1);
   assert.equal((await db.query("SELECT count(*)::int AS n FROM shipment_handover_events WHERE shipment_id=$1 AND kind='delivery'",[s.id])).rows[0].n,1);
  });

  await t.test('the route manifest cannot be skipped',async()=>{
   await db.query('UPDATE dispatch_policy SET multi_stop_enabled=true,max_active_parcels=GREATEST(max_active_parcels,2) WHERE id=1');
   const c=await signUp('customer'),r=await readyRider();await db.query('UPDATE riders SET multi_stop_opt_in=true WHERE id=$1',[r.id]);
   const a=await book(c),b=await book(c);await assign(r,[a.id,b.id]);
   assert.equal((await handover(r,b.id,'pickup')).status,409,'second pickup before the first');
   assert.equal((await handover(r,a.id,'pickup')).status,200);
   assert.equal((await handover(r,a.id,'delivery')).status,409,'drop-off before the remaining pickup');
   assert.equal((await handover(r,b.id,'pickup')).status,200);
   assert.equal((await handover(r,b.id,'delivery')).status,409,'drop-offs keep their order');
   assert.equal((await handover(r,a.id,'delivery')).status,200);
   assert.equal((await handover(r,b.id,'delivery')).status,200);
   await db.query('UPDATE dispatch_policy SET multi_stop_enabled=false WHERE id=1');
  });

  await t.test('cancelled, failed, returning and returned parcels cannot be completed',async()=>{
   const c=await signUp('customer'),r=await readyRider();
   const cancelled=await book(c,{paymentMethod:'CASH'});await assign(r,[cancelled.id]);
   assert.equal((await api(c.token,'POST','/api/v1/shipments/'+cancelled.id+'/transition',{action:'cancel',reason:'Changed my mind'})).status,200);
   assert.equal((await handover(r,cancelled.id,'pickup')).status,403);assert.equal(await state(cancelled.id),'CANCELLED');
   const s=await book(c);await assign(r,[s.id]);
   assert.equal((await handover(r,s.id,'pickup')).status,200);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+s.id+'/transition',{action:'fail',reason:'Recipient unreachable'})).status,200);
   assert.equal((await handover(r,s.id,'delivery')).status,409,'FAILED');
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+s.id+'/transition',{action:'return',reason:'Taking it back'})).status,200);
   assert.equal((await handover(r,s.id,'delivery')).status,409,'RETURN_REQUESTED');
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+s.id+'/transition',{action:'returned',reason:'Back with sender'})).status,409,'rider cannot self-approve the return');
   await app.transition(adminActor,s.id,{action:'returned',reason:'Sender confirmed by phone'});
   assert.equal((await handover(r,s.id,'delivery')).status,409,'RETURNED');
   assert.equal((await db.query('SELECT count(*)::int AS n FROM financial_entries WHERE shipment_id=$1',[s.id])).rows[0].n,1,'return settles once');
  });

  await t.test('recipient can be corrected before pickup only, at the API and in the database',async()=>{
   const c=await signUp('customer'),r=await readyRider();
   const s=await book(c);
   assert.equal((await api(c.token,'POST','/api/v1/shipments/'+s.id+'/recipient',{recipientPhone:phone()})).status,200,'AWAITING_ASSIGNMENT');
   await assign(r,[s.id]);
   const fixed=phone();
   const ok=await api(c.token,'POST','/api/v1/shipments/'+s.id+'/recipient',{recipientPhone:fixed});
   assert.equal(ok.status,200,'RIDER_ASSIGNED');assert.equal(ok.data.deliveryCodeCancelled,undefined,'no delivery code exists in SMS-free handover');
   assert.equal((await handover(r,s.id,'pickup')).status,200);
   const tryChange=async label=>{const res=await api(c.token,'POST','/api/v1/shipments/'+s.id+'/recipient',{recipientPhone:phone()});assert.equal(res.status,409,label);};
   await tryChange('PICKUP_VERIFIED');
   // Database last line of defence: even inside the correction transaction the number is locked after pickup.
   await assert.rejects(db.tx(async x=>{await x.query("SELECT set_config('elesend.recipient_correction',$1,true)",[s.id]);await x.query('UPDATE shipments SET recipient_phone=$2 WHERE id=$1',[s.id,phone()]);}),/Recipient locked after pickup/);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+s.id+'/transition',{action:'start'})).status,200);await tryChange('IN_TRANSIT');
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+s.id+'/transition',{action:'fail',reason:'No one home'})).status,200);await tryChange('FAILED');
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+s.id+'/transition',{action:'return',reason:'Taking it back'})).status,200);await tryChange('RETURN_REQUESTED');
   await app.transition(adminActor,s.id,{action:'returned',reason:'Sender confirmed'});await tryChange('RETURNED');
   const done=await book(c);await assign(r,[done.id]);assert.equal((await handover(r,done.id,'pickup')).status,200);assert.equal((await handover(r,done.id,'delivery')).status,200);
   assert.equal((await api(c.token,'POST','/api/v1/shipments/'+done.id+'/recipient',{recipientPhone:phone()})).status,409,'COMPLETED');
   const gone=await book(c);assert.equal((await api(c.token,'POST','/api/v1/shipments/'+gone.id+'/transition',{action:'cancel',reason:'Not needed'})).status,200);
   assert.equal((await api(c.token,'POST','/api/v1/shipments/'+gone.id+'/recipient',{recipientPhone:phone()})).status,409,'CANCELLED');
   assert.equal((await db.query('SELECT recipient_phone FROM shipments WHERE id=$1',[s.id])).rows[0].recipient_phone,fixed,'custody destination never silently moved');
  });

  await t.test('no reassignment once the parcel is in a rider\'s custody',async()=>{
   const c=await signUp('customer'),r=await readyRider(),other=await readyRider();
   const s=await book(c);await assign(r,[s.id]);
   assert.equal((await handover(r,s.id,'pickup')).status,200);
   assert.equal((await api(r.token,'POST','/api/v1/rider/assignments/release',{shipmentId:s.id,reason:'Bike broke down'})).status,409);
   await assert.rejects(db.query('UPDATE shipments SET rider_id=$2 WHERE id=$1',[s.id,other.id]),/Custody rider immutable after pickup/);
   assert.equal((await handover(other,s.id,'delivery')).status,403);
  });

  await t.test('a rider suspended while carrying a parcel can still finish it without SMS, but takes nothing new',async()=>{
   await db.query('UPDATE dispatch_policy SET multi_stop_enabled=true,max_active_parcels=GREATEST(max_active_parcels,2) WHERE id=1');
   const c=await signUp('customer'),r=await readyRider();await db.query('UPDATE riders SET multi_stop_opt_in=true WHERE id=$1',[r.id]);
   const carried=await book(c,{paymentMethod:'CASH'}),waiting=await book(c,{paymentMethod:'CASH'});
   // Carried parcel is delivered before the second pickup, so the manifest itself does not block this delivery.
   await assign(r,[carried.id,waiting.id],[stop(carried.id,'pickup'),stop(carried.id,'dropoff'),stop(waiting.id,'pickup'),stop(waiting.id,'dropoff')]);
   assert.equal((await handover(r,carried.id,'pickup')).status,200);
   await db.query("UPDATE riders SET status='suspended',online=false WHERE id=$1",[r.id]);
   assert.equal((await api(r.token,'GET','/api/v1/rider/offers')).status,403,'no new work');
   assert.equal((await handover(r,waiting.id,'pickup')).status,403,'no new custody while suspended');
   const early=await handover(r,carried.id,'delivery');assert.equal(early.status,409,'full cash report is still required');
   const cash=await api(r.token,'POST','/api/v1/rider/cash-report',{shipmentId:carried.id,reportedMinor:carried.amount,cashPayer:'recipient',idempotencyKey:'cash-'+randomInt(1e9)});
   assert.equal(cash.status,200,JSON.stringify(cash.data));
   const done=await handover(r,carried.id,'delivery');assert.equal(done.status,200,JSON.stringify(done.data));
   assert.equal(await state(carried.id),'COMPLETED');
   assert.equal((await db.query("SELECT count(*)::int AS n FROM finance_journals WHERE shipment_id=$1 AND kind='cash_commission'",[carried.id])).rows[0].n,1);
   await db.query('UPDATE dispatch_policy SET multi_stop_enabled=false WHERE id=1');
  });

  await t.test('a parcel picked up without SMS is still flagged when it is not delivered in time',async()=>{
   const c=await signUp('customer'),r=await readyRider();
   const s=await book(c);await assign(r,[s.id]);
   // Simulated: the rider confirmed pickup 30 hours ago and never delivered.
   await db.tx(async x=>{
    await x.query("INSERT INTO shipment_handover_events(shipment_id,rider_id,kind,confirmed_at) VALUES($1,$2,'pickup',now()-interval '30 hours')",[s.id,r.id]);
    await x.query("UPDATE shipments SET state='PICKUP_VERIFIED' WHERE id=$1",[s.id]);
   });
   const flagged=await flagOverdueParcels(db,{limitHours:24});
   const incident=(await db.query('SELECT evidence FROM parcel_custody_incidents WHERE shipment_id=$1',[s.id])).rows[0];
   assert.ok(incident&&flagged.length>=1,'overdue SMS-free custody opens an incident');
   assert.ok(incident.evidence.picked_up_at,'evidence records when the rider declared pickup');
   assert.equal((await db.query('SELECT status FROM riders WHERE id=$1',[r.id])).rows[0].status,'suspended');
  });

  await t.test('a customer can report a parcel missing after a rider-declared delivery',async()=>{
   const c=await signUp('customer'),r=await readyRider();
   const s=await book(c);await assign(r,[s.id]);
   assert.equal((await handover(r,s.id,'pickup')).status,200);assert.equal((await handover(r,s.id,'delivery')).status,200);
   const reported=await api(c.token,'POST','/api/v1/shipments/'+s.id+'/disputes',{category:'lost',detail:'The parcel never reached the recipient'});
   assert.equal(reported.status,200,JSON.stringify(reported.data));
   assert.equal((await db.query('SELECT count(*)::int AS n FROM financial_entries WHERE shipment_id=$1',[s.id])).rows[0].n,1,'reporting moves no money');
   const failed=await book(c);await assign(r,[failed.id]);
   assert.equal((await handover(r,failed.id,'pickup')).status,200);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+failed.id+'/transition',{action:'fail',reason:'No one home'})).status,200);
   const refused=await api(c.token,'POST','/api/v1/shipments/'+failed.id+'/disputes',{category:'lost',detail:'Please refund this delivery'});
   assert.equal(refused.status,409,'failed deliveries keep the no-refund rule');assert.doesNotMatch(refused.data.error??refused.data.message??'',/SMS/);
  });
 }finally{
  server?.closeAllConnections?.();if(server)await new Promise(r=>server.close(r));
  await db.close();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();
  process.env.NODE_ENV=previous.env;if(previous.legacy===undefined)delete process.env.HANDOVER_SMS_LEGACY_ENABLED;else process.env.HANDOVER_SMS_LEGACY_ENABLED=previous.legacy;
 }
});

test('every database table has exactly one module owner, so boundary checks see the handover tables',()=>{
 const m=JSON.parse(read('config/modules.json'));
 const owned=new Set([...Object.values(m.modules),m.shared].flatMap(x=>x.tables));
 const created=new Set(),dropped=new Set();
 for(const f of readdirSync(new URL('../database/migrations/',import.meta.url)).sort()){const sql=read('database/migrations/'+f);
  for(const x of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi))created.add(x[1]);
  for(const x of sql.matchAll(/DROP TABLE(?: IF EXISTS)?\s+([a-z_]+)/gi))dropped.add(x[1]);}
 assert.deepEqual([...created].filter(x=>!owned.has(x)&&!dropped.has(x)),[]);
});

test('suspended riders in custody can reach the SMS-free handover and cash report routes',()=>{
 const http=read('services/api/http.mjs');
 const route=http.match(/const CUSTODY_SHIPMENT_ROUTE=(\/.+\/);/)[1];
 const re=new RegExp(route.slice(1,-1));
 assert.ok(re.test('POST /api/v1/shipments/'+randomUUID()+'/handover'));
 assert.match(http.match(/const CUSTODY_ROUTES=new Set\(\[[^\]]+\]\)/)[0],/'POST \/api\/v1\/rider\/cash-report'/);
});

test('no customer, rider or portal text promises a delivery SMS code',()=>{
 const files=['apps/mobile/src/customer/RecipientPhoneModal.js','apps/mobile/src/customer/CustomerApp.js','apps/mobile/src/rider/RiderApp.js','apps/restaurant-web/index.html','README.md','docs/paystack-setup.md','services/api/platform.mjs','services/api/modules/payments/money-operations.mjs'];
 for(const f of files){
  const text=read(f);
  for(const bad of [/handover code/i,/Challenge OTP applies/i,/verified OTP handovers/i,/confirmed by SMS/i,/sender's SMS code/i,/delivery code/i])assert.doesNotMatch(text,bad,f);
 }
});

test('rider app collects sender cash before pickup and recipient cash before delivery',async()=>{
 const {cashToCollect}=await import('../apps/mobile/src/rider/handover-logic.mjs');
 const s={id:'a',payment_method:'CASH',amount_minor:2500};
 assert.deepEqual(cashToCollect({...s,cash_payer:'sender'},'pickup',{}),{payer:'sender',amountMinor:2500});
 assert.equal(cashToCollect({...s,cash_payer:'sender'},'delivery',{}),null,'sender already paid at pickup');
 assert.deepEqual(cashToCollect({...s,cash_payer:'recipient'},'delivery',{}),{payer:'recipient',amountMinor:2500});
 assert.equal(cashToCollect({...s,cash_payer:'recipient'},'pickup',{}),null);
 assert.equal(cashToCollect({...s,cash_payer:'recipient'},'delivery',{a:true}),null,'already reported');
 assert.equal(cashToCollect({...s,payment_method:'MOMO',cash_payer:'recipient'},'delivery',{}),null);
 assert.deepEqual(cashToCollect({...s,cash_payer:undefined},'delivery',{}),{payer:'recipient',amountMinor:2500},'old bookings default to recipient');
 const rider=read('apps/mobile/src/rider/RiderApp.js');
 assert.match(rider,/cashToCollect\(shipment, 'pickup'/);assert.match(rider,/cashToCollect\(shipment, 'delivery'/);
});
