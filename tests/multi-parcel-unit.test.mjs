import {test} from 'node:test';
import assert from 'node:assert/strict';
import {candidateInsertions,weightCapacityValid,freshStops,bestInsertion,evaluateStops,removeStop,removeShipment} from '../services/api/multi-parcel.mjs';
// Only a deterministic road-network fixture. These values DO NOT measure Ghana traffic.
const P=(latitude,longitude)=>({latitude,longitude});
const start=P(5.6,-.2),a=P(5.601,-.20),b=P(5.61,-.19),c=P(5.604,-.196),d=P(5.614,-.186);
const shape=(a,b)=>({durationSeconds:Math.ceil((Math.abs(a.latitude-b.latitude)+Math.abs(a.longitude-b.longitude))*10000),distanceMeters:Math.ceil((Math.abs(a.latitude-b.latitude)+Math.abs(a.longitude-b.longitude))*35000),source:'fixture'});
const routing={route:async(a,b)=>shape(a,b)};
const old=freshStops('old',{pickup:a,destination:b,weightG:800});
const next=freshStops('new',{pickup:c,destination:d,weightG:500});
test('two pickups and two drop-offs obey pickup before drop-off and bound cart load',()=>{
 assert.equal(candidateInsertions(old,next).length,6);
 assert.ok(candidateInsertions(old,next).every(plan=>plan.findIndex(x=>x.shipmentId==='new'&&x.kind==='pickup')<plan.findIndex(x=>x.shipmentId==='new'&&x.kind==='dropoff')));
 assert.equal(weightCapacityValid([...old,...next],[],1300),true);
 assert.equal(weightCapacityValid([old[0],next[0],old[1],next[1]],[],1200),false);
 assert.equal(weightCapacityValid([old[1]],['old'],1000),true);
 assert.equal(weightCapacityValid([old[1]],[],1000),false);
});
test('reject impossible detour and already-accepted delivery deadline',async()=>{
 const base=await evaluateStops(routing,start,old,{vehicle:'car',capacityG:2000});assert.ok(base);
 const blocked=await bestInsertion(routing,start,old,next,{vehicle:'car',capacityG:2000,maxDetourSeconds:0,deadlines:{old:new Date(Date.now()+1).toISOString()}});assert.equal(blocked,null);
 const other=await bestInsertion(routing,start,old,next,{vehicle:'car',capacityG:2000,maxDetourSeconds:3000,deadlines:{old:new Date(Date.now()+600000).toISOString()},maxPickupSeconds:1800});
 assert.ok(other);assert.ok(other.pickupEtaSeconds>=0);assert.equal(other.stops.length,4);
});
test('partially collected parcel remains loaded and cannot be silently double-picked',async()=>{
 const inTransit=[old[1]];
 const good=await bestInsertion(routing,start,inTransit,next,{vehicle:'car',capacityG:1300,onboardIds:['old'],deadlines:{old:new Date(Date.now()+600000).toISOString()},maxDetourSeconds:3000});assert.ok(good);
 const overlap=[next[0],old[1],next[1]];assert.equal(weightCapacityValid(overlap,['old'],1200),false);
 // In contrast, drop-off first is legal and avoids unsafe simultaneous load.
 assert.equal(weightCapacityValid([old[1],...next],['old'],1200),true);
});
test('each parcel removal preserves the other parcel stop and custody route',()=>{
 const all=[...old,...next];const pickupRemoved=removeStop(all,'old','pickup');assert.equal(pickupRemoved.length,3);
 assert.ok(pickupRemoved.some(s=>s.shipmentId==='new'&&s.kind==='pickup'));
 assert.equal(removeShipment(pickupRemoved,'old').length,2);
});
test('route provider outage or disconnected road rejects instead of Haversine fallback',async()=>{
 const broken={route:async()=>{throw Error('NoRoute');}};
 assert.equal(await evaluateStops(broken,start,next,{vehicle:'car',capacityG:3000,shipmentId:'new'}),null);
 const aerial={route:async()=>({durationSeconds:10,distanceMeters:30,source:'haversine'})};
 assert.equal(await evaluateStops(aerial,start,next,{vehicle:'car',capacityG:3000,shipmentId:'new'}),null);
});
