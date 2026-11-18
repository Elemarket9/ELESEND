import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import {calculateQuote,waitingFeeMinor} from '../services/api/modules/orders/pricing.mjs';
import {applicableTolls,routePasses} from '../services/api/modules/orders/toll-rules.mjs';

const approved={base_minor:1200,per_km_minor:320,per_minute_minor:25,minimum_minor:2000,commission_bps:1300};

test('approved tariff reproduces the Kasoa to Terminal 3 quote from the real road route',()=>{
 const q=calculateQuote(approved,35341,{durationSeconds:2361,surgeBps:14000});
 assert.equal(q.amountMinor,18892);
 assert.equal(q.commissionMinor,2456);
 assert.equal(q.riderEarningsMinor,16436);
 assert.deepEqual(q.breakdown,{fareMinor:18892,salesCommissionMinor:2456,bookingFeeMinor:0,tollMinor:0,minimumApplied:false});
});

test('very short trips use the minimum, and distance rounds up to the pesewa',()=>{
 const none=calculateQuote(approved,0);
 assert.equal(none.amountMinor,2000);
 assert.equal(none.breakdown.minimumApplied,true);
 assert.equal(calculateQuote({...approved,minimum_minor:0},1).amountMinor,1201);
});

test('a toll reaches the rider in full, with no commission or multiplier on it',()=>{
 const without=calculateQuote(approved,10000,{surgeBps:14000});
 const withToll=calculateQuote(approved,10000,{surgeBps:14000,tollMinor:500});
 assert.equal(withToll.amountMinor-without.amountMinor,500);
 assert.equal(withToll.commissionMinor,without.commissionMinor);
 assert.equal(withToll.riderEarningsMinor-without.riderEarningsMinor,500);
});

test('a booking fee stays with the platform and leaves rider earnings alone',()=>{
 const plain=calculateQuote(approved,10000);
 const fee=calculateQuote({...approved,booking_fee_bps:500},10000);
 assert.equal(fee.breakdown.bookingFeeMinor,Math.round(plain.amountMinor*0.05));
 assert.equal(fee.riderEarningsMinor,plain.riderEarningsMinor);
 assert.throws(()=>calculateQuote({...approved,booking_fee_bps:3001},10000),/limit/);
});

test('money always adds up, for any inputs',()=>{
 for(let i=0;i<3000;i++){
  const policy={base_minor:randomInt(5000),per_km_minor:randomInt(2000),per_minute_minor:randomInt(300),minimum_minor:randomInt(5000),commission_bps:randomInt(10001),booking_fee_bps:randomInt(3001)};
  const q=calculateQuote(policy,randomInt(400000),{durationSeconds:randomInt(20000),surgeBps:10000+randomInt(10001),tollMinor:randomInt(5000)});
  for(const value of [q.amountMinor,q.commissionMinor,q.riderEarningsMinor])assert.ok(Number.isSafeInteger(value)&&value>=0);
  assert.equal(q.commissionMinor+q.riderEarningsMinor,q.amountMinor);
  assert.equal(q.breakdown.fareMinor+q.breakdown.bookingFeeMinor+q.breakdown.tollMinor,q.amountMinor);
  assert.equal(q.breakdown.salesCommissionMinor+q.breakdown.bookingFeeMinor,q.commissionMinor);
 }
});

test('unbounded or bad multipliers are refused',()=>{
 assert.throws(()=>calculateQuote(approved,1000,{surgeBps:20001}),/bounds/);
 assert.throws(()=>calculateQuote(approved,1000,{surgeBps:9999}),/bounds/);
 assert.throws(()=>calculateQuote(approved,-1),/Invalid/);
 assert.throws(()=>calculateQuote(approved,1.5),/Invalid/);
});

const toll={id:'t',name:'Test toll',latitude:5.6,longitude:-0.2,radius_m:50,vehicles:['car'],amount_minor:300,source:'Road authority notice',effective_from:'2026-01-01T00:00:00Z',effective_to:null};
const across={coordinates:[[-0.21,5.6],[-0.19,5.6]]};
const away={coordinates:[[-0.21,5.62],[-0.19,5.62]]};
const at='2026-11-05T12:00:00Z';

