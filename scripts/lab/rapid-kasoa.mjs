// LAB ONLY (temporary): a full ELESEND delivery from RAPID Courier (Accra) to GTBank Kasoa through the real API
// server, real PostGIS and the private Ghana OSRM graphs built from OpenStreetMap. Cash payment, so no payment
// provider is faked. Test setup only: phone numbers marked verified and the rider approved directly in the database
// (no SMS provider or staff account in the lab). Rider GPS is simulated along the road route ELESEND returns.
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomInt} from 'node:crypto';
import {database} from '../../services/api/db.mjs';
import {migrate} from '../migrate.mjs';

const out=(...a)=>console.log(...a);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const DB=process.env.TEST_DATABASE_URL,PORT=8099,base=`http://127.0.0.1:${PORT}`;
const osm=JSON.parse(readFileSync(process.env.OSM_MATCHES,'utf8'));
const phone=()=>'+23324'+String(randomInt(1e7)).padStart(7,'0');
const db=database(DB);await migrate(db);

const server=spawn('node',['services/api/server.mjs'],{env:{...process.env,PORT:String(PORT),DATABASE_URL:DB,NODE_ENV:'development',BACKGROUND_JOBS_ENABLED:'true',JWT_SECRET:'c'.repeat(64),
 ROUTING_OSRM_CAR_URL:'http://127.0.0.1:5001',ROUTING_OSRM_MOTORCYCLE_URL:'http://127.0.0.1:5002',ROUTING_PROVIDER_PRIORITY:'osrm',REDIS_URL:'disabled',
 OTP_KEY:'a'.repeat(64),ADMIN_MFA_ENCRYPTION_KEY:'b'.repeat(64),TRUSTED_PROXY_CIDRS:'127.0.0.1/32'},stdio:['ignore','pipe','pipe']});
