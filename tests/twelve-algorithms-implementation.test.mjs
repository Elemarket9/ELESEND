import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverByRadii} from '../services/api/algorithms/discovery.mjs';
import {roadMatrixBatched,memoRoadRouting} from '../services/api/algorithms/roads.mjs';
import {classifyMovement} from '../services/api/dispatch-geometry.mjs';
import {eligibleAndRank} from '../services/api/algorithms/ranking.mjs';
import {optimizeParcelManifest} from '../services/api/algorithms/vrp.mjs';
import {bestInsertion,freshStops,weightCapacityValid} from '../services/api/multi-parcel.mjs';
import {calculateQuote} from '../services/api/pricing.mjs';
import {decideCommissionExposure} from '../services/api/algorithms/exposure.mjs';
import {verifyBalancedJournal,reconcileProviderEvents} from '../services/api/algorithms/reconciliation.mjs';
import {smoothGps} from '../services/api/algorithms/gps.mjs';
import {calibrateETA} from '../services/api/algorithms/eta.mjs';
import {detectFraudSignals} from '../services/api/algorithms/fraud.mjs';
import {aheadOnRoute} from '../services/api/algorithms/corridor.mjs';
const P=(latitude,longitude)=>({latitude,longitude});
const kasoa=P(5.532,-0.423),weija=P(5.555,-.343),mallam=P(5.582,-.311),kwashiman=P(5.607,-.282),lapaz=P(5.619,-.249),tema=P(5.669,-.011);
const road=(seconds)=>({source:'routing-provider',durationSeconds:seconds,distanceMeters:seconds*7});
// Deterministic directed roads represent a plausible synthetic corridor; NOT measured Ghana road data.
const routed=new Map();
const k=(a,b)=>`${a.latitude},${a.longitude}>${b.latitude},${b.longitude}`;
const link=(a,b,seconds)=>routed.set(k(a,b),road(seconds));
link(kasoa,weija,450);link(weija,mallam,300);link(mallam,kwashiman,280);link(kwashiman,lapaz,230);link(lapaz,tema,1400);
link(kasoa,mallam,800);link(kasoa,lapaz,1200);link(weija,kwashiman,540);link(mallam,lapaz,370);link(weija,tema,1900);link(kasoa,tema,2500);
const routing={route:async(a,b)=>{if(k(a,b)===k(b,b))return road(0);const r=routed.get(k(a,b));if(!r)throw Error('Disconnected road');return r;},
 matrix:async(points,destination)=>points.map(p=>routed.get(k(p,destination))??null)};

