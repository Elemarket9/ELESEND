import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {ETA_ASSUMPTIONS as A,calculateStageEta,classifyGps,routeDecision,positionOnRoute,etaRange,stabilizeArrival,summarizeTripEvidence,travelAdjustment,timeBucket,cityBucket} from '../services/api/eta/stage-eta.mjs';
import {etaService} from '../services/api/eta/eta-service.mjs';

const NOW=Date.parse('2026-11-03T12:00:00Z');
const GOOD={quality:'good',usable:true};
const inSeconds=s=>new Date(NOW+s*1000).toISOString();

test('food preparation and rider travel run in parallel, not added together',()=>{
 const base={state:'RIDER_ASSIGNED',isFood:true,foodState:'PREPARING',gps:GOOD,pickupToDropoffSeconds:600,now:NOW};
 const slowerKitchen=calculateStageEta({...base,foodReadyAt:inSeconds(900),riderToPickupSeconds:300});
 assert.equal(slowerKitchen.remainingSeconds,900+A.pickupHandoverSeconds+600+A.dropoffHandoverSeconds);
 const slowerRider=calculateStageEta({...base,foodReadyAt:inSeconds(100),riderToPickupSeconds:300});
 assert.equal(slowerRider.remainingSeconds,300+A.pickupHandoverSeconds+600+A.dropoffHandoverSeconds);
 const ready=calculateStageEta({...base,foodState:'READY_FOR_PICKUP',foodReadyAt:inSeconds(900),riderToPickupSeconds:300});
 assert.equal(ready.breakdown.prepRemainingSeconds,0);
 const overdue=calculateStageEta({...base,foodReadyAt:inSeconds(-500),riderToPickupSeconds:300});
 assert.equal(overdue.breakdown.prepRemainingSeconds,0);
});

test('parcels have no preparation time, and later stages count only what remains',()=>{
 const parcel=calculateStageEta({state:'RIDER_ASSIGNED',gps:GOOD,riderToPickupSeconds:300,pickupToDropoffSeconds:600,foodReadyAt:inSeconds(5000),now:NOW});
 assert.equal(parcel.remainingSeconds,300+A.pickupHandoverSeconds+600+A.dropoffHandoverSeconds);
 for(const state of ['PICKUP_VERIFIED','IN_TRANSIT']){
  assert.equal(calculateStageEta({state,gps:GOOD,riderToDropoffSeconds:400,now:NOW}).remainingSeconds,400+A.dropoffHandoverSeconds);
 }
 assert.equal(calculateStageEta({state:'AWAITING_DELIVERY_OTP',gps:GOOD,now:NOW}).remainingSeconds,A.dropoffHandoverSeconds);
});

test('no arrival time is promised before a rider is assigned',()=>{
 for(const [input,reason] of [
  [{state:'AWAITING_ASSIGNMENT'},'awaiting_rider'],
  [{state:'AWAITING_ASSIGNMENT',isFood:true,foodState:'PREPARING'},'awaiting_rider'],
  [{state:'AWAITING_ASSIGNMENT',isFood:true,foodState:'PLACED'},'awaiting_kitchen'],
  [{state:'AWAITING_PAYMENT'},'awaiting_payment']
 ]){
  const eta=calculateStageEta({...input,now:NOW});
  assert.equal(eta.status,'unavailable');assert.equal(eta.reason,reason);assert.ok(eta.customerMessage);assert.equal(eta.remainingSeconds,null);
 }
});

test('GPS quality: good, missing, lost, stale, inaccurate and jumping',()=>{
 const fix={latitude:5.6,longitude:-0.2,accuracyMeters:10,updatedAt:inSeconds(-10)};
 const quality=f=>classifyGps(f,{now:NOW});
 assert.equal(quality(fix).quality,'good');
 assert.equal(quality({...fix,latitude:null}).usable,false);
 assert.equal(quality({...fix,updatedAt:null}).quality,'missing');
 assert.equal(quality({...fix,updatedAt:inSeconds(-700)}).usable,false);
 assert.equal(quality({...fix,updatedAt:inSeconds(-200)}).quality,'stale');
 assert.equal(quality({...fix,accuracyMeters:90}).quality,'inaccurate');
 assert.equal(quality({...fix,accuracyMeters:undefined}).quality,'inaccurate');
 assert.equal(quality({...fix,previous:{latitude:5.7,longitude:-0.2,observedAt:inSeconds(-20)}}).quality,'jumping');
});

