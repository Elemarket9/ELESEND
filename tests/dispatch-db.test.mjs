import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {platform} from '../services/api/platform.mjs';
import {dispatchEngine} from '../services/api/dispatch.mjs';
import {fixtureRouting} from '../services/api/dispatch-routing.mjs';
const url=process.env.TEST_DATABASE_URL;
if(!url||!/^elesend_test(?:_|$)/.test(new URL(url).pathname.slice(1)))throw Error('Dedicated elesend_test database required');
const db=database(url);
const pickup={address:'Circle Bus Stop, Accra',latitude:5.5761,longitude:-0.2149};
const destination={address:'Tema Interchange, Ghana',latitude:5.665,longitude:0.001};
const req={pickup,destination,recipientPhone:'0240000400',weightG:900,description:'Sealed documents'};
// SYNTHETIC road times intentionally disagree with crow-flies proximity.
const routing=fixtureRouting(async(from,to)=>{
 const isPickup=Math.abs(to.latitude-pickup.latitude)<.00001&&Math.abs(to.longitude-pickup.longitude)<.00001;
 let durationSeconds=700,distanceMeters=12000;
 if(isPickup){const diff=Math.abs(from.latitude-pickup.latitude);
  if(diff<.001){durationSeconds=480;distanceMeters=1500;}  // Rider A, closest by GPS, slower roads.
  else if(diff<.006){durationSeconds=360;distanceMeters=3600;}
  else {durationSeconds=180;distanceMeters=2800;} // Rider B farther but connected fast road.
 }
 return {durationSeconds,distanceMeters,geometry:{type:'LineString',coordinates:[[from.longitude,from.latitude],[to.longitude,to.latitude]]}};
});
const dispatcher=dispatchEngine(db,{routing}),messages=[];
const app=platform(db,{otpKey:randomBytes(32).toString('hex'),routing,dispatch:dispatcher,sms:{async send(message){messages.push(message);}}});
const pass='Test-only-strong-password!';
async function account(n,kind='customer'){return app.register({phone:'024000'+String(n).padStart(4,'0'),password:pass,kind});}
const sample=async(r,lat,lon=pickup.longitude)=>dispatcher.riderPosition(r,{latitude:lat,longitude:lon,accuracyMeters:8,observedAt:new Date().toISOString()});
async function paid(sender){const q=await app.quote(sender,req),sh=await app.book(sender,{quoteId:q.id},randomUUID());await app.paymentConfirmed({provider:'synthetic-finance-test',eventId:randomUUID(),shipmentId:sh.id,amountMinor:sh.amount_minor,currency:'GHS'});return sh;}
const rejects=(f,status)=>assert.rejects(f,e=>e.status===status);
test('PostGIS discovery -> simulated road ETA -> exclusive offer -> OTP custody -> exact-once earnings',async()=>{
 try{
 await migrate(db);await db.query('TRUNCATE users,pricing_policies RESTART IDENTITY CASCADE');
 const admin=await account(1);await db.query("UPDATE users SET kind='admin' WHERE id=$1",[admin.id]);admin.kind='admin';
 await db.query("INSERT INTO permissions VALUES($1,'pricing:write'),($1,'verification:write'),($1,'dispatch:configure')",[admin.id]);
 await app.setPricing(admin,{baseMinor:1800,perKmMinor:110,commissionBps:300});
 const sender=await account(2),A=await account(3,'rider'),B=await account(4,'rider'),C=await account(5,'rider');
 for(const r of [A,B,C])await app.approve(admin,'riders',r.id,'approved');
 const policy=await dispatcher.getPolicy(admin);assert.equal(policy.multi_stop_enabled,false);
 await assert.rejects(()=>dispatcher.configure(admin,{searchRadiiM:[2000],candidateLimit:3,freshSeconds:75,maxSampleAgeSeconds:120,maxAccuracyM:100,maxSpeedMps:55,offerSeconds:30,retrySeconds:30,maxAttempts:15,sampleRetentionHours:24,movingUploadSeconds:15,idleUploadSeconds:60,multiStopEnabled:true}));
 // Make C busy on a different shipment. No other rider may take this parcel.
 await app.availability(C,{online:true});await sample(C,pickup.latitude+.004);
 const busy=await paid(sender),offerC=await dispatcher.dispatchShipment(busy.id);assert.equal(offerC.riderId,C.id);await app.accept(C,busy.id,offerC.offerId);
 await app.availability(A,{online:true});await app.availability(B,{online:true});
 await sample(A,pickup.latitude+.00015);await sample(B,pickup.latitude+.012);
 assert.ok((await dispatcher.availability({pickup,weightG:900})).eligibleNearbyCount>=2);
 await rejects(()=>dispatcher.riderPosition(A,{latitude:10.98,longitude:pickup.longitude,accuracyMeters:8,observedAt:new Date(Date.now()+1000).toISOString()}),422);  // unachievable sudden GPS jump
 const sh=await paid(sender),offer=await dispatcher.dispatchShipment(sh.id);
 assert.equal(offer.status,'offered');assert.equal(offer.riderId,B.id);assert.equal(offer.pickupEtaSeconds,180);
 const received=(await app.offers(B)).find(o=>o.offerId===offer.offerId);assert.equal(received.entitlement_minor,sh.amount_minor-sh.commission_minor);
 const race=await Promise.allSettled([app.accept(B,sh.id,offer.offerId),app.accept(A,sh.id,offer.offerId)]);
 assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal((await app.get(sender,sh.id)).rider_id,B.id);
 await rejects(()=>app.accept(B,sh.id,offer.offerId),409);
 const ch=await app.challenge(B,sh.id,'pickup');await rejects(()=>app.verify(A,sh.id,{challengeId:ch.challengeId,code:messages.at(-1).code}),403);
 await app.verify(B,sh.id,{challengeId:ch.challengeId,code:messages.at(-1).code});
 await rejects(()=>dispatcher.release(B,sh.id,'Cannot reach destination'),409); // custody cannot be reallocated
 await app.transition(B,sh.id,{action:'start'});
 const d=await app.challenge(B,sh.id,'delivery');const code=messages.at(-1).code;
 const finishes=await Promise.allSettled([app.verify(B,sh.id,{challengeId:d.challengeId,code}),app.verify(B,sh.id,{challengeId:d.challengeId,code})]);
 assert.equal(finishes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await app.get(sender,sh.id)).state,'COMPLETED');
 const entries=(await db.query('SELECT * FROM financial_entries WHERE shipment_id=$1',[sh.id])).rows;
 assert.equal(entries.length,1);assert.equal(entries[0].entitlement_minor,sh.amount_minor-sh.commission_minor);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM dispatch_offers WHERE shipment_id=$1 AND status='accepted'",[sh.id])).rows[0].n,1);
 // Releasing an uncollected shipment invalidates previous rider's authority.
 await app.availability(C,{online:false});const second=await paid(sender);const newOffer=await dispatcher.dispatchShipment(second.id);
 assert.ok([A.id,B.id].includes(newOffer.riderId));const winner=newOffer.riderId===A.id?A:B;
 await app.accept(winner,second.id,newOffer.offerId);const old=await app.challenge(winner,second.id,'pickup');
 await dispatcher.release(winner,second.id,'Cannot reach the pickup');
 await rejects(()=>app.verify(winner,second.id,{challengeId:old.challengeId,code:messages.at(-1).code}),403);
 assert.equal((await app.get(sender,second.id)).rider_id,null);
 const retry=await dispatcher.dispatchShipment(second.id);assert.equal(retry.status,'offered');assert.notEqual(retry.riderId,winner.id);
 const newWinner=retry.riderId===A.id?A:B;await app.accept(newWinner,second.id,retry.offerId);
 const commitment=(await db.query('SELECT rider_id FROM dispatch_commitments WHERE shipment_id=$1',[second.id])).rows;
 assert.equal(commitment.length,1);assert.equal(commitment[0].rider_id,newWinner.id); // old commitment MUST be cleared on release
 }finally{await db.close();}
});
