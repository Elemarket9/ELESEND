import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {haversine,classifyMovement,assessDetour} from '../services/api/dispatch-geometry.mjs';
import {osrmRouting,fixtureRouting} from '../services/api/dispatch-routing.mjs';
const pickup={latitude:5.6037,longitude:-0.1869};
const a={latitude:5.6036,longitude:-0.1868},b={latitude:5.6122,longitude:-0.1881};
test('A is geographically closer than B, but simulated road-network ETA ranks B',async()=>{
 assert.ok(haversine(a,pickup)<haversine(b,pickup));
 const fixture=fixtureRouting(async(from,to)=>({distanceMeters:from===a?1400:2300,durationSeconds:from===a?480:180,geometry:{type:'LineString',coordinates:[[from.longitude,from.latitude],[to.longitude,to.latitude]]}}));
 const estimates=await fixture.matrix([a,b],pickup,{vehicle:'motorcycle'});
 assert.equal(estimates[0].durationSeconds,480);assert.equal(estimates[1].durationSeconds,180);
 assert.equal(estimates[1].source,'fixture');assert.ok(estimates[1].durationSeconds<estimates[0].durationSeconds);
});
test('map heading alone never proves direction; road ETA improvement required',()=>{
 const previous={...a,observedAt:'2026-10-17T10:00:00.000Z'},current={...b,observedAt:'2026-10-17T10:00:25.000Z'};
 assert.equal(classifyMovement({previous,current,priorEtaSeconds:200,currentEtaSeconds:170}),'approaching');
 assert.equal(classifyMovement({previous,current,priorEtaSeconds:170,currentEtaSeconds:200}),'moving_away');
 assert.equal(classifyMovement({previous,current,priorEtaSeconds:undefined,currentEtaSeconds:200}),'unknown');
 assert.equal(classifyMovement({previous,current:{...previous,observedAt:'2026-10-17T10:00:25.000Z'},priorEtaSeconds:200,currentEtaSeconds:200}),'stationary');
});
test('future corridor reuse does not authorize overweight or late route detours',()=>{
 const originalRoute={durationSeconds:1000},newRoute={durationSeconds:1450};
 assert.deepEqual(assessDetour({originalRoute,newRoute,parcelWeightG:9000,remainingCapacityG:3000,deadlineSlackSec:700,maxDetourSeconds:500}).reason,'capacity');
 assert.equal(assessDetour({originalRoute,newRoute,parcelWeightG:900,remainingCapacityG:3000,deadlineSlackSec:200,maxDetourSeconds:500}).compatible,false);
 assert.deepEqual(assessDetour({originalRoute,newRoute,parcelWeightG:900,remainingCapacityG:3000,deadlineSlackSec:700,maxDetourSeconds:500}),{compatible:true,detourSeconds:450,requiresMultiStopAuthorization:true});
});
test('OSRM adapter makes correct road-route and matrix URLs and rejects unsupported vehicle',async()=>{
 const seen=[];
 const fakeFetch=async url=>{seen.push(String(url));return {ok:true,async json(){return String(url).includes('/table/')?{code:'Ok',durations:[[480],[180]],distances:[[1400],[2300]]}:{code:'Ok',routes:[{distance:4300.5,duration:512.5,geometry:{type:'LineString',coordinates:[[-.2,5.5],[-.18,5.6]]}}]};}};};
 const routing=osrmRouting({endpoint:'https://router.example.org/osrm',profiles:{motorcycle:'driving',car:'driving'},fetchImpl:fakeFetch});
 const m=await routing.matrix([a,b],pickup,{vehicle:'motorcycle'});assert.deepEqual(m.map(r=>r.durationSeconds),[480,180]);
 const route=await routing.route(a,pickup,{vehicle:'car'});assert.equal(route.distanceMeters,4301);assert.equal(route.durationSeconds,513);
 assert.match(seen[0],/\/table\/v1\/driving\//);assert.match(seen[0],/sources=0%3B1|sources=0;1/);assert.match(seen[1],/geometries=geojson/);
 await assert.rejects(()=>routing.route(a,pickup,{vehicle:'bicycle'}),e=>e.status===503);
 assert.deepEqual(routing.capabilities.traffic,false);
});
test('OSRM unreachable routes never silently fall back to straight-line distance',async()=>{
 const routing=osrmRouting({endpoint:'https://router.example.org',profiles:{car:'driving'},fetchImpl:async()=>({ok:true,async json(){return {code:'NoRoute',routes:[]};}})});
 await assert.rejects(()=>routing.route(a,pickup),e=>e.status===422);
});
test('measured deterministic fixture ranking baseline (not an infrastructure benchmark)',()=>{
 const start=performance.now();const candidates=Array.from({length:3000},(_,i)=>({id:String(i),eta:i*3%700,direction:i%3?'unknown':'approaching'}));
 for(let n=0;n<40;n++)candidates.sort((x,y)=>x.eta-y.eta || Number(y.direction==='approaching')-Number(x.direction==='approaching') || x.id.localeCompare(y.id));
 const durationMs=performance.now()-start;assert.ok(Number.isFinite(durationMs));
 console.log(`LOCAL SYNTHETIC SORT ONLY: 40 passes × 3000 candidate records in ${durationMs.toFixed(3)} ms; excludes DB/routing/networks`);
});
