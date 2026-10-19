import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {platform} from '../services/api/platform.mjs';
import {dispatchEngine} from '../services/api/dispatch.mjs';
import {vehicleService} from '../services/api/vehicle.mjs';
import {fixtureRouting} from '../services/api/dispatch-routing.mjs';
const url=process.env.TEST_DATABASE_URL;
if(!url||!/^elesend_test(?:_|$)/.test(new URL(url).pathname.slice(1)))throw Error('A disposable dedicated elesend_test database is mandatory');
const db=database(url);
const router=fixtureRouting(async(a,b)=>({durationSeconds:Math.ceil((Math.abs(a.latitude-b.latitude)+Math.abs(a.longitude-b.longitude))*18000)+5,distanceMeters:Math.ceil((Math.abs(a.latitude-b.latitude)+Math.abs(a.longitude-b.longitude))*62000)+10,geometry:{type:'LineString',coordinates:[[a.longitude,a.latitude],[b.longitude,b.latitude]]}}));
const dispatcher=dispatchEngine(db,{routing:router}),sms=[];
const app=platform(db,{otpKey:randomBytes(32).toString('hex'),routing:router,dispatch:dispatcher,sms:{async send(v){sms.push(v);}}});
const vehicle=vehicleService(db),pickup=(lat,lon)=>({address:'Synthetic Accra test location',latitude:lat,longitude:lon});
const pass='Synthetic-benchmark-password-44';
async function user(n,kind='customer',extra={}){return app.register({phone:'024005'+String(n).padStart(4,'0'),password:pass,kind,...extra});}
async function paid(sender,p,dest,weightG){const q=await app.quote(sender,{pickup:p,destination:dest,weightG,parcelCategory:'general',parcelSize:'small',recipientPhone:'0240050900',description:'Synthetic parcel'});
 const sh=await app.book(sender,{quoteId:q.id},randomUUID());await app.paymentConfirmed({provider:'synthetic-test-only',eventId:randomUUID(),shipmentId:sh.id,amountMinor:sh.amount_minor,currency:'GHS'});return sh;}
async function handover(rider,shipmentId,kind){const ch=await app.challenge(rider,shipmentId,kind);const one=sms.at(-1);assert.equal(one.challengeId,ch.challengeId);await app.verify(rider,shipmentId,{challengeId:ch.challengeId,code:one.code});}
test('PostGIS: verified car driver accepts two bound parcels; driver route order, OTP and payouts remain independent',async()=>{
 try{
  await migrate(db);await db.query('TRUNCATE users,pricing_policies RESTART IDENTITY CASCADE');
  const admin=await user(1);await db.query("UPDATE users SET kind='admin' WHERE id=$1",[admin.id]);admin.kind='admin';
  await db.query("INSERT INTO permissions VALUES($1,'verification:write'),($1,'pricing:write'),($1,'dispatch:configure')",[admin.id]);
  await app.setPricing(admin,{baseMinor:1500,perKmMinor:110,commissionBps:300});
  const car=await user(2,'rider',{vehicle:'car',maxWeightG:3000,car:{plateNumber:'GT 1234-26',make:'Toyota',model:'Corolla',color:'White'}});
  const sender=await user(3);
  await app.approve(admin,'riders',car.id,'approved');
  await assert.rejects(()=>app.availability(car,{online:true}),e=>e.status===403);
  await vehicle.review(admin,car.id,{status:'approved'});
  await app.availability(car,{online:true});
  await dispatcher.riderPosition(car,{latitude:5.6,longitude:-.2,accuracyMeters:8,observedAt:new Date().toISOString()});
  const p=await dispatcher.getPolicy(admin);
  await dispatcher.configure(admin,{searchRadiiM:p.search_radii_m,candidateLimit:p.candidate_limit,freshSeconds:p.fresh_seconds,maxSampleAgeSeconds:p.max_sample_age_seconds,maxAccuracyM:p.max_accuracy_m,maxSpeedMps:p.max_speed_mps,offerSeconds:p.offer_seconds,retrySeconds:p.retry_seconds,maxAttempts:p.max_attempts,sampleRetentionHours:p.sample_retention_hours,movingUploadSeconds:p.moving_upload_seconds,idleUploadSeconds:p.idle_upload_seconds,multiStopEnabled:true,maxActiveParcels:2,maxDetourSeconds:900,deliverySlackSeconds:1200,maxPickupEtaSeconds:1800,maxOfferMovementM:300});
  await dispatcher.optIn(car,{enabled:true});
  const first=await paid(sender,pickup(5.601,-.199),pickup(5.608,-.192),900);
  const o1=await dispatcher.dispatchShipment(first.id);assert.equal(o1.status,'offered');assert.equal(o1.riderId,car.id);
  await app.accept(car,first.id,o1.offerId);
  const second=await paid(sender,pickup(5.603,-.197),pickup(5.611,-.189),700);
  const o2=await dispatcher.dispatchShipment(second.id);assert.equal(o2.status,'offered');assert.equal(o2.riderId,car.id);
  const listed=(await dispatcher.offers(car)).find(o=>o.offerId===o2.offerId);assert.equal(listed.existingParcels,1);
  await app.accept(car,second.id,o2.offerId);
  const manifest=await dispatcher.manifest(car);assert.equal(manifest.shipments.length,2);assert.equal(manifest.stops.length,4);
  const third=await paid(sender,pickup(5.602,-.198),pickup(5.615,-.181),200);
  const none=await dispatcher.dispatchShipment(third.id);assert.notEqual(none.status,'offered');
  for(const next of manifest.stops){const sh=await app.get(sender,next.shipmentId);
   if(next.kind==='pickup') {assert.equal(sh.state,'RIDER_ASSIGNED');await handover(car,next.shipmentId,'pickup');await app.transition(car,next.shipmentId,{action:'start'});}
   else{assert.equal(sh.state,'IN_TRANSIT');await handover(car,next.shipmentId,'delivery');}
  }
  assert.equal((await app.get(sender,first.id)).state,'COMPLETED');assert.equal((await app.get(sender,second.id)).state,'COMPLETED');
  const r=(await db.query('SELECT count(*)::int AS n FROM financial_entries WHERE shipment_id=ANY($1::uuid[])',[[first.id,second.id]])).rows[0];assert.equal(r.n,2);
  assert.equal((await dispatcher.manifest(car)).stops.length,0);
 }finally{await db.close();}
});
