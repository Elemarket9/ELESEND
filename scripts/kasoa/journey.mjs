import {randomInt} from 'node:crypto';import {createRequire} from 'node:module';import fs from 'node:fs';
process.env.NODE_ENV='production';process.env.OTP_KEY??='d'.repeat(64);process.env.MAPS_PUBLIC_ORIGIN='http://127.0.0.1:3145';
const url=process.env.TEST_DATABASE_URL;
const {database}=await import('../../services/api/db.mjs');const {migrate}=await import('../../scripts/migrate.mjs');const {platform}=await import('../../services/api/platform.mjs');const {httpServer}=await import('../../services/api/http.mjs');const {dispatchEngine}=await import('../../services/api/dispatch.mjs');const {osrmRouting}=await import('../../services/api/dispatch-routing.mjs');
const {checkoutService,financeService}=await import('../../services/api/modules/payments/index.mjs');const {restaurantOrderService}=await import('../../services/api/restaurant-orders.mjs');
const logic=await import('../../apps/mobile/src/rider/navigation-logic.mjs');
const log=(...a)=>console.log(...a);const O='/tmp/out/screens/';
const db=database(url);await migrate(db);
log('spatial_landmarks rows in a fresh database:',(await db.query('SELECT count(*) FROM spatial_landmarks')).rows[0].count);
const texts=[];const sms={async send(m){texts.push(m);return {accepted:true};},async sendNotification(m){texts.push(m);return {accepted:true};}};
const routing=osrmRouting({vehicleRoutes:{motorcycle:{endpoint:'http://127.0.0.1:5001',profile:'driving'},car:{endpoint:'http://127.0.0.1:5000',profile:'driving'},van:{endpoint:'http://127.0.0.1:5000',profile:'driving'}},timeoutMs:8000});
const dispatch=dispatchEngine(db,{routing});
const provider={name:'lab',methods:['MOMO','CARD'],allowedCheckoutHosts:['checkout.test'],async createCheckout(x){return {reference:x.reference,checkoutUrl:'https://checkout.test/'+x.reference,providerReference:x.reference};},async verify(){return {status:'pending'};}};
const app=platform(db,{otpKey:process.env.OTP_KEY,routing,dispatch,sms});const checkout=checkoutService(db,{provider,sms,dispatch,routing});
const server=httpServer(db,app,dispatch,financeService(db,{provider}),checkout,{restaurantOrders:restaurantOrderService(db,{platform:app,dispatcher:dispatch,routing,sms})});
await new Promise(r=>server.listen(4000,'127.0.0.1',r));const base='http://127.0.0.1:4000';
const api=async(token,method,path,body,headers={})=>{const t=Date.now();const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:body?JSON.stringify(body):undefined});const data=await res.json().catch(()=>null);return {status:res.status,data,ms:Date.now()-t};};
const phone=()=>'+23324'+String(randomInt(0,10000000)).padStart(7,'0');const code=()=>texts.at(-1).code;
async function acct(kind,extra={}){const number=phone();const reg=await api(null,'POST','/api/v1/auth/register',{phone:number,password:'mango river lantern',kind,...extra});if(reg.status!==201)throw Error('register '+JSON.stringify(reg.data));const l=await api(null,'POST','/api/v1/auth/login',{phone:number,password:'mango river lantern'});const a={number,token:l.data.token,id:l.data.user.id};const ch=await api(a.token,'POST','/api/v1/me/phone-challenge',{});await api(a.token,'POST','/api/v1/me/phone-verify',{challengeId:ch.data.challengeId,code:code()});return a;}
// Random spot in Kasoa, moved onto a real road.
const rawLat=5.5346+(Math.random()-0.5)*0.02,rawLon=-0.4280+(Math.random()-0.5)*0.02;
const near=await (await fetch(`http://127.0.0.1:5001/nearest/v1/driving/${rawLon},${rawLat}?number=1`)).json();
const KASOA={latitude:near.waypoints[0].location[1],longitude:near.waypoints[0].location[0]};
log('\n== 1. Mock GPS\nRandom point',rawLat.toFixed(5),rawLon.toFixed(5),'on road:',KASOA.latitude,KASOA.longitude,JSON.stringify(near.waypoints[0].name),Math.round(near.waypoints[0].distance)+'m away');
const c=await acct('customer');
const rev=await api(c.token,'GET',`/api/v1/maps/reverse?lat=${KASOA.latitude}&lon=${KASOA.longitude}`);log('Reverse geocode:',JSON.stringify(rev.data).slice(0,300),rev.ms+'ms');
log('\n== 2. Search');
let airport=null;
for(const q of ['Kasoa Nyinyano','Nyinyano','Nyanyano','Kasoa Nyanyano','Nyanyano Kasoa','Kasoa','Airport','Kotoka','Kotoka Airport','Accra airport']){
 const e=await api(c.token,'POST','/api/v1/maps/egia/search',{query:q,coordinates:KASOA,limit:5});const g=await api(c.token,'GET','/api/v1/maps/search?q='+encodeURIComponent(q));
 const en=Array.isArray(e.data)?e.data:e.data?.results||[];const gn=Array.isArray(g.data)?g.data:[];
 log(`"${q}" app-search ${e.status} ${e.ms}ms ->`,en.slice(0,4).map(x=>`${x.name||x.label} [${x.locality||x.city||''}] ${x.distanceMeters?Math.round(x.distanceMeters/1000)+'km':''}`));
 log(`   gazetteer ${g.status} ${g.ms}ms ->`,gn.slice(0,4).map(x=>`${x.name||x.label} [${x.locality||''}]`));
 if(q==='Kotoka Airport')airport=en[0]||gn[0];
}
const AIR={address:airport?.name||'Kotoka International Airport',latitude:Number(airport?.latitude??5.6052),longitude:Number(airport?.longitude??-0.1668)};log('Delivery point used:',JSON.stringify(AIR));
log('\n== 3. Routes');
for(const v of ['motorcycle','car']){const r=await routing.route(KASOA,AIR,{vehicle:v,steps:true});log(v,(r.distanceMeters/1000).toFixed(1)+'km',Math.round(r.durationSeconds/60)+'min','steps',r.steps.length);}
const P={address:'Kasoa (GPS)',latitude:KASOA.latitude,longitude:KASOA.longitude};
log('\n== 4. Quote and order');
const q=await api(c.token,'POST','/api/v1/quotes',{pickup:P,destination:AIR,vehicle:'motorcycle',recipientPhone:phone(),weightG:1000,description:'Documents',paymentMethod:'MOMO'});log('Quote',q.status,q.ms+'ms',JSON.stringify(q.data).slice(0,260));
const key='k'+randomInt(1e9);const s=await api(c.token,'POST','/api/v1/shipments',{quoteId:q.data.id},{'Idempotency-Key':key});log('Shipment',s.status,s.data?.state);
const pay=await api(c.token,'POST','/api/v1/shipments/'+s.data.id+'/checkout',{idempotencyKey:key,email:'owner@example.com'});log('Checkout',pay.status,JSON.stringify(pay.data).slice(0,120));
const row=(await db.query('SELECT amount_minor FROM shipment_checkout_intents WHERE reference=$1',[pay.data.reference])).rows[0];log('Charged GHS',Number(row.amount_minor)/100);
await checkout.confirmVerified({status:'success',reference:pay.data.reference,amountMinor:Number(row.amount_minor),currency:'GHS',eventId:'ev'+randomInt(1e9),channel:'mobile_money'});
const r=await acct('rider',{vehicle:'motorcycle',maxWeightG:20000});await db.query("UPDATE riders SET status='approved' WHERE id=$1",[r.id]);
const startRider={latitude:KASOA.latitude+0.004,longitude:KASOA.longitude+0.004};
log('Rider online',(await api(r.token,'POST','/api/v1/rider/availability',{online:true})).status);
const gps=(at)=>api(r.token,'POST','/api/v1/rider/location',{latitude:at.latitude,longitude:at.longitude,accuracyMeters:10,observedAt:new Date().toISOString()});
log('Rider GPS',(await gps(startRider)).status);await dispatch.tick();
const offers=await api(r.token,'GET','/api/v1/rider/offers');const offer=(offers.data||[]).find(o=>o.id===s.data.id);log('Offer reached rider:',Boolean(offer),JSON.stringify(offer||offers.data).slice(0,300));
const acc=await api(r.token,'POST','/api/v1/shipments/'+s.data.id+'/accept',{offerId:offer?.offerId});log('Accept',acc.status,JSON.stringify(acc.data).slice(0,120));
log('\n== 5. Navigation to pickup, on real routes');
const n1=await api(r.token,'POST','/api/v1/rider/navigation',{shipmentId:s.data.id,...startRider});log('To pickup',n1.status,n1.ms+'ms',n1.data?.distanceMeters,JSON.stringify(n1.data?.error||''));
const pc=await api(r.token,'POST','/api/v1/shipments/'+s.data.id+'/pickup-challenge',{});log('Pickup code',pc.status,JSON.stringify(pc.data?.error||''));
if(pc.status!==200){await gps(KASOA);const again=await api(r.token,'POST','/api/v1/shipments/'+s.data.id+'/pickup-challenge',{});log('Pickup code at pickup',again.status);pc.data=again.data;}
const pv=await api(r.token,'POST','/api/v1/shipments/'+s.data.id+'/verify',{challengeId:pc.data?.challengeId,code:code()});log('Verify pickup',pv.status,JSON.stringify(pv.data?.state||pv.data?.error));
const st=await api(r.token,'POST','/api/v1/shipments/'+s.data.id+'/transition',{action:'start'});log('Start trip',st.status,st.data?.state||st.data?.error);
const n2=await api(r.token,'POST','/api/v1/rider/navigation',{shipmentId:s.data.id,...KASOA});log('To airport',n2.status,n2.ms+'ms',(n2.data?.distanceMeters/1000).toFixed(1)+'km',Math.round(n2.data?.durationSeconds/60)+'min');
log(n2.data.steps.map((x,i)=>`  ${i+1}. ${x.instruction} (${logic.formatDistance(x.distanceMeters)})`).join('\n'));
log('\n== 6. Riding it: GPS follows the route, then leaves it');
const pts=n2.data.geometry.coordinates.map(([longitude,latitude])=>({latitude,longitude}));let voice={},rr={},spoken=[],stepped=new Set();
const stepEvery=Math.max(1,Math.floor(pts.length/400));
for(let i=0;i<pts.length;i+=stepEvery){const p=logic.locateOnRoute(pts[i],pts);const nx=logic.upcomingStep(n2.data.steps,p.traveledMeters);const v=logic.voicePrompt(voice,{index:nx.index,metersToStep:nx.metersToStep,step:nx.step});voice=v.state;if(v.say)spoken.push(v.say);const chk=logic.rerouteCheck(rr,{offRouteMeters:p.offRouteMeters,accuracy:8,now:i*1000});rr=chk;if(chk.reroute)log('FALSE reroute at',i);}
log('Voice prompts on the whole trip:',spoken.length);log(spoken.slice(0,14).map(x=>'  '+x).join('\n'));
const m=pts[Math.floor(pts.length/2)];const off={latitude:m.latitude+0.002,longitude:m.longitude+0.002};const pOff=logic.locateOnRoute(off,pts);log('Left the route by',Math.round(pOff.offRouteMeters)+'m');
let rs={};for(let t=0;t<3;t++){rs=logic.rerouteCheck(rs,{offRouteMeters:pOff.offRouteMeters,accuracy:8,now:1e6+t*2000});log('  fix',t+1,'reroute?',rs.reroute);}
const n3=await api(r.token,'POST','/api/v1/rider/navigation',{shipmentId:s.data.id,...off});log('New route from there',n3.status,n3.ms+'ms',(n3.data?.distanceMeters/1000).toFixed(1)+'km','first:',n3.data?.steps?.[0]?.instruction);
await gps(m);const tr=await api(c.token,'GET','/api/v1/shipments/'+s.data.id+'/tracking');log('Customer tracking',tr.status,JSON.stringify(tr.data).slice(0,300));
// Screens
const require=createRequire('/tmp/ui/x.js');const {chromium}=require('playwright');
const js={c:fs.readFileSync('/tmp/ui/customer.js'),r:fs.readFileSync('/tmp/ui/rider.js')},ml=fs.readFileSync('/tmp/ui/node_modules/maplibre-gl/dist/maplibre-gl.js'),mlc=fs.readFileSync('/tmp/ui/node_modules/maplibre-gl/dist/maplibre-gl.css');
const b=await chromium.launch({args:['--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader']});
async function open(which,token,at,zoom){const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message.slice(0,140)));
 const apiCalls=[];
 await p.addInitScript(([t,g,z])=>{localStorage.setItem('elesend.session',t);window.__GPS=g;window.__ZOOM=z;window.__TILES={tiles:'http://127.0.0.1:3145/tiles/{z}/{x}/{y}.pbf',glyphs:'http://127.0.0.1:3145/fonts/{fontstack}/{range}.pbf'};},[token,at,zoom]);
 await p.route('**/*',async route=>{const u=new URL(route.request().url());if(u.hostname==='127.0.0.1')return route.continue();
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><style>${mlc}html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id=root></div><script>${ml}</script><script src="/b.js"></script>`});
  if(u.pathname==='/b.js')return route.fulfill({contentType:'text/javascript',body:js[which]});
  if(u.pathname.startsWith('/api/')){const res=await route.fetch({url:base+u.pathname+u.search});apiCalls.push(route.request().method()+' '+u.pathname+' '+res.status());return route.fulfill({response:res,headers:{...res.headers(),'access-control-allow-origin':'*'}});}
  return route.abort();});
 await p.goto('http://ui.test/');await p.waitForTimeout(3500);return {p,errs,apiCalls};}
const shot=(p,n)=>p.screenshot({path:O+n+'.png'});
const tap=async(p,text,exact=false)=>{try{await p.getByText(text,{exact}).first().click({timeout:4000});await p.waitForTimeout(1200);return true;}catch(e){log('  could not tap',text);return false;}};
log('\n== 7. Customer app');
const C=await open('c',c.token,KASOA,14);await shot(C.p,'01-customer-home');log('Location shown:',(await C.p.locator('body').innerText()).split('\n').slice(0,6).join(' | ').slice(0,160));
await tap(C.p,'Where to?');await shot(C.p,'02-where-to');
const box=C.p.getByPlaceholder('Search landmarks, chop bars, stations in Ghana...');
try{await box.fill('Kasoa Nyinyano');await C.p.waitForTimeout(1800);await shot(C.p,'03-search-kasoa-nyinyano');log('App results for Kasoa Nyinyano:',(await C.p.locator('body').innerText()).split('\n').slice(0,26).join(' | ').slice(0,600));
 await box.fill('Nyanyano');await C.p.waitForTimeout(1800);await shot(C.p,'04-search-nyanyano');
 await box.fill('Kotoka Airport');await C.p.waitForTimeout(1800);await shot(C.p,'05-search-airport');await tap(C.p,'Kotoka International Airport');await shot(C.p,'06-airport-picked');
}catch(e){log('search box issue',e.message.slice(0,160));}
log('errors',C.errs,'calls',[...new Set(C.apiCalls)].filter(x=>!/ 200$/.test(x)).slice(0,10));
const A=await open('c',c.token,KASOA,11);await tap(A.p,'Activity');await A.p.waitForTimeout(1500);await shot(A.p,'07-customer-activity');log('Activity errors',A.errs);
log('\n== 8. Rider app');
const R=await open('r',r.token,KASOA,15);await tap(R.p,'🗺️ Route');await shot(R.p,'08-rider-route');await tap(R.p,'Start navigation');await R.p.waitForTimeout(5000);await shot(R.p,'09-rider-nav-start');
const lines=m;await R.p.evaluate(g=>{window.__GPS=g;},m);await R.p.waitForTimeout(4000);await shot(R.p,'10-rider-nav-midway');await R.p.evaluate(g=>{window.__GPS=g;},off);await R.p.waitForTimeout(9000);await shot(R.p,'11-rider-nav-off-route');
log('Rider errors',R.errs,[...new Set(R.apiCalls)].filter(x=>!/ 200$/.test(x)).slice(0,10));log('Navigation requests',R.apiCalls.filter(x=>x.includes('navigation')).length);
await b.close();
await db.close();server.close();process.exit(0);