test('a toll applies only on a route through it, for its vehicle, in its dates',()=>{
 assert.equal(applicableTolls([toll],{geometry:across,vehicle:'car',at}).length,1,'a long straight road segment still counts');
 assert.equal(applicableTolls([toll],{geometry:away,vehicle:'car',at}).length,0);
 assert.equal(applicableTolls([toll],{geometry:across,vehicle:'motorcycle',at}).length,0);
 assert.equal(applicableTolls([{...toll,effective_to:'2026-02-01T00:00:00Z'}],{geometry:across,vehicle:'car',at}).length,0);
 assert.equal(applicableTolls([{...toll,effective_from:'2027-01-01T00:00:00Z'}],{geometry:across,vehicle:'car',at}).length,0);
 assert.equal(applicableTolls([],{geometry:across,vehicle:'car',at}).length,0);
 assert.equal(routePasses(null,{latitude:5.6,longitude:-0.2},50),false,'no route geometry charges nothing');
});

test('waiting needs a rate, passes the free minutes, and has a limit',()=>{
 const rules={freeMinutes:5,maxMinor:1500};
 assert.equal(waitingFeeMinor(600,0,rules),0);
 assert.equal(waitingFeeMinor(300,50,rules),0);
 assert.equal(waitingFeeMinor(301,50,rules),50);
 assert.equal(waitingFeeMinor(36000,50,rules),1500);
});

test('new riders get the approved GH₵150 cash debt limit, existing limits stay',()=>{
 const sql=readFileSync(new URL('../database/migrations/068_cash_debt_default.sql',import.meta.url),'utf8');
 assert.match(sql,/SET DEFAULT 15000/);
 assert.doesNotMatch(sql.replace(/--.*$/gm,''),/UPDATE/i);
});

test('a fare refuses pins far from the road and routes shorter than the pins allow; dispatch keeps its wider limit',async()=>{
 const {osrmRouting}=await import('../services/api/modules/maps/osrm-routing.mjs');
 const from={latitude:5.60,longitude:-0.20},to={latitude:5.60,longitude:-0.145};
 const stub=(distance,snap)=>osrmRouting({endpoint:'http://o:5000',profiles:{car:'car'},fetchImpl:async()=>({ok:true,status:200,json:async()=>({code:'Ok',routes:[{distance,duration:300,geometry:{type:'LineString',coordinates:[]}}],waypoints:[{distance:snap},{distance:snap}]})})});
 await assert.rejects(stub(7000,600).route(from,to,{vehicle:'car',billing:true}),/too far from a mapped road/);
 await assert.rejects(stub(1600,100).route(from,to,{vehicle:'car',billing:true}),/too short/);
 assert.equal((await stub(7000,100).route(from,to,{vehicle:'car',billing:true})).distanceMeters,7000);
 assert.equal((await stub(7000,600).route(from,to,{vehicle:'car'})).distanceMeters,7000);
});

test('the approved motorbike tariff prices Kasoa New Market to Tip Toe Lane at about GH₵100 in the rush',()=>{
 const bike={base_minor:700,per_km_minor:170,per_minute_minor:90,minimum_minor:2000,commission_bps:1300};
 const seconds=2082,normal=calculateQuote(bike,29850,{durationSeconds:seconds});
 const rush=calculateQuote(bike,29850,{durationSeconds:Math.round(seconds*1.4)});
 assert.equal(normal.amountMinor,8898);
 assert.equal(normal.riderEarningsMinor,7741);
 assert.equal(rush.amountMinor,10148);
 assert.equal(rush.riderEarningsMinor,8829);
 assert.equal(calculateQuote(bike,1000,{durationSeconds:180}).amountMinor,2000,'short trips keep the minimum');
 const sql=readFileSync(new URL('../database/migrations/069_motorbike_rush_by_trip_time.sql',import.meta.url),'utf8');
 assert.match(sql,/vehicle='motorcycle'/);
 assert.match(sql,/'base_minor',700,'per_km_minor',170,'per_minute_minor',90,'traffic_time_pricing',true/);
 assert.doesNotMatch(sql,/commission_bps|minimum_minor/);
});