test('poor GPS lowers confidence, and lost GPS gives no estimate',()=>{
 const input={state:'IN_TRANSIT',riderToDropoffSeconds:400,now:NOW};
 assert.equal(calculateStageEta({...input,gps:GOOD}).confidence,'medium');
 for(const quality of ['stale','inaccurate','jumping'])assert.equal(calculateStageEta({...input,gps:{quality,usable:true}}).confidence,'low');
 assert.equal(calculateStageEta({...input,gps:{quality:'lost',usable:false}}).reason,'no_location');
 assert.equal(calculateStageEta({...input,gps:null}).reason,'no_location');
});

test('routes are reused on the route, and recalculated on deviation, new stage or age',()=>{
 const geometry=[[-0.2,5.6],[-0.2,5.62]];
 const cached={stage:'IN_TRANSIT',computedAt:new Date(NOW-30000).toISOString(),durationSeconds:600,geometry};
 const halfway=routeDecision({cached,stage:'IN_TRANSIT',position:{latitude:5.61,longitude:-0.2},now:NOW});
 assert.equal(halfway.recalculate,false);
 assert.ok(Math.abs(halfway.remainingSeconds-300)<5);
 assert.equal(routeDecision({cached,stage:'IN_TRANSIT',position:{latitude:5.61,longitude:-0.19},now:NOW}).reason,'route_deviation');
 assert.equal(routeDecision({cached,stage:'PICKUP_VERIFIED',position:{latitude:5.61,longitude:-0.2},now:NOW}).reason,'stage_changed');
 assert.equal(routeDecision({cached:{...cached,computedAt:new Date(NOW-400000).toISOString()},stage:'IN_TRANSIT',position:{latitude:5.61,longitude:-0.2},now:NOW}).reason,'route_expired');
 assert.equal(routeDecision({cached:null,stage:'IN_TRANSIT',position:{latitude:5.61,longitude:-0.2},now:NOW}).reason,'no_route_yet');
 assert.equal(positionOnRoute({latitude:5.6,longitude:-0.2},[[-0.2,5.6]]),null);
});

test('without a road route there is no estimate, never a straight-line one',()=>{
 for(const input of [{state:'IN_TRANSIT'},{state:'RIDER_ASSIGNED',riderToPickupSeconds:100},{state:'RIDER_ASSIGNED',pickupToDropoffSeconds:100}]){
  const eta=calculateStageEta({...input,gps:GOOD,now:NOW});
  assert.equal(eta.status,'unavailable');assert.equal(eta.reason,'no_route');assert.match(eta.customerMessage,/cannot estimate/);
 }
 const tracker=readFileSync(new URL('../services/api/infrastructure/maps/web-tracker.mjs',import.meta.url),'utf8');
 assert.equal(tracker.includes('straight_line_approximation'),false);
 assert.equal(tracker.includes('haversine'),false);
});

test('the shown arrival stays steady until it changes materially or the stage changes',()=>{
 const previous={arrivalMs:NOW+600000,stage:'IN_TRANSIT'};
 assert.deepEqual(stabilizeArrival({previous,arrivalMs:NOW+660000,stage:'IN_TRANSIT',now:NOW}),{arrivalMs:previous.arrivalMs,changed:false});
 assert.equal(stabilizeArrival({previous,arrivalMs:NOW+900000,stage:'IN_TRANSIT',now:NOW}).changed,true);
 assert.equal(stabilizeArrival({previous,arrivalMs:NOW+660000,stage:'AWAITING_DELIVERY_OTP',now:NOW}).changed,true);
 // A time that has passed cannot stay frozen on screen.
 assert.equal(stabilizeArrival({previous,arrivalMs:NOW+700000,stage:'IN_TRANSIT',now:NOW+650000}).arrivalMs,NOW+700000);
});

test('weak evidence widens the range',()=>{
 const width=c=>{const r=etaRange(1200,{confidence:c});return r.maxMinutes-r.minMinutes;};
 assert.ok(width('low')>width('medium')&&width('medium')>width('high'));
 const tiny=etaRange(10,{confidence:'high'});
 assert.ok(tiny.minMinutes>=1&&tiny.maxMinutes>tiny.minMinutes);
});

