import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isReliableArrival,
  rerouteCheck,
  ARRIVED_METERS
} from '../apps/mobile/src/rider/navigation-logic.mjs';

const destination={latitude:5.6037,longitude:-0.1870};
const atDestination={...destination,accuracy:8};
const completedRoute={remainingMeters:5};

test('visual arrival requires a trusted fix near both the route end and destination',()=>{
 assert.equal(isReliableArrival(atDestination,destination,completedRoute),true);
 assert.equal(isReliableArrival({...atDestination,accuracy:80},destination,completedRoute),false);
 assert.equal(isReliableArrival({...atDestination,accuracy:undefined},destination,completedRoute),false);
 assert.equal(isReliableArrival({...atDestination,latitude:5.6137},destination,completedRoute),false);
 assert.equal(isReliableArrival(atDestination,destination,{remainingMeters:ARRIVED_METERS+1}),false);
 assert.equal(isReliableArrival(null,destination,completedRoute),false);
});

test('untrusted GPS does not accumulate rerouting strikes',()=>{
 const initial={strikes:1,lastRerouteAt:0};
 for(const accuracy of [undefined,NaN,Infinity,-1,60]){
  const result=rerouteCheck(initial,{offRouteMeters:100,accuracy,now:60000});
  assert.equal(result.reroute,false);
  assert.equal(result.strikes,1);
 }
 const good=rerouteCheck(initial,{offRouteMeters:100,accuracy:10,now:60000});
 assert.equal(good.reroute,true);
});