test('1 geospatial discovery expands configurable ranges once, deduplicates, and stops at limit',async()=>{
 const calls=[];const result=await discoverByRadii({radiiMeters:[2000,5000,10000],limit:3,queryRadius:async r=>{
  calls.push(r);return r===2000?[{id:'A'}]:[{id:'A'},{id:'B'},{id:'C'}];}});
 assert.deepEqual(calls,[2000,5000]);assert.deepEqual(result.candidates.map(c=>c.id),['A','B','C']);
 await assert.rejects(discoverByRadii({radiiMeters:[5000,2000],limit:3,queryRadius:async()=>[]}));
});
test('2 road matrix respects directed connectivity, provider outages and batching',async()=>{
 const one=await roadMatrixBatched(routing,[kasoa,weija,mallam],lapaz,{vehicle:'car',batchSize:2});
 assert.equal(one[0].durationSeconds,1200);assert.equal(one[1],null);assert.equal(one[2].durationSeconds,370);
 await assert.rejects(roadMatrixBatched({matrix:async()=>[road(5)]},[kasoa,weija],tema,{vehicle:'car'}),/Incomplete/);
 const cache=memoRoadRouting(routing);assert.equal((await cache.route(weija,mallam,{vehicle:'car'})).durationSeconds,300);
 await assert.rejects(cache.route(mallam,weija,{vehicle:'car'}),/Disconnected/);
});
test('3 movement direction is based on improving road ETA, not heading alone',()=>{
 const prev={...weija,observedAt:'2026-10-18T00:00:00Z'};
 const now={...mallam,observedAt:'2026-10-18T00:00:30Z',headingDegrees:180};
 assert.equal(classifyMovement({previous:prev,current:now,priorEtaSeconds:1100,currentEtaSeconds:800}),'approaching');
 assert.equal(classifyMovement({previous:prev,current:now,priorEtaSeconds:500,currentEtaSeconds:1100}),'moving_away');
});
test('4 ETA dispatch rejects ineligible rider regardless of proximity and sorts verified road ETA',()=>{
 const rows=eligibleAndRank([
  {id:'near-not-verified',eligible:false,locationFresh:true,vehicleFits:true,capacityFits:true,roadVerified:true,pickupEtaSeconds:1},
  {id:'A',eligible:true,locationFresh:true,vehicleFits:true,capacityFits:true,roadVerified:true,pickupEtaSeconds:480},
  {id:'B',eligible:true,locationFresh:true,vehicleFits:true,capacityFits:true,roadVerified:true,pickupEtaSeconds:180},
 ]);
 assert.deepEqual(rows.map(x=>x.id),['B','A']);
});
test('5 multi-parcel VRP produces feasible ordered manifest without exceeding capacity',async()=>{
 const existing=freshStops('A',{pickup:weija,destination:mallam,weightG:900});
 const jobs=[{id:'B',stops:freshStops('B',{pickup:mallam,destination:lapaz,weightG:900})}];
 const result=await optimizeParcelManifest(routing,kasoa,existing,jobs,{vehicle:'car',capacityG:1000,maxDetourSeconds:500,maxPickupSeconds:2000});
 assert.ok(result.feasible);assert.deepEqual(result.accepted.map(j=>j.jobId),['B']);
 assert.ok(weightCapacityValid(result.plan.stops,[],1000));
 assert.ok(result.plan.stops.findIndex(x=>x.shipmentId==='A'&&x.kind==='dropoff')<result.plan.stops.findIndex(x=>x.shipmentId==='B'&&x.kind==='pickup'));
});
test('6 road-corridor insertion rejects wrong-way roads and excessive detour',async()=>{
 const active=freshStops('A',{pickup:weija,destination:mallam,weightG:900});
 const extra=freshStops('B',{pickup:mallam,destination:lapaz,weightG:900});
 const inserted=await bestInsertion(routing,kasoa,active,extra,{vehicle:'car',capacityG:1000,maxDetourSeconds:500});
 assert.ok(inserted&&inserted.stops.length===4);
 assert.equal(await bestInsertion(routing,kasoa,active,extra,{vehicle:'car',capacityG:1000,maxDetourSeconds:10}),null);
 assert.equal(aheadOnRoute([[-.423,5.532],[-.343,5.555],[-.311,5.582],[-.249,5.619]],weija,mallam,{radiusMeters:3000}).eligible,true);
 assert.equal(aheadOnRoute([[-.423,5.532],[-.343,5.555],[-.311,5.582],[-.249,5.619]],mallam,weija,{radiusMeters:3000}).eligible,false);
});
test('7 3 percent per-order pricing uses integer pesewas, not one commission for batch',()=>{
 const pol={base_minor:3000,per_km_minor:0,commission_bps:300,commission_mode:'percentage'};
 const each=Array.from({length:10},(_,i)=>calculateQuote(pol,0));
 assert.deepEqual(each.map(x=>x.commissionMinor),Array(10).fill(90));
 assert.equal(each.reduce((a,b)=>a+b.commissionMinor,0),900);
 assert.equal(each.reduce((a,b)=>a+b.riderEarningsMinor,0),29100);
});
test('8 commission exposure includes cash jobs already accepted and blocks overspending',()=>{
 const ok=decideCommissionExposure({dueMinor:1000,reservedMinor:500,newCommissionMinor:200,creditMinor:100,limitMinor:1800,maxUnpaidJobs:10});
 assert.equal(ok.eligible,true);assert.equal(ok.exposureMinor,1600);
 const blocked=decideCommissionExposure({dueMinor:1000,reservedMinor:500,newCommissionMinor:401,creditMinor:100,limitMinor:1800,maxUnpaidJobs:10});
 assert.equal(blocked.reason,'credit_limit');
});
test('9 immutable journal arithmetic & provider reconciliation spot missing/duplicated effects',()=>{
 const posted=verifyBalancedJournal([{ledger_code:'rider_receivable',side:'debit',amount_minor:90},{ledger_code:'platform_revenue',side:'credit',amount_minor:90}]);
 assert.equal(posted.totalMinor,90);
 assert.throws(()=>verifyBalancedJournal([{ledger_code:'rider_receivable',side:'debit',amount_minor:90},{ledger_code:'platform_revenue',side:'credit',amount_minor:80}]),/Unbalanced/);
 const intents=[{id:'i1',provider:'psp',amountMinor:1000,currency:'GHS'}];
 const events=[{provider:'psp',eventId:'e1',intentId:'i1',amountMinor:1000,currency:'GHS',verified:true}];
 assert.equal(reconcileProviderEvents({intents,confirmedEvents:events,postedEventIds:['psp:e1']}).ok,true);
 assert.equal(reconcileProviderEvents({intents,confirmedEvents:[...events,...events],postedEventIds:['psp:e1']}).issues[0].reason,'duplicate_event');
});
test('10 GPS filtering rejects implausible jumps and replay but handles noisy updates',()=>{
 const prev={...weija,accuracyMeters:9,observedAt:'2026-10-18T00:00:00Z'};
 const current={...weija,longitude:weija.longitude+.0002,accuracyMeters:12,observedAt:'2026-10-18T00:00:30Z'};
 assert.equal(smoothGps(prev,current).accepted,true);
 assert.equal(smoothGps(prev,{...current,observedAt:prev.observedAt}).accepted,false);
 assert.equal(smoothGps(prev,{...tema,accuracyMeters:8,observedAt:'2026-10-18T00:00:01Z'}).reason,'implausible_jump');
});
test('11 ETA calibration uses verified historic trips and has empty-data fallback',()=>{
 assert.equal(calibrateETA(300,[]).calibrated,false);
 const evidence=Array.from({length:40},()=>({predictedSeconds:300,actualSeconds:450,verified:true}));
 assert.equal(calibrateETA(300,evidence).durationSeconds,450);
});
test('12 fraud rules flag OTP attacks and repeated payment events without auto-punishment',()=>{
 const f=detectFraudSignals({otpFailures:7,duplicateWebhookCount:5,cashShortfallMinor:100});
 assert.ok(f.requiresReview);assert.equal(f.autoPunish,false);
 assert.ok(f.signals.some(x=>x.code==='OTP_BRUTE_FORCE'));
});
test('cost-based pricing charges time/stops and discounts only when configured',()=>{
 const pol={base_minor:1000,per_km_minor:200,per_minute_minor:60,wait_per_minute_minor:30,per_extra_stop_minor:100,commission_bps:300};
 const q=calculateQuote(pol,1000,{durationSeconds:120,waitingSeconds:60,extraStops:2,surchargeMinor:50,discountMinor:100});
 assert.equal(q.amountMinor,1500);assert.equal(q.commissionMinor,45);assert.equal(q.riderEarningsMinor,1455);
 assert.throws(()=>calculateQuote(pol,0,{discountMinor:1e9}),/Discount/);
});
test('fraud algorithm detects impossible coordinate jumps but does not auto-suspend rider',()=>{
 const prev={...weija,observedAt:'2026-10-18T00:00:00Z',accuracyMeters:10};
 const next={...tema,observedAt:'2026-10-18T00:00:05Z',accuracyMeters:10};
 const result=detectFraudSignals({previousGps:prev,gps:next});
 assert.ok(result.signals.some(x=>x.code==='GPS_IMPLAUSIBLE_TRAVEL'));
 assert.equal(result.autoPunish,false);
});
test('time-based quote API and optional policy fields are wired into backend source',async()=>{
 const {readFile}=await import('node:fs/promises');
 const source=await readFile(new URL('../services/api/platform.mjs',import.meta.url),'utf8');
 assert.match(source,/calculateQuote\(p,meters,\{durationSeconds:route.durationSeconds,surgeBps\}\)/);
 assert.match(source,/perMinuteMinor/);
});
