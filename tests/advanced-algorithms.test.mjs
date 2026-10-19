import test from 'node:test';
import assert from 'node:assert/strict';
import {decodePolyline,roadGeometry,buildRemainingRoadCorridor,aheadOnRoute} from '../services/api/algorithms/corridor.mjs';
import {smoothGps} from '../services/api/algorithms/gps.mjs';
import {calibrateETA} from '../services/api/algorithms/eta.mjs';
import {detectFraudSignals} from '../services/api/algorithms/fraud.mjs';
import {eligibleAndRank} from '../services/api/algorithms/ranking.mjs';
import {minCostBipartiteAssignment} from '../services/api/algorithms/batch.mjs';
import {ALGORITHM_KEYS} from '../services/api/algorithms/registry.mjs';
import {calculateQuote} from '../services/api/pricing.mjs';
const kasoa={latitude:5.532,longitude:-0.423},mallam={latitude:5.582,longitude:-0.311},lapaz={latitude:5.619,longitude:-0.249};
const gh=(latitude,longitude)=>({latitude,longitude});
test('12 mandatory algorithms defined, corridor and fan-out individually switchable',()=>{
 assert.equal(ALGORITHM_KEYS.length,15);assert.ok(ALGORITHM_KEYS.includes('road_corridor_discovery'));assert.ok(ALGORITHM_KEYS.includes('multi_rider_broadcast'));
});
test('Google polyline decoding returns geodetic coordinates in lon,lat order',()=>{
 const points=decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');assert.deepEqual(points,[[ -120.2,38.5],[-120.95,40.7],[-126.453,43.252]]);
 assert.throws(()=>decodePolyline('_p~iF~ps|U!'));assert.equal(roadGeometry({geometry:{encodedPolyline:'abc'}}),null);
});
test('OSRM geometry normalization rejects aerial estimates lacking geometry',()=>{
 assert.deepEqual(roadGeometry({geometry:{type:'LineString',coordinates:[[-0.4,5.5],[-0.3,5.6]]}}),[[-.4,5.5],[-.3,5.6]]);
 assert.equal(roadGeometry({distanceMeters:1000,durationSeconds:200}),null);
});
test('remaining route follows provider road geometry and joins legs without duplicated vertices',async()=>{
 const points=[kasoa,mallam,lapaz];const routes=[{geometry:{type:'LineString',coordinates:[[-.423,5.532],[-.37,5.55],[-.311,5.582]]}},{geometry:{type:'LineString',coordinates:[[-.311,5.582],[-.29,5.6],[-.249,5.619]]}}];
 let calls=0;const adapter={route:async(from,to,options)=>{assert.equal(options.vehicle,'car');assert.deepEqual(to,points[++calls]);return routes[calls-1];}};
 const result=await buildRemainingRoadCorridor(adapter,points[0],points.slice(1),{vehicle:'car'});
 assert.equal(calls,2);assert.equal(result.coordinates.length,5);
});
test('no fabricated road corridor when provider returns no real geometry',async()=>{
 const result=await buildRemainingRoadCorridor({route:async()=>({distanceMeters:123,durationSeconds:40})},kasoa,[mallam],{vehicle:'car'});
 assert.equal(result,null);
});
test('road corridor ahead check rejects passed pickup and off-corridor locations',()=>{
 const line=[[-.423,5.532],[-.311,5.582],[-.249,5.619]];
 assert.equal(aheadOnRoute(line,gh(5.558,-.365),gh(5.601,-.285),{radiusMeters:1500}).eligible,true);
 assert.equal(aheadOnRoute(line,gh(5.601,-.285),gh(5.558,-.365),{radiusMeters:1500}).eligible,false);
 assert.equal(aheadOnRoute(line,gh(5.558,-.365),gh(5.82,-.7),{radiusMeters:1500}).eligible,false);
});
test('GPS adaptive filter rejects replay and impossible jumps; does not replace raw evidence',()=>{
 const old={...gh(5.6,-.3),accuracyMeters:10,observedAt:'2026-10-18T00:00:00Z'};
 assert.equal(smoothGps(old,{...old,observedAt:'2026-10-18T00:00:00Z'}).reason,'replayed');
 assert.equal(smoothGps(old,{...gh(6.2,-.7),accuracyMeters:10,observedAt:'2026-10-18T00:00:05Z'}).reason,'implausible_jump');
 const good=smoothGps(old,{...gh(5.6002,-.3002),accuracyMeters:10,observedAt:'2026-10-18T00:00:30Z'});
 assert.equal(good.accepted,true);assert.ok(good.estimate.latitude>5.6&&good.estimate.latitude<5.6002);
});
test('ETA calibration requires verified observations and fails closed on sparse data',()=>{
 assert.equal(calibrateETA(120,Array(29).fill({verified:true,predictedSeconds:100,actualSeconds:150})).calibrated,false);
 const ok=calibrateETA(120,Array(30).fill({verified:true,predictedSeconds:100,actualSeconds:150}));assert.equal(ok.calibrated,true);assert.equal(ok.durationSeconds,180);
 assert.equal(calibrateETA(120,Array(100).fill({verified:false,predictedSeconds:100,actualSeconds:150})).calibrated,false);
});
test('fraud model yields explainable flags, never automatic punishments',()=>{
 const f=detectFraudSignals({otpFailures:7,cashShortfallMinor:100,duplicateWebhookCount:4});assert.equal(f.autoPunish,false);
 assert.ok(f.signals.some(x=>x.code==='OTP_BRUTE_FORCE'));assert.ok(f.requiresReview);
});
test('ranking first excludes unsuitable vehicle even when ETA shortest',()=>{
 const rows=eligibleAndRank([{id:'a',eligible:true,locationFresh:true,vehicleFits:false,capacityFits:true,roadVerified:true,pickupEtaSeconds:1},
  {id:'b',eligible:true,locationFresh:true,vehicleFits:true,capacityFits:true,roadVerified:true,pickupEtaSeconds:180},
  {id:'c',eligible:true,locationFresh:true,vehicleFits:true,capacityFits:true,roadVerified:true,pickupEtaSeconds:300}],{});
 assert.deepEqual(rows.map(x=>x.id),['b','c']);
});
test('batch matching finds cost-minimizing distinct riders, rejects capacity violations',()=>{
 assert.deepEqual(minCostBipartiteAssignment([[9,2],[3,8]]),{cost:5,matches:[{job:0,rider:1},{job:1,rider:0}]});
 assert.equal(minCostBipartiteAssignment([[2],[3]]).cost,Infinity);
 assert.throws(()=>minCostBipartiteAssignment(Array(13).fill([1,2])));
});
test('3 percent is calculated independently for ten successful orders in integer pesewas',()=>{
 const p={base_minor:3000,per_km_minor:0,commission_bps:300,commission_mode:'percentage'};
 const results=Array.from({length:10},()=>calculateQuote(p,0));assert.equal(results.length,10);
 assert.equal(results.reduce((sum,x)=>sum+x.commissionMinor,0),900);
 assert.equal(results.reduce((sum,x)=>sum+x.riderEarningsMinor,0),29100);
 assert.deepEqual(calculateQuote(p,0),{amountMinor:3000,commissionMinor:90,riderEarningsMinor:2910});
});
