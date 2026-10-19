import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {calculateDeliveryPrice,getSurgeMultiplier,validateGhanaBoundary,createFareHandler} from '../deliveryEngine.mjs';

const input={pickup:{lat:5.6,lng:-.2},dropoffs:[{lat:5.61,lng:-.19},{lat:5.62,lng:-.18}],vehicle:'motorcycle'};
const options={tariffs:{motorcycle:{baseMinor:1000,perKmMinor:200,perMinuteMinor:60,perExtraStopMinor:100}},
 vehicleRoutes:{motorcycle:{endpoint:'http://routing.test',profile:'driving'}},now:new Date('2026-10-19T07:00:00Z'),
 fetchImpl:async()=>new Response(JSON.stringify({code:'Ok',distances:[[0,1100,3000],[null,0,1500],[null,2000,0]],durations:[[0,120,400],[null,0,180],[null,240,0]]}))};
test('scheduled surcharge uses city zones and half-open Ghana rush-hour windows',()=>{
 for(const hour of [7,8,16,18])assert.equal(getSurgeMultiplier(5.6,-.2,hour),1.4);
 for(const hour of [6,9,15,19,23])assert.equal(getSurgeMultiplier(5.6,-.2,hour),1);
 assert.equal(getSurgeMultiplier(6.69,-1.62,8),1.4);
 assert.equal(getSurgeMultiplier(9.4,-.85,8),1);
 assert.throws(()=>getSurgeMultiplier(5.6,-.2,24));
});
test('Ghana envelope rejects invalid coordinates and ocean origin, not claiming a polygon check',()=>{
 for(const pair of [[0,0],[12,-.2],[5.6,-4],[NaN,-.2],['5.6',-.2]])assert.throws(()=>validateGhanaBoundary(...pair));
 assert.equal(validateGhanaBoundary(5.6,-.2),true);
});
test('directed open tour charges integer distance, time and stops, then splits exactly 20 percent',async()=>{
 const fare=await calculateDeliveryPrice(input,options);
 assert.deepEqual(fare.orderedDropoffIndexes,[0,1]);assert.equal(fare.totalDistanceMeters,2600);
 assert.equal(fare.durationSeconds,300);assert.equal(fare.totalMinor,2688);
 assert.equal(fare.platformCommissionMinor,538);assert.equal(fare.driverEarningMinor,2150);
 assert.equal(fare.totalMinor,fare.platformCommissionMinor+fare.driverEarningMinor);
 assert.equal(fare.platformCommissionGhs,5.38);assert.equal(fare.trafficAware,false);
});
test('routing outage fails closed by default; opt-in aerial estimate has no fabricated duration',async()=>{
 const outage={...options,fetchImpl:async()=>{throw Error('network unavailable');}};
 await assert.rejects(()=>calculateDeliveryPrice(input,outage),e=>e.status===503);
 const fare=await calculateDeliveryPrice(input,{...outage,allowEstimatedFallback:true,tariffs:{motorcycle:{baseMinor:1000,perKmMinor:200}}});
 assert.equal(fare.estimateOnly,true);assert.equal(fare.routeSource,'haversine');assert.equal(fare.durationSeconds,null);
 await assert.rejects(()=>calculateDeliveryPrice(input,{...outage,allowEstimatedFallback:true}),/without road-duration/);
});
test('authoritative disconnected route cannot silently use Haversine',async()=>{
 await assert.rejects(()=>calculateDeliveryPrice(input,{...options,allowEstimatedFallback:true,fetchImpl:async()=>new Response(JSON.stringify({code:'NoTable'}))}),e=>e.status===422);
});
test('HTTP endpoint authenticates, bounds/parses JSON and rejects client pricing overrides',async()=>{
 const token='fixture-fare-token-'.repeat(3),server=createServer(createFareHandler({apiToken:token,...options}));
 server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/api/v1/calculate-fare`;
 const send=(body,authorization=`Bearer ${token}`)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',authorization},body});
 try{
  assert.equal((await send(JSON.stringify(input),'bad-token')).status,401);
  assert.equal((await send('{')).status,400);
  assert.equal((await send(JSON.stringify({...input,commissionBps:0}))).status,400);
  assert.equal((await send('x'.repeat(17000))).status,413);
  const good=await send(JSON.stringify(input));assert.equal(good.status,200);
  assert.equal((await good.json()).totalMinor,2688);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
