import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateQuote} from '../services/api/pricing.mjs';
import {osrmRouting} from '../services/api/dispatch-routing.mjs';
import {haversine} from '../services/api/dispatch-geometry.mjs';
import {calculateStageEta,etaRange} from '../services/api/eta/stage-eta.mjs';

/**
 * All OSRM replies below are MOCKS. The distances and travel durations are
 * deliberately chosen synthetic inputs, NOT observed Ghana road measurements.
 * Coordinates identify scenario endpoints only; they do not establish road access.
 * Use a real OSRM Ghana road graph and rider traces for any production ETA claim.
 */
const POLICY=Object.freeze({
 base_minor:1200,per_km_minor:320,per_minute_minor:25,
 minimum_minor:2000,commission_bps:1300
});
const CASES=[
 {name:'Kasoa very short',from:[5.5346,-0.4280],to:[5.5390,-0.4250],distanceMeters:800,durationSeconds:180,band:'very_short'},
 {name:'Kasoa to Budumburam',from:[5.5346,-0.4280],to:[5.5333,-0.4722],distanceMeters:6200,durationSeconds:840,band:'short'},
 {name:'Sunyani urban',from:[7.3349,-2.3123],to:[7.3600,-2.3300],distanceMeters:5400,durationSeconds:780,band:'short'},
 {name:'Cape Coast urban',from:[5.1053,-1.2466],to:[5.1160,-1.2900],distanceMeters:7200,durationSeconds:1000,band:'medium'},
 {name:'Kumasi urban',from:[6.6960,-1.6240],to:[6.6730,-1.5730],distanceMeters:8500,durationSeconds:1200,band:'medium'},
 {name:'Circle to East Legon',from:[5.5699,-0.2130],to:[5.6350,-0.1610],distanceMeters:13400,durationSeconds:1740,band:'urban_long'},
 {name:'Kasoa to Accra Airport',from:[5.5346,-0.4280],to:[5.6052,-0.1698],distanceMeters:35341,durationSeconds:2361,band:'long'},
 {name:'Kumasi to Sunyani',from:[6.6960,-1.6240],to:[7.3349,-2.3123],distanceMeters:125000,durationSeconds:9300,band:'intercity'},
 {name:'Kasoa to Kumasi',from:[5.5346,-0.4280],to:[6.6960,-1.6240],distanceMeters:275000,durationSeconds:16000,band:'very_long'}
];
const point=([latitude,longitude])=>({latitude,longitude});
function mockedOsrm(sample){
 const requested=[];
 const routing=osrmRouting({
  endpoint:'http://routing-mock.invalid:5000',profiles:{motorcycle:'driving'},fetchImpl:async url=>{
   requested.push(String(url));
   return {ok:true,status:200,json:async()=>({
    code:'Ok',
    routes:[{distance:sample.distanceMeters,duration:sample.durationSeconds,
      geometry:{type:'LineString',coordinates:[[sample.from[1],sample.from[0]],[sample.to[1],sample.to[0]]]}}],
    waypoints:[{distance:0},{distance:0}]
   })};
  }
 });
 return {routing,requested};
}
for(const sample of CASES){
 test('mock Ghana route: '+sample.name,async()=>{
  const {routing,requested}=mockedOsrm(sample);
  const from=point(sample.from),to=point(sample.to);
  const route=await routing.route(from,to,{vehicle:'motorcycle',billing:true});
  assert.equal(requested.length,1);
  assert.equal(route.source,'routing-provider','the real OSRM adapter must parse the injected mock response');
  assert.equal(route.distanceMeters,sample.distanceMeters);
  assert.equal(route.durationSeconds,sample.durationSeconds);
  const direct=haversine(from,to);
  assert.ok(route.distanceMeters>=direct*.75,'mocked billable road distance cannot be implausibly short');
  const quote=calculateQuote(POLICY,route.distanceMeters,{durationSeconds:route.durationSeconds});
  const expectedFare=Math.max(POLICY.minimum_minor,
   POLICY.base_minor+Math.ceil(route.distanceMeters*POLICY.per_km_minor/1000)+
   Math.ceil(route.durationSeconds*POLICY.per_minute_minor/60));
  assert.equal(quote.amountMinor,expectedFare);
  assert.equal(quote.amountMinor,quote.commissionMinor+quote.riderEarningsMinor);
  assert.equal(quote.breakdown.salesCommissionMinor,Math.round(expectedFare*.13));
  const gps={quality:'good',usable:true};
  const eta=calculateStageEta({state:'IN_TRANSIT',gps,riderToDropoffSeconds:route.durationSeconds});
  assert.equal(eta.status,'estimated');
  assert.equal(eta.remainingSeconds,route.durationSeconds+120,'last-meter handover included');
  const range=etaRange(eta.remainingSeconds,{confidence:eta.confidence});
  assert.ok(range.minMinutes<=Math.ceil(eta.remainingSeconds/60));
  assert.ok(range.maxMinutes>=Math.ceil(eta.remainingSeconds/60));
  console.log('SIMULATED_GHANA_ROUTE '+JSON.stringify({
   label:sample.name,band:sample.band,roadDistanceKm:route.distanceMeters/1000,
   straightLineKm:Number((direct/1000).toFixed(3)),
   mockedRoadSeconds:route.durationSeconds,etaMinMinutes:range.minMinutes,etaMaxMinutes:range.maxMinutes,
   fareGHS:(quote.amountMinor/100).toFixed(2),
   platformGHS:(quote.commissionMinor/100).toFixed(2),
   riderGHS:(quote.riderEarningsMinor/100).toFixed(2),
   provider:'MOCK OSRM response through real adapter',actualRoadDistanceVerified:false,
   realWorldEtaVerified:false
  }));
 });
}
test('mock routing failure cannot be billed as straight-line route',async()=>{
 const routing=osrmRouting({endpoint:'http://routing-mock.invalid:5000',profiles:{motorcycle:'driving'},
  fetchImpl:async()=>({ok:true,status:200,json:async()=>({code:'NoRoute'})})});
 await assert.rejects(routing.route(point(CASES[0].from),point(CASES[0].to),{vehicle:'motorcycle',billing:true}),/No connected road path/);
});
test('mocked too-short route must not generate a fare',async()=>{
 const c=CASES[6];
 const routing=osrmRouting({endpoint:'http://routing-mock.invalid:5000',profiles:{motorcycle:'driving'},
  fetchImpl:async()=>({ok:true,status:200,json:async()=>({
   code:'Ok',routes:[{distance:1000,duration:120,geometry:{type:'LineString',coordinates:[]}}],
   waypoints:[{distance:0},{distance:0}]
  })})});
 await assert.rejects(routing.route(point(c.from),point(c.to),{vehicle:'motorcycle',billing:true}),/too short/);
});