test('calibration needs enough valid trips, and rejects implausible ones',()=>{
 const trips=(n,ratio)=>Array.from({length:n},()=>({predictedSeconds:1000,actualSeconds:1000*ratio}));
 const few=summarizeTripEvidence(trips(29,0.8));
 assert.equal(few.sufficient,false);
 assert.deepEqual(travelAdjustment({evidence:few,baselineFactor:0.75}).source,'assumed_baseline');
 assert.equal(travelAdjustment({evidence:few}).factor,1);
 const enough=summarizeTripEvidence(trips(30,0.8));
 const measured=travelAdjustment({evidence:enough,baselineFactor:0.75});
 assert.equal(measured.source,'measured');assert.equal(measured.factor,0.8);
 const noisy=summarizeTripEvidence([...trips(5,1),{predictedSeconds:1000,actualSeconds:9000},{predictedSeconds:1000,actualSeconds:10},{predictedSeconds:30,actualSeconds:30},{predictedSeconds:null,actualSeconds:30}]);
 assert.equal(noisy.sampleCount,5);assert.equal(noisy.rejectedCount,4);
 assert.equal(travelAdjustment({evidence:summarizeTripEvidence(trips(30,3))}).factor,1.7);
});

test('time buckets use Ghana time, and city buckets cover Accra and Kumasi',()=>{
 assert.equal(timeBucket('2026-11-03T07:30:00Z'),'morning_peak');
 assert.equal(timeBucket('2026-11-03T17:30:00+00:00'),'evening_peak');
 assert.equal(timeBucket('2026-11-03T18:30:00+01:00'),'evening_peak');
 assert.equal(timeBucket('2026-11-03T23:30:00Z'),'off_peak');
 assert.equal(cityBucket({latitude:5.6,longitude:-0.19}),'accra');
 assert.equal(cityBucket({latitude:6.69,longitude:-1.62}),'kumasi');
 assert.equal(cityBucket({latitude:9.4,longitude:-0.84}),'other');
 assert.equal(cityBucket(null),'other');
});

function serviceDb(row,log=[]){
 return {log,query:async(sql,params)=>{
  log.push({sql,params});
  if(sql.includes('FROM shipments s JOIN quotes'))return {rows:row?[row]:[],rowCount:row?1:0};
  return {rows:[],rowCount:1};
 }};
}
const active={id:'s1',state:'IN_TRANSIT',rider_id:'r1',request:{vehicle:'motorcycle',pickup:{latitude:5.5,longitude:-0.2},destination:{latitude:5.6,longitude:-0.2}},rider_latitude:5.55,rider_longitude:-0.2,rider_updated_at:new Date(NOW-5000).toISOString(),position_accuracy_m:10};
const roadLeg={source:'routing-provider',durationSeconds:1000,distanceMeters:5000,geometry:{type:'LineString',coordinates:[[-0.2,5.55],[-0.2,5.6]]}};

test('the motorcycle baseline changes only the customer estimate, and is recorded as an assumption',async()=>{
 const db=serviceDb(active);
 const eta=await etaService(db,{routing:{route:async()=>roadLeg},baselineFactors:{motorcycle:0.75},now:()=>NOW}).customerEta('s1');
 assert.equal(eta.status,'estimated');
 assert.equal(eta.confidence,'medium');
 assert.ok(eta.minMinutes<=Math.ceil((750+A.dropoffHandoverSeconds)/60)&&eta.maxMinutes>=Math.ceil((750+A.dropoffHandoverSeconds)/60));
 const prediction=db.log.find(c=>c.sql.includes('INTO eta_predictions'));
 assert.equal(prediction.params[8],1000);assert.equal(prediction.params[9],750);assert.equal(prediction.params[11],'assumed_baseline');
});

test('customers never see internal routing or GPS detail',async()=>{
 const service=etaService(serviceDb(active),{routing:{route:async()=>roadLeg},baselineFactors:{motorcycle:0.75},now:()=>NOW});
 const eta=await service.customerEta('s1');
 assert.deepEqual(Object.keys(eta).sort(),['arrivalAt','confidence','maxMinutes','message','minMinutes','stage','status']);
});