let serverLog='';server.stdout.on('data',d=>serverLog+=d);server.stderr.on('data',d=>serverLog+=d);
for(let i=0;i<60;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await sleep(1000);}
async function api(token,method,path,body,headers={}){
 const t0=Date.now();const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:body?JSON.stringify(body):undefined});
 const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data,ms:Date.now()-t0};
}
async function account(kind,extra={}){
 const p=phone(),password='lab lantern river '+randomInt(1e6);
 const reg=await api(null,'POST','/api/v1/auth/register',{phone:p,password,kind,...extra});if(reg.status>=300)throw Error('register '+JSON.stringify(reg));
 const login=await api(null,'POST','/api/v1/auth/login',{phone:p,password});
 await db.query('UPDATE users SET phone_verified_at=now() WHERE id=$1',[login.data.user.id]);
 return {id:login.data.user.id,token:login.data.token,phone:p};
}
const fmt=r=>Array.isArray(r)?r.slice(0,5).map(x=>`${x.name} [${x.locality||x.city||x.region}] ${Number(x.latitude).toFixed(5)},${Number(x.longitude).toFixed(5)}`):r;
const problems=[];
try{
 out('== 0. OpenStreetMap (source of truth for where the two places are)');
 for(const [k,v] of Object.entries(osm))out(k,JSON.stringify(v).slice(0,600));

 const customer=await account('customer');
 out('\n== 1. Customer searches in ELESEND');
 const searches={};
 for(const q of ['Rapid Courier','RAPID Courier Airport','Domestic Terminal','GTBank Kasoa','GT Bank Kasoa','Kasoa new market']){
  const r=await api(customer.token,'GET','/api/v1/maps/search?q='+encodeURIComponent(q));searches[q]=r.data;out(JSON.stringify(q),r.status,r.ms+'ms',JSON.stringify(fmt(r.data)));
 }
 const near=(a,b)=>Math.hypot((a.latitude-b.latitude)*111000,(a.longitude-b.longitude)*111000*Math.cos(a.latitude*Math.PI/180));
 const pick=(label,results,truth)=>{
  const hit=(results||[]).find(x=>truth&&near(x,truth)<250);
  if(hit){out(`${label}: ELESEND search found it: ${hit.name} (${Math.round(near(hit,truth))} m from OSM)`);return {address:hit.name+', '+(hit.locality||hit.city),latitude:hit.latitude,longitude:hit.longitude};}
  problems.push(`${label} not found by ELESEND search`);
  out(`${label}: NOT found by ELESEND search; customer drops a pin at the OSM position`);
  return {address:truth.name,latitude:truth.latitude,longitude:truth.longitude};
 };
 const pickup=pick('Pickup (RAPID Courier)',searches['Rapid Courier'],osm.rapidCourier);
 const destination=pick('Drop-off (GTBank Kasoa)',searches['GTBank Kasoa'],osm.gtbankKasoa);
 for(const [k,p] of [['pickup',pickup],['destination',destination]]){const r=await api(customer.token,'GET',`/api/v1/maps/reverse?lat=${p.latitude}&lon=${p.longitude}`);out(`reverse ${k}:`,r.status,JSON.stringify(r.data).slice(0,240));}

 out('\n== 2. Quotes (real OSRM road routes)');
 const quotes={};
 for(const vehicle of ['motorcycle','car']){
  const q=await api(customer.token,'POST','/api/v1/quotes',{pickup,destination,vehicle,recipientPhone:phone(),weightG:1500,description:'Courier parcel, documents',paymentMethod:'CASH',cashPayer:'sender'});
  quotes[vehicle]=q;out(vehicle,q.status,q.ms+'ms',JSON.stringify(q.data).slice(0,900));
  if(q.status>=300)problems.push(`quote ${vehicle} ${q.status} ${JSON.stringify(q.data)}`);
 }
 const quote=quotes.motorcycle.data;
 out('\n== 3. Booking');
 const ship=await api(customer.token,'POST','/api/v1/shipments',{quoteId:quote.id},{'Idempotency-Key':'lab-'+randomInt(1e9)});
 out('book',ship.status,JSON.stringify(ship.data).slice(0,400));if(ship.status>=300)throw Error('booking failed');
 const sid=ship.data.id;

 out('\n== 4. Rider near RAPID Courier goes online');
 const rider=await account('rider',{vehicle:'motorcycle',maxWeightG:20000,name:'Kofi Lab Rider'});
 await db.query("UPDATE riders SET status='approved' WHERE id=$1",[rider.id]);
 const at=(p,dLat=0,dLon=0)=>({latitude:p.latitude+dLat,longitude:p.longitude+dLon});
 const gps=async p=>api(rider.token,'POST','/api/v1/rider/location',{latitude:p.latitude,longitude:p.longitude,accuracyMeters:8,observedAt:new Date().toISOString(),sentAt:new Date().toISOString()});
 out('online',(await api(rider.token,'POST','/api/v1/rider/availability',{online:true})).status,'gps',JSON.stringify((await gps(at(pickup,0.002,0.001))).data).slice(0,160));
 let offer=null;
 for(let i=0;i<40&&!offer;i++){await sleep(3000);const o=await api(rider.token,'GET','/api/v1/rider/offers');offer=(o.data||[]).find(x=>x.shipmentId===sid||x.shipment_id===sid);}
 out('offer after dispatch:',JSON.stringify(offer).slice(0,500));if(!offer)throw Error('no offer reached the rider');
 const acc=await api(rider.token,'POST',`/api/v1/shipments/${sid}/accept`,{offerId:offer.offerId??offer.id});out('accept',acc.status,JSON.stringify(acc.data).slice(0,200));

 out('\n== 5. Navigation to pickup and SMS-free pickup');
 const nav1=await api(rider.token,'POST','/api/v1/rider/navigation',{shipmentId:sid,...at(pickup,0.002,0.001)});
 out('nav to pickup',nav1.status,nav1.ms+'ms',`${nav1.data.distanceMeters}m ${nav1.data.durationSeconds}s steps=${nav1.data.steps?.length}`,JSON.stringify(nav1.data.steps?.slice(0,3))?.slice(0,300));
 await sleep(16000);out('gps at pickup',(await gps(pickup)).status);
 const pk=await api(rider.token,'POST',`/api/v1/shipments/${sid}/handover`,{kind:'pickup',confirmed:true});out('pickup handover',pk.status,JSON.stringify(pk.data).slice(0,300));
 if(pk.status>=300)problems.push('pickup handover '+JSON.stringify(pk.data));

 out('\n== 6. Ride to GTBank Kasoa (simulated GPS along ELESEND route, compressed in time)');
 const nav=await api(rider.token,'POST','/api/v1/rider/navigation',{shipmentId:sid,...pickup});
 out('nav to drop-off',nav.status,nav.ms+'ms',`${nav.data.distanceMeters}m ${nav.data.durationSeconds}s steps=${nav.data.steps?.length}`);
 for(const s of (nav.data.steps||[]).slice(0,40))out('  step:',s.instruction||s.maneuver||JSON.stringify(s).slice(0,120),s.distanceMeters??s.distance??'');
 const line=(nav.data.geometry?.coordinates||nav.data.coordinates||nav.data.points||[]).map(c=>Array.isArray(c)?{latitude:c[1],longitude:c[0]}:c);
 out('route points',line.length);
 const startTrack=(await api(customer.token,'GET','/api/v1/public-track/'+sid)).data;out('customer ETA at pickup:',JSON.stringify(startTrack.deliveryEta),'state',startTrack.state);
 // Move about 400 m every 15 s of real time (~96 km/h, inside the 55 m/s GPS plausibility limit).
 let travelled=0,idx=0,lastPoint=line[0]||pickup;const legM=400;const etas=[];
 while(idx<line.length-1){
  let moved=0;while(idx<line.length-1&&moved<legM){moved+=near(line[idx],line[idx+1]);idx++;}travelled+=moved;lastPoint=line[idx];
  await sleep(15000);const g=await gps(lastPoint);
  if(g.status>=300){problems.push('gps '+g.status+' '+JSON.stringify(g.data));out('gps refused',g.status,JSON.stringify(g.data));}
  if(etas.length<1||idx%Math.max(1,Math.floor(line.length/8))<3||idx>=line.length-1){const t=(await api(customer.token,'GET','/api/v1/public-track/'+sid)).data;etas.push({km:(travelled/1000).toFixed(1),eta:t.deliveryEta?.message||t.deliveryEta,stale:t.courierStale});out(`  ${(travelled/1000).toFixed(1)} km: ETA ${JSON.stringify(t.deliveryEta)?.slice(0,200)} stale=${t.courierStale}`);}
 }
 out('\n== 7. Cash and SMS-free delivery');
 const cash=await api(rider.token,'POST','/api/v1/rider/cash-report',{shipmentId:sid,reportedMinor:Number(quote.amountMinor??quote.amount_minor),cashPayer:'sender',idempotencyKey:'lab-cash-'+sid});
 out('cash report',cash.status,JSON.stringify(cash.data).slice(0,300));if(cash.status>=300)problems.push('cash report '+JSON.stringify(cash.data));
 const dl=await api(rider.token,'POST',`/api/v1/shipments/${sid}/handover`,{kind:'delivery',confirmed:true});out('delivery handover',dl.status,JSON.stringify(dl.data).slice(0,300));
 if(dl.status>=300)problems.push('delivery handover '+JSON.stringify(dl.data));
 const finalShip=(await api(customer.token,'GET','/api/v1/shipments/'+sid)).data;out('final state',finalShip.state,'amount',finalShip.amount_minor);
 const fin=(await api(rider.token,'GET','/api/v1/rider/finance')).data;out('rider finance',JSON.stringify(fin).slice(0,600));
 const ledger=(await db.query(`SELECT count(*)::int AS unbalanced FROM (SELECT journal_id FROM finance_lines GROUP BY journal_id HAVING sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END)<>0) x`).catch(e=>({rows:[{unbalanced:'n/a '+e.message}]}))).rows[0];
 out('ledger journals out of balance:',JSON.stringify(ledger));
}catch(e){problems.push('STOPPED: '+e.message);out('STOPPED',e.stack);}
finally{
 out('\n== Problems found:',problems.length?'\n- '+problems.join('\n- '):'none');
 out('\n== Server warnings/errors:');out(serverLog.split('\n').filter(l=>/"level":"(warn|error)"|Error/.test(l)).slice(0,40).join('\n'));
 server.kill();await db.close();
}
