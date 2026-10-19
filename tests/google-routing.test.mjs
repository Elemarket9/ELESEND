import {test} from 'node:test';
import assert from 'node:assert/strict';
import {googleRouting} from '../services/api/google-routing.mjs';
const a={latitude:5.61,longitude:-0.18},b={latitude:5.64,longitude:-0.16};
test('Google Routes adapter sends server-only credential with a constrained response fieldmask',async()=>{
 const calls=[];const routing=googleRouting({apiKey:'test-only-routing-key',fetchImpl:async(url,init)=>{calls.push({url,init});return {ok:true,json:async()=>({routes:[{distanceMeters:1200,duration:'180.5s',polyline:{encodedPolyline:'abc'}}]})};}});
 const r=await routing.route(a,b,{vehicle:'car'});assert.equal(r.distanceMeters,1200);assert.equal(r.durationSeconds,181);assert.equal(r.trafficAware,true);
 assert.equal(calls[0].url,'https://routes.googleapis.com/directions/v2:computeRoutes');assert.equal(calls[0].init.headers['X-Goog-FieldMask'],'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline');
 assert.equal(JSON.parse(calls[0].init.body).routingPreference,'TRAFFIC_AWARE');
});
test('motorcycle uses two wheeler mode in Ghana and rejects unsupported truck profile',async()=>{
 let args;const routing=googleRouting({apiKey:'test-only-routing-key',fetchImpl:async(_,opts)=>{args=JSON.parse(opts.body);return {ok:true,json:async()=>({routes:[{distanceMeters:8,duration:'1s'}]})};}});
 const r=await routing.route(a,b,{vehicle:'motorcycle'});assert.equal(r.motorcycleBeta,true);assert.equal(r.trafficAware,false);assert.equal(args.travelMode,'TWO_WHEELER');
 await assert.rejects(()=>routing.route(a,b,{vehicle:'truck'}),{status:503});
});
test('matrix results preserve origin ordering and disconnected roads',async()=>{
 let body;const routing=googleRouting({apiKey:'test-only-routing-key',fetchImpl:async(_,opts)=>{body=JSON.parse(opts.body);return {ok:true,json:async()=>[{originIndex:1,destinationIndex:0,condition:'ROUTE_NOT_FOUND',status:{}},{originIndex:0,destinationIndex:0,condition:'ROUTE_EXISTS',distanceMeters:1100,duration:'120s',status:{}}]};}});
 const r=await routing.matrix([a,b],b,{vehicle:'car'});assert.equal(body.origins.length,2);assert.equal(r[0].durationSeconds,120);assert.equal(r[1],null);
});
test('provider errors or missing matrix elements fail closed',async()=>{
 const api=googleRouting({apiKey:'test-only-routing-key',fetchImpl:async()=>({ok:true,json:async()=>[{originIndex:0,destinationIndex:0,condition:'ROUTE_EXISTS',distanceMeters:100,duration:'30s'}]})});
 await assert.rejects(()=>api.matrix([a,b],b),{status:503});
});
test('invalid coordinates and malformed provider duration cannot become ETA',async()=>{
 const api=googleRouting({apiKey:'test-only-routing-key',fetchImpl:async()=>({ok:true,json:async()=>({routes:[{distanceMeters:100,duration:'bad'}]})})});
 await assert.rejects(()=>api.route(a,b),{status:503});await assert.rejects(()=>api.route({latitude:150,longitude:0},b),{status:400});
});