test('routing failure and service errors give an honest unavailable state',async()=>{
 const down=await etaService(serviceDb(active),{routing:{route:async()=>{throw Error('down');}},now:()=>NOW}).customerEta('s1');
 assert.equal(down.status,'unavailable');assert.equal(down.reason,'no_route');
 const noRouting=await etaService(serviceDb(active),{now:()=>NOW}).customerEta('s1');
 assert.equal(noRouting.reason,'no_route');
 const broken=await etaService({query:async()=>{throw Error('db');}},{now:()=>NOW}).customerEta('s1');
 assert.equal(broken.status,'unavailable');
});

test('other stops before this delivery add time and lower confidence',async()=>{
 const stops=[{shipmentId:'other',kind:'dropoff',latitude:5.57,longitude:-0.2},{shipmentId:'s1',kind:'dropoff',latitude:5.6,longitude:-0.2}];
 const calls=[];
 const service=etaService(serviceDb({...active,plan_stops:stops}),{routing:{route:async(a,b)=>{calls.push(b);return roadLeg;}},now:()=>NOW});
 const result=await service.customerEta('s1');
 assert.equal(calls.length,2);
 assert.equal(result.confidence,'low');
});

test('ETA reports and diagnostics need the right permission',async()=>{
 const denied={query:async()=>({rows:[],rowCount:0})};
 const service=etaService(denied,{now:()=>NOW});
 await assert.rejects(service.accuracyReport({id:'a',kind:'customer'}),e=>e.status===403);
 await assert.rejects(service.accuracyReport({id:'a',kind:'admin'}),e=>e.status===403);
 await assert.rejects(service.diagnostics({id:'a',kind:'admin'},'s1'),e=>e.status===403);
});

test('the booking screen no longer shows made-up arrival times',()=>{
 const app=readFileSync(new URL('../apps/mobile/src/customer/CustomerApp.js',import.meta.url),'utf8');
 assert.equal(/13 min|15 min|vehicleEtaBadge/.test(app),false);
 assert.match(app,/deliveryEta\.message/);
});

test('production starts map services by default, and raw road times stay in routing',()=>{
 const compose=readFileSync(new URL('../deploy/runtime/compose.yaml',import.meta.url),'utf8');
 for(const service of ['osrm:','osrm-motorcycle:','maps:'])assert.ok(compose.includes('  '+service),service);
 assert.ok(!compose.includes('profiles: [maps]'));
 assert.match(readFileSync(new URL('../deploy/runtime/Caddyfile',import.meta.url),'utf8'),/reverse_proxy maps:3145/);
 assert.equal(readFileSync(new URL('../services/api/dispatch-routing.mjs',import.meta.url),'utf8').includes('durationFactors'),false);
});

