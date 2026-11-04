import test from 'node:test';
import assert from 'node:assert/strict';
import {randomInt,randomUUID} from 'node:crypto';
const url=process.env.TEST_DATABASE_URL;
/** Starts from brand-new accounts through the real API, so a rule that locks people out cannot pass unnoticed. */
test('real journeys from brand-new accounts',{skip:!url},async t=>{
 assert.match(new URL(url).pathname,/^\/elesend_test/);
 const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';process.env.OTP_KEY??='d'.repeat(64);
 const {database}=await import('../services/api/db.mjs');
 const {migrate}=await import('../scripts/migrate.mjs');
 const {platform}=await import('../services/api/platform.mjs');
 const {httpServer}=await import('../services/api/http.mjs');
 const {dispatchEngine}=await import('../services/api/dispatch.mjs');
 const {checkoutService,financeService,moneyOperations}=await import('../services/api/modules/payments/index.mjs');
 const {restaurantOrderService}=await import('../services/api/restaurant-orders.mjs');
 const {offlineSignedOutRiders}=await import('../services/api/rider-tools.mjs');
 const db=database(url);await migrate(db);
 const texts=[];let smsWorks=true;
 const sms={async send(m){if(!smsWorks)return {accepted:false};texts.push(m);return {accepted:true};},async sendNotification(m){texts.push(m);return {accepted:true};}};
 const meters=(a,b)=>Math.max(1,Math.round(Math.hypot((a.latitude-b.latitude)*111000,(a.longitude-b.longitude)*111000)));
 const routing={async route(a,b){const m=meters(a,b);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};},async matrix(o,d){return o.map(x=>{const m=meters(x,d);return {source:'routing-provider',distanceMeters:m,durationSeconds:Math.round(m/8)};});}};
 const dispatch=dispatchEngine(db,{routing});
 const provider={name:'journey_fx',methods:['MOMO','CARD'],allowedCheckoutHosts:['checkout.test'],async createCheckout(x){return {reference:x.reference,checkoutUrl:'https://checkout.test/'+x.reference};},async verifyPayment(ref){return {verified:true,status:'pending',reference:ref};},commissionIntentId:()=>null,async parseVerifiedWebhook(){return null;},async createPayout(x){return {providerId:'po_'+x.requestId};},async verifyPayout(){return {verified:true,status:'pending'};}};
 const app=platform(db,{otpKey:process.env.OTP_KEY,routing,dispatch,sms});
 const checkout=checkoutService(db,{provider,sms,dispatch,routing});
 const server=httpServer(db,app,dispatch,financeService(db,{provider}),checkout,{restaurantOrders:restaurantOrderService(db,{platform:app,dispatcher:dispatch,routing,sms}),moneyOperations:moneyOperations(db,{provider})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const api=async(token,method,path,body,headers={})=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json().catch(()=>null)};};
 const phone=()=>'+23324'+String(randomInt(0,10000000)).padStart(7,'0');
 const code=()=>texts.at(-1).code;
 const P={address:'Accra Mall, Tetteh Quarshie',latitude:5.6221,longitude:-0.1735},D={address:'Osu Oxford Street, Accra',latitude:5.5571,longitude:-0.1817};
 const trip=(over={})=>({pickup:P,destination:D,vehicle:'motorcycle',recipientPhone:phone(),weightG:1000,description:'Documents',paymentMethod:'MOMO',...over});
 async function signUp(kind,extra={}){
  const number=phone();
  assert.equal((await api(null,'POST','/api/v1/auth/register',{phone:number,password:'mango river lantern',kind,...extra})).status,201);
  const login=await api(null,'POST','/api/v1/auth/login',{phone:number,password:'mango river lantern'});
  assert.equal(login.status,200);
  return {number,token:login.data.token,id:login.data.user.id,user:login.data.user};
 }
 async function verifyPhone(a){
  const ch=await api(a.token,'POST','/api/v1/me/phone-challenge',{});assert.equal(ch.status,200,JSON.stringify(ch.data));
  assert.equal((await api(a.token,'POST','/api/v1/me/phone-verify',{challengeId:ch.data.challengeId,code:code()})).status,200);
 }
 const customer=async()=>{const c=await signUp('customer');await verifyPhone(c);return c;};
 const approve=id=>db.query("UPDATE riders SET status='approved' WHERE id=$1",[id]);
 const gps=(r,at=P)=>api(r.token,'POST','/api/v1/rider/location',{latitude:at.latitude,longitude:at.longitude,accuracyMeters:15,observedAt:new Date().toISOString()});
 async function readyRider(){const r=await signUp('rider',{vehicle:'motorcycle',maxWeightG:20000});await verifyPhone(r);await approve(r.id);assert.equal((await api(r.token,'POST','/api/v1/rider/availability',{online:true})).status,200);assert.equal((await gps(r)).status,200);return r;}
 const offline=()=>db.query('UPDATE riders SET online=false');
 async function paidOrder(c,over){
  const q=await api(c.token,'POST','/api/v1/quotes',trip(over));assert.equal(q.status,200,JSON.stringify(q.data));
  const key='journey-'+randomInt(1e9);
  const s=await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':key});assert.equal(s.status,200);
  const pay=await api(c.token,'POST','/api/v1/shipments/'+s.data.id+'/checkout',{idempotencyKey:key,email:'owner@example.com'});assert.equal(pay.status,200,JSON.stringify(pay.data));
  const row=(await db.query('SELECT amount_minor FROM shipment_checkout_intents WHERE reference=$1',[pay.data.reference])).rows[0];
  await checkout.confirmVerified({status:'success',reference:pay.data.reference,amountMinor:Number(row.amount_minor),currency:'GHS',eventId:'ev'+randomInt(1e9),channel:'mobile_money'});
  return s.data.id;
 }
 const offerFor=async(r,id)=>(await api(r.token,'GET','/api/v1/rider/offers')).data.find(o=>o.id===id);
 try{
  await t.test('a new rider can finish setting up and do nothing else until approved',async()=>{
   const r=await signUp('rider',{vehicle:'motorcycle',maxWeightG:20000});
   assert.equal(r.user.awaitingApproval,true);
   assert.equal((await api(r.token,'GET','/api/v1/me')).data.awaitingApproval,true);
   await verifyPhone(r);
   const next=`${new Date().getUTCFullYear()+1}-01-31`;
   const licence=await api(r.token,'POST','/api/v1/rider/licence',{legalName:'Kofi Mensah',licenceNumber:'GH-'+randomInt(1e8),licenceClass:'A',expiresOn:next,vehiclePlate:'GR 1234-26'});
   assert.equal(licence.status,200,JSON.stringify(licence.data));
   assert.equal((await api(r.token,'GET','/api/v1/rider/licence')).status,200);
   assert.equal((await api(r.token,'POST','/api/v1/rider/documents/upload-link',{})).status,200);
   for(const [m,p,b] of [['POST','/api/v1/rider/availability',{online:true}],['GET','/api/v1/rider/manifest'],['GET','/api/v1/rider/offers'],['GET','/api/v1/rider/finance'],['POST','/api/v1/quotes',trip()]])assert.equal((await api(r.token,m,p,b)).status,403,p);
   await approve(r.id);
   assert.equal((await api(r.token,'GET','/api/v1/me')).data.awaitingApproval,undefined);
   assert.equal((await api(r.token,'POST','/api/v1/rider/availability',{online:true})).status,200);
   await db.query("UPDATE riders SET status='suspended',online=false WHERE id=$1",[r.id]);
   assert.equal((await api(r.token,'GET','/api/v1/me')).status,403,'suspended riders stay locked out');
  });
  await t.test('a company registers, waits for approval, and books and pays as the portal does',async()=>{
   const co=await signUp('company',{name:'Journey Logistics',services:['delivery','riders']});
   assert.equal(co.user.awaitingApproval,true);
   await verifyPhone(co);
   const pending=await api(co.token,'GET','/api/v1/company/profile');
   assert.equal(pending.status,200);assert.equal(pending.data.status,'pending');
   assert.equal((await api(co.token,'POST','/api/v1/quotes',trip())).status,403);
   await db.query("UPDATE companies SET status='approved' WHERE owner_id=$1",[co.id]);
   const contact=phone();
   const id=await paidOrder(co,{paymentMethod:undefined,pickupPhone:contact});
   assert.equal((await db.query('SELECT payment_method FROM shipments WHERE id=$1',[id])).rows[0].payment_method,'MOMO');
   await offline();
   const r=await readyRider();await dispatch.tick();
   const offer=await offerFor(r,id);assert.ok(offer,'rider gets the offer');
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+id+'/accept',{offerId:offer.offerId})).status,200);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+id+'/pickup-challenge',{})).status,200);
   assert.equal(texts.at(-1).phone,contact,'the pickup code goes to the named contact');
   const customerTry=await api((await customer()).token,'POST','/api/v1/quotes',trip({pickupPhone:phone()}));
   assert.equal(customerTry.status,400);
   await db.query('UPDATE challenges SET expires_at=now() WHERE shipment_id=$1',[id]);
   await offline();
  });
  await t.test('a rider is told about a company invitation',async()=>{
   const co=await signUp('company',{name:'Invite Logistics',services:['riders']});await verifyPhone(co);
   await db.query("UPDATE companies SET status='approved' WHERE owner_id=$1",[co.id]);
   const r=await readyRider();
   assert.equal((await api(co.token,'POST','/api/v1/company/invitations',{phone:r.number})).status,200);
   const jobs=(await db.query("SELECT payload FROM notification_jobs WHERE recipient_id=$1 AND kind='company_invitation'",[r.id])).rows;
   assert.equal(jobs.length,1);assert.match(jobs[0].payload.message,/Invite Logistics/);
   await offline();
  });
  await t.test('an order with no rider tells people once and does not block other orders',async()=>{
   await offline();
   const c=await customer();
   const stuck=[];for(let i=0;i<9;i++)stuck.push(await paidOrder(c));
   await db.query('UPDATE shipments SET dispatch_attempts=1000,next_dispatch_at=now()-interval \'1 hour\' WHERE id=ANY($1)',[stuck]);
   await dispatch.tick();await dispatch.tick();
   const first=stuck[0];
   const row=(await db.query('SELECT no_rider_since,dispatch_attempts,next_dispatch_at>now() AS paused FROM shipments WHERE id=$1',[first])).rows[0];
   assert.ok(row.no_rider_since);assert.equal(row.paused,true);
   assert.equal((await api(c.token,'GET','/api/v1/shipments/'+first+'/dispatch')).data.dispatchStatus,'no_rider_yet');
   assert.equal((await db.query("SELECT count(*)::int n FROM notification_jobs WHERE id=$1",['no-rider:'+first])).rows[0].n,1);
   await db.query('UPDATE shipments SET dispatch_attempts=1000,next_dispatch_at=now()-interval \'1 hour\' WHERE id=$1',[first]);
   await dispatch.dispatchShipment(first);
   assert.equal((await db.query("SELECT count(*)::int n FROM dispatch_exceptions WHERE shipment_id=$1 AND kind='no_rider_found'",[first])).rows[0].n,1,'staff are told once');
   const later=await paidOrder(c);
   await db.query("UPDATE shipments SET next_dispatch_at=now()+interval '1 hour' WHERE id=ANY($1)",[stuck]);
   const r=await readyRider();await dispatch.tick();
   assert.ok(await offerFor(r,later),'a new order still reaches a rider');
   await db.query("UPDATE dispatch_offers SET status='expired' WHERE shipment_id=$1",[later]);await db.query("UPDATE shipments SET state='CANCELLED' WHERE id=ANY($1)",[[...stuck,later]]);
   await offline();
  });
  await t.test('a code that could not be sent is reported, and staff can see it',async()=>{
   await offline();
   const c=await customer(),r=await readyRider();
   const id=await paidOrder(c);await dispatch.tick();
   const offer=await offerFor(r,id);
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+id+'/accept',{offerId:offer.offerId})).status,200);
   smsWorks=false;
   const res=await api(r.token,'POST','/api/v1/shipments/'+id+'/pickup-challenge',{});
   smsWorks=true;
   assert.equal(res.status,503);
   const admin=randomUUID();
   await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'test-only','admin',now())",[admin,phone()]);
   await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'dispatch:configure')",[admin]);
   const list=await dispatch.openExceptions({id:admin,kind:'admin'});
   assert.ok(list.some(e=>e.shipment_id===id&&e.kind==='handover_sms_failed'));
   assert.equal((await api(r.token,'POST','/api/v1/shipments/'+id+'/pickup-challenge',{})).status,200,'the rider can try again');
   await offline();
  });
  await t.test('people in use stay signed in, and riders with ended sessions go offline',async()=>{
   const r=await readyRider();
   const lifetime=(await db.query("SELECT expires_at>now()+interval '29 days' AS long FROM sessions WHERE user_id=$1",[r.id])).rows[0];
   assert.equal(lifetime.long,true);
   await db.query("UPDATE sessions SET expires_at=now()+interval '1 hour',last_seen_at=now()-interval '2 hours' WHERE user_id=$1",[r.id]);
   assert.equal((await api(r.token,'GET','/api/v1/rider/manifest')).status,200);
   assert.equal((await db.query("SELECT expires_at>now()+interval '29 days' AS long FROM sessions WHERE user_id=$1",[r.id])).rows[0].long,true);
   await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",[r.id]);
   assert.equal((await api(r.token,'GET','/api/v1/rider/manifest')).status,401);
   await offlineSignedOutRiders(db);
   assert.equal((await db.query('SELECT online FROM riders WHERE id=$1',[r.id])).rows[0].online,false);
  });
 }finally{
  process.env.NODE_ENV=previous;
  server.closeAllConnections?.();await new Promise(r=>server.close(r));
  await db.close();
 }
});