test('timeline records and measured accuracy work against PostgreSQL',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {database}=await import('../services/api/db.mjs');
 const {migrate}=await import('../scripts/migrate.mjs');
 const configured=new URL(process.env.TEST_DATABASE_URL);
 assert.match(configured.pathname,/^\/elesend_test/);
 const db=database(configured.toString());
 try{
  await migrate(db);
  const phone=()=>'+23324'+String(randomInt(0,10000000)).padStart(7,'0');
  const customer=randomUUID(),rider=randomUUID(),admin=randomUUID(),quote=randomUUID(),shipment=randomUUID();
  for(const [id,kind] of [[customer,'customer'],[rider,'rider'],[admin,'admin']])await db.query('INSERT INTO users(id,phone,password_hash,kind) VALUES($1,$2,$3,$4)',[id,phone(),'x',kind]);
  await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'shipments:read')",[admin]);
  await db.query("INSERT INTO riders(id,vehicle,max_weight_g,status,online) VALUES($1,'motorcycle',20000,'approved',true)",[rider]);
  const policy=(await db.query('SELECT id FROM pricing_policies LIMIT 1')).rows[0].id;
  const request={vehicle:'motorcycle',pickup:{address:'A',latitude:5.5,longitude:-0.2},destination:{address:'B',latitude:5.6,longitude:-0.2},recipientPhone:'+233241234567',weightG:100,description:'Test'};
  await db.query("INSERT INTO quotes(id,customer_id,policy_id,request,amount_minor,commission_minor,expires_at,payment_method) VALUES($1,$2,$3,$4,1000,130,now()+interval '1 hour','MOMO')",[quote,customer,policy,JSON.stringify(request)]);
  await db.query("INSERT INTO shipments(id,customer_id,quote_id,idempotency_key,state,recipient_phone,amount_minor,commission_minor,payment_method,paid) VALUES($1,$2,$3,$4,'AWAITING_ASSIGNMENT','+233241234567',1000,130,'MOMO',true)",[shipment,customer,quote,randomUUID()]);
  const stop=kind=>({shipmentId:shipment,kind,weightG:100,latitude:5.5,longitude:-0.2});
  await db.query('INSERT INTO rider_dispatch_plans(rider_id,revision,stops) VALUES($1,1,$2)',[rider,JSON.stringify([stop('pickup'),stop('dropoff')])]);
  await db.query("UPDATE shipments SET rider_id=$2,state='RIDER_ASSIGNED' WHERE id=$1",[shipment,rider]);
  const consumedChallenge=purpose=>db.query("INSERT INTO challenges(id,shipment_id,rider_id,purpose,phone,digest,expires_at,sent,consumed_at) VALUES($1,$2,$3,$4,'+233241234567','x',now()+interval '5 minutes',true,now())",[randomUUID(),shipment,rider,purpose]);
  await consumedChallenge('pickup');
  await db.query("UPDATE shipments SET state='PICKUP_VERIFIED' WHERE id=$1",[shipment]);
  await db.query('INSERT INTO locations(shipment_id,rider_id,latitude,longitude,updated_at) VALUES($1,$2,5.55,-0.2,now())',[shipment,rider]);
  await db.query('UPDATE riders SET position_accuracy_m=10 WHERE id=$1',[rider]);
  const service=etaService(db,{routing:{route:async()=>roadLeg},baselineFactors:{motorcycle:0.75}});
  const eta=await service.customerEta(shipment);
  assert.equal(eta.status,'estimated');
  // Rereading uses the stored route and records one prediction per stage.
  const diagnostics=await service.diagnostics({id:admin,kind:'admin'},shipment);
  assert.equal(diagnostics.diagnostics.routeRecalculated,false);
  assert.equal(diagnostics.predictions.length,1);
  await db.query("UPDATE shipments SET state='IN_TRANSIT' WHERE id=$1",[shipment]);
  await db.query("UPDATE shipments SET state='AWAITING_DELIVERY_OTP' WHERE id=$1",[shipment]);
  await consumedChallenge('delivery');
  await db.query("UPDATE shipments SET state='COMPLETED',completed_at=now() WHERE id=$1",[shipment]);
  const milestones=(await db.query('SELECT milestone FROM delivery_milestones WHERE shipment_id=$1',[shipment])).rows.map(r=>r.milestone).sort();
  assert.deepEqual(milestones,['order_created','otp_completed','picked_up','rider_assigned']);
  await db.query('SELECT record_delivery_milestone($1,$2,$3)',[shipment,'picked_up',rider]);
  assert.equal((await db.query("SELECT 1 FROM delivery_milestones WHERE shipment_id=$1 AND milestone='picked_up'",[shipment])).rowCount,1);
  const report=await service.accuracyReport({id:admin,kind:'admin'});
  assert.ok(report.groups.every(g=>Number.isInteger(g.estimate.sampleCount)));
 }finally{await db.close();}
});

test('rush-hour trip times follow measured traffic, not a shortcut',async()=>{
 const {baselineFactorFor,etaBaselineFactors,quotedEtaMinutes}=await import('../services/api/eta/baseline-factors.mjs');
 const factors=etaBaselineFactors({});
 assert.equal(baselineFactorFor(factors,'motorcycle','evening_peak'),1.4);
 assert.equal(baselineFactorFor(factors,'car','evening_peak'),2.2);
 assert.equal(baselineFactorFor(factors,'motorcycle','midday'),1);
 assert.equal(baselineFactorFor(factors,'van','evening_peak'),1);
 assert.equal(baselineFactorFor(etaBaselineFactors({ETA_BASELINE_FACTORS:'{"motorcycle":{"evening_peak":1.2}}'}),'motorcycle','evening_peak'),1.2);
 assert.throws(()=>etaBaselineFactors({ETA_BASELINE_FACTORS:'{"motorcycle":{"midday":0.1}}'}),/must be from/);
 // Kasoa to Terminal 3 at 4 pm: 39 minutes of road time. Google showed 55.
 const eta=quotedEtaMinutes(2361,1.4);
 assert.ok(eta.low<=55&&eta.high>=55,JSON.stringify(eta));
});

