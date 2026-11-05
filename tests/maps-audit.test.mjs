import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {calculateBearing,bearingToCardinal,buildUnmappedCommunityRoute} from '../services/api/infrastructure/maps/egia/unmapped-navigation.mjs';
import {runGeographicLearningCycle} from '../services/api/infrastructure/maps/egia/background-learner.mjs';
import {offRoadSegments} from '../services/api/infrastructure/maps/egia/gps-quality-filter.mjs';
import {createMapLifecycleService} from '../services/api/infrastructure/maps/egia/map-lifecycle-service.mjs';
import {osrmRouting} from '../services/api/dispatch-routing.mjs';

import {verificationRules} from '../services/api/infrastructure/maps/egia/road-verification.mjs';
const verificationRulesOn=()=>verificationRules({EGIA_ENABLED:'true'});
const ACCRA={latitude:5.6,longitude:-0.2};

test('bearings point the right way from Ghana',()=>{
 const cases=[[{latitude:5.7,longitude:-0.2},'North'],[{latitude:5.5,longitude:-0.2},'South'],[{latitude:5.6,longitude:-0.1},'East'],[{latitude:5.6,longitude:-0.3},'West']];
 for(const [to,expected] of cases){
  assert.equal(bearingToCardinal(calculateBearing(ACCRA.latitude,ACCRA.longitude,to.latitude,to.longitude)),expected);
 }
});

test('a failed road route is not reported as arriving at the destination',async()=>{
 const result=await buildUnmappedCommunityRoute({
  routingAdapter:{route:async()=>{throw Error('no route');}},
  riderPosition:ACCRA,
  confirmedDestination:{latitude:5.61,longitude:-0.2}
 });
 assert.equal(result.roadRouteAvailable,false);
 assert.ok(result.unmappedFinalSegment.distanceMeters>1000);
 assert.equal(result.unmappedFinalSegment.cardinalDirection,'North');
 assert.match(result.unmappedFinalSegment.guidanceText,/No road route/);
});

test('a road disconnected from the current route is not stitched in',async()=>{
 const road=(id,coords)=>({id,name:id,allowed_vehicles:['motorcycle'],is_one_way:false,is_pedestrian_only:false,length_m:100,geojson:JSON.stringify({type:'LineString',coordinates:coords})});
 const db={query:async()=>({rows:[
  road('connected',[[-0.2,5.6],[-0.2,5.601]]),
  road('floating',[[-0.19,5.61],[-0.19,5.611]])
 ]})};
 const result=await buildUnmappedCommunityRoute({
  routingAdapter:{route:async()=>({distanceMeters:500,durationSeconds:60,geometry:{coordinates:[[-0.21,5.59],[-0.2,5.6]]}})},
  riderPosition:{latitude:5.59,longitude:-0.21},
  confirmedDestination:{latitude:5.601,longitude:-0.2},
  db
 });
 assert.deepEqual(result.candidateSegmentsUsed.map(s=>s.id),['connected']);
});

const OFF_ROAD={nearestRoadMeters:async()=>200};
const trail=(count=8,latitude=5.6)=>Array.from({length:count},(_,i)=>({latitude:latitude+i*0.001,longitude:-0.2,accuracyMeters:8,observedAt:new Date(Date.now()-(count-i)*60000).toISOString()}));
function learnerDb(road,riderId){
 const updates=[];
 const samples=trail();
 return {updates,query:async(sql,params)=>{
  if(sql.includes('FROM rider_location_samples'))return {rows:[{rider_id:riderId,samples}]};
  if(sql.includes('FROM candidate_roads'))return {rows:road?[road]:[]};
  if(/UPDATE candidate_roads\s+SET|INSERT INTO candidate_roads/.test(sql)){updates.push({sql,params});return {rowCount:1,rows:[]};}
  return {rows:[],rowCount:0};
 }};
}
const candidate=over=>({id:randomUUID(),status:'OBSERVED',confidence:35,observation_count:1,distinct_riders:1,created_at:new Date(),updated_at:new Date(),mean_accuracy_m:8,is_private_access:false,contributor_rider_ids:[],existing_geojson:null,...over});

test('one rider seen again does not corroborate their own road',async()=>{
 const rider=randomUUID();
 const db=learnerDb(candidate({contributor_rider_ids:[rider]}),rider);
 assert.equal((await runGeographicLearningCycle(db,{routing:OFF_ROAD})).roadsCorroborated,0);
 assert.equal(db.updates.length,0);
});

test('a second, different rider corroborates a road and is recorded',async()=>{
 const first=randomUUID(),second=randomUUID();
 const db=learnerDb(candidate({contributor_rider_ids:[first],created_at:new Date(Date.now()-7200000)}),second);
 assert.equal((await runGeographicLearningCycle(db,{routing:OFF_ROAD})).roadsCorroborated,1);
 assert.ok(db.updates[0].params.includes(second));
});

test('learning never changes a road an administrator has decided on',async()=>{
 for(const status of ['VERIFIED','PUBLISHED','REJECTED','RETIRED']){
  const db=learnerDb(candidate({status}),randomUUID());
  await runGeographicLearningCycle(db,{routing:OFF_ROAD});
  assert.equal(db.updates.length,0,status);
 }
});

test('riding on mapped roads creates no candidate road',async()=>{
 const db=learnerDb(null,randomUUID());
 assert.equal((await runGeographicLearningCycle(db,{routing:{nearestRoadMeters:async()=>5}})).roadsDiscovered,0);
 assert.equal(db.updates.length,0);
});

test('without road data, and when road checks fail, nothing is learned',async()=>{
 for(const options of [{},{routing:{nearestRoadMeters:async()=>{throw Error('down');}}}]){
  const db=learnerDb(null,randomUUID());
  await runGeographicLearningCycle(db,options);
  assert.equal(db.updates.length,0);
 }
});

test('off-road stretches split at roads and time gaps, and lose 100 m at each end',()=>{
 const samples=trail(20);
 const distances=samples.map((_,i)=>i===10?5:200);
 const segments=offRoadSegments(samples,distances);
 assert.equal(segments.length,2);
 assert.equal(segments[0][0],samples[1]);
 assert.equal(segments[0].at(-1),samples[8]);
 const gap=trail(4).concat(trail(4,5.7).map(s=>({...s,observedAt:new Date(Date.now()+3600000).toISOString()})));
 assert.equal(offRoadSegments(gap,gap.map(()=>200)).length,2);
});

test('routing returns raw road times, so fares and dispatch ignore the customer ETA factor',async()=>{
 const fetchImpl=async()=>new Response(JSON.stringify({code:'Ok',routes:[{distance:5000,duration:1000,geometry:{type:'LineString',coordinates:[]}}],waypoints:[]}));
 const routing=osrmRouting({endpoint:'http://osrm.test',profiles:{motorcycle:'driving'},fetchImpl});
 const leg=await routing.route({latitude:5.6,longitude:-0.2},{latitude:5.63,longitude:-0.2},{vehicle:'motorcycle'});
 assert.equal(leg.durationSeconds,1000);
});

test('the motorcycle graph no longer uses the bicycle profile',()=>{
 for(const file of ['prepare-ghana-osrm.sh','prepare-ghana-osrm.ps1'])assert.equal(readFileSync(new URL('../scripts/'+file,import.meta.url),'utf8').includes('bicycle.lua'),false,file);
});

test('van delivery is refused while its capability is off',async()=>{
 const {platform}=await import('../services/api/platform.mjs');
 const db={query:async sql=>{
  if(sql.includes('vehicle_capabilities'))return {rows:[{enabled:false}]};
  if(sql.includes('service_markets'))return {rows:[{service_enabled:true}],rowCount:1};
  return {rows:[{enabled:true}],rowCount:1};
 },tx:fn=>fn(db)};
 const place={address:'Osu, Accra',latitude:5.56,longitude:-0.18};
 const app=platform(db,{otpKey:'c'.repeat(64)});
 await assert.rejects(app.quote({id:randomUUID(),kind:'customer'},{pickup:place,destination:place,vehicle:'van',recipientPhone:'0241234567',weightG:1000,description:'Parcel',paymentMethod:'CASH'}),e=>e.status===409&&/not available/.test(e.message));
});

test('routing admits more concurrent requests than the old limit of 8',async()=>{
 let release;const gate=new Promise(r=>{release=r;});let calls=0;
 const routing=osrmRouting({endpoint:'http://osrm.test',profiles:{car:'driving'},maxInFlight:20,fetchImpl:async()=>{calls++;await gate;throw Object.assign(Error('stop'),{status:503});}});
 const a={latitude:5.6,longitude:-0.2},b={latitude:5.7,longitude:-0.2};
 const pending=Array.from({length:21},()=>routing.route(a,b).then(()=>null,e=>e.status));
 assert.equal(await pending[20],503);
 assert.equal(calls,20);
 release();await Promise.all(pending);
});

test('OSRM build scripts do not overwrite the car graph',()=>{
 for(const file of ['prepare-ghana-osrm.sh','prepare-ghana-osrm.ps1']){
  const source=readFileSync(new URL('../scripts/'+file,import.meta.url),'utf8');
  assert.match(source,/ghana-motorcycle\.osm\.pbf|\$GraphBase\.osm\.pbf/,file);
  assert.equal(source.includes('${f/ghana-latest'),false,file);
  assert.equal(source.includes('Move-Item'),false,file);
 }
});

test('the tile server can publish its port',()=>{
 const compose=readFileSync(new URL('../compose.private-maps.yaml',import.meta.url),'utf8');
 assert.match(compose,/ports: \['127\.0\.0\.1:3145:3145'\]\s+#[^\n]*\s+networks: \[egress\]/);
});

test('landmark publish and rollback work against PostgreSQL',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {database}=await import('../services/api/db.mjs');
 const {migrate}=await import('../scripts/migrate.mjs');
 const configured=new URL(process.env.TEST_DATABASE_URL);
 assert.match(configured.pathname,/^\/elesend_test/);
 const db=database(configured.toString());
 try{
  await migrate(db);
  const admin={id:randomUUID(),kind:'admin'},landmarkId=randomUUID(),roadId=randomUUID();
  await db.query("INSERT INTO users(id,phone,password_hash,kind) VALUES($1,$2,'x','admin')",[admin.id,'+23324'+String(randomInt(0,10000000)).padStart(7,'0')]);
  await db.query("INSERT INTO permissions(user_id,permission) VALUES($1,'maps:manage')",[admin.id]);
  await db.query(`INSERT INTO candidate_landmarks(id,name,search_name,category,region,locality,city,location,source)
   VALUES($1,'Audit Market','audit market','market','Greater Accra','Osu','Accra',ST_SetSRID(ST_MakePoint(-0.18,5.56),4326)::geography,'test')`,[landmarkId]);
  const maps=createMapLifecycleService(db);
  const published=await maps.publishLandmark(admin,landmarkId);
  const row=(await db.query('SELECT name,latitude,longitude,verification_status FROM spatial_landmarks WHERE id=$1',[landmarkId])).rows[0];
  assert.equal(row.name,'Audit Market');
  assert.ok(Math.abs(row.latitude-5.56)<1e-6&&Math.abs(row.longitude+0.18)<1e-6);
  assert.equal(row.verification_status,'community_verified');
  // A landmark version must not be consumed by the road rollback.
  await assert.rejects(maps.rollbackRoad(admin,published.versionTag),e=>e.status===409);
  await maps.rollbackLandmark(admin,published.versionTag);
  assert.equal((await db.query('SELECT 1 FROM spatial_landmarks WHERE id=$1',[landmarkId])).rowCount,0);
  await assert.rejects(maps.publishLandmark(admin,landmarkId),e=>e.status===409);
  // The learner's column exists and a rejected road stays unpublishable.
  await db.query(`INSERT INTO candidate_roads(id,name,corridor,status,contributor_rider_ids)
   VALUES($1,'Audit Road',ST_SetSRID(ST_GeomFromText('LINESTRING(-0.18 5.56,-0.18 5.562)'),4326)::geography,'REJECTED','{}')`,[roadId]);
  await assert.rejects(maps.publishRoad(admin,roadId,'verified on site'),e=>e.status===409);
  await assert.rejects(maps.publishRoad(admin,'not-a-uuid'),e=>e.status===400);
  // A second rider, at a different time, corroborates.
  const riders=[randomUUID(),randomUUID()],latitude=10.5+Math.random()/2;
  const learnerDbFor=rider=>({...db,query:(sql,params)=>sql.includes('FROM rider_location_samples')?Promise.resolve({rows:[{rider_id:rider,samples:trail(12,latitude)}]}):db.query(sql,params)});
  assert.equal((await runGeographicLearningCycle(learnerDbFor(riders[0]),{routing:OFF_ROAD})).roadsDiscovered,1);
  await db.query("UPDATE candidate_roads SET created_at=now()-interval '2 hours' WHERE ST_DWithin(corridor,ST_SetSRID(ST_MakePoint(-0.2,$1),4326)::geography,300)",[latitude]);
  assert.equal((await runGeographicLearningCycle(learnerDbFor(riders[1]),{routing:OFF_ROAD})).roadsCorroborated,1);
  const road=(await db.query(`SELECT status,distinct_riders,contributor_rider_ids FROM candidate_roads WHERE ST_DWithin(corridor,ST_SetSRID(ST_MakePoint(-0.2,$1),4326)::geography,300) ORDER BY created_at DESC LIMIT 1`,[latitude+0.004])).rows[0];
  assert.equal(road.status,'CORROBORATED');
  assert.equal(road.distinct_riders,2);
  assert.deepEqual([...road.contributor_rider_ids].sort(),[...riders].sort());
  assert.equal((await db.query("SELECT enabled FROM vehicle_capabilities WHERE vehicle='van'")).rows[0].enabled,false);
 }finally{await db.close();}
});

test('auto-publish needs every check to pass',async()=>{
 const {verificationFailures,verificationRules}=await import('../services/api/infrastructure/maps/egia/road-verification.mjs');
 const rules=verificationRules({EGIA_ENABLED:'true'});
 const good={status:'CORROBORATED',distinct_riders:3,temporal_span_seconds:90000,confidence:75,mean_accuracy_m:10,length_m:200,is_valid:true,join_meters:8};
 assert.deepEqual(verificationFailures(good,rules),[]);
 for(const change of [{status:'OBSERVED'},{distinct_riders:2},{temporal_span_seconds:3600},{confidence:40},{mean_accuracy_m:40},{length_m:30},{is_private_access:true},{is_pedestrian_only:true},{is_valid:false},{join_meters:200}]){
  assert.notDeepEqual(verificationFailures({...good,...change},rules),[],JSON.stringify(change));
 }
 assert.deepEqual(verificationFailures({...good,distinct_riders:2,imagery_supported:true},rules),[]);
 assert.equal(verificationRules({}).enabled,false,'off until turned on');
 assert.equal(verificationRules({EGIA_ENABLED:'true'}).enabled,true);
 assert.equal(verificationRules({EGIA_ENABLED:'true',MAP_AUTO_PUBLISH:'false'}).enabled,false);
});

test('satellite change needs more built-up surface and less vegetation, in clear cells',async()=>{
 const {cellIndexes,changedCells}=await import('../services/api/infrastructure/maps/egia/imagery-change-scan.mjs');
 const size=15,scene=(nirValue,redValue,swirValue,sclValue=4)=>({nir:Array(size*size).fill(nirValue),red:Array(size*size).fill(redValue),swir:Array(size*size).fill(swirValue),scl:Array(size*size).fill(sclValue)});
 const green=cellIndexes(scene(4000,500,1500),size,size),built=cellIndexes(scene(2000,1500,2500),size,size);
 assert.equal(changedCells(green,built).length,1);
 assert.equal(changedCells(built,green).length,0,'land getting greener is not new building');
 assert.equal(changedCells(green,green).length,0);
 assert.equal(changedCells(green,cellIndexes(scene(2000,1500,2500,9),size,size)).length,0,'cloud is ignored');
 const shifted=cellIndexes(scene(5000,1500,2500),size,size,1000);
 const plain=cellIndexes(scene(4000,500,1500),size,size);
 assert.equal(plain.cells[0].builtUp.toFixed(3),shifted.cells[0].builtUp.toFixed(3),'newer image offset is removed');
});

test('a failed satellite scan is recorded and retried, and can be turned off',async()=>{
 const {scanMapChangesIfDue}=await import('../services/api/infrastructure/maps/egia/imagery-change-scan.mjs');
 const stored=[];
 const db={query:async(sql,params)=>{if(sql.startsWith('SELECT scanned_at'))return {rows:[]};if(sql.includes('INSERT INTO map_change_scans'))stored.push(params);return {rows:[]};}};
 const area={name:'Test',bbox:[0,0,1,1]};
 const result=await scanMapChangesIfDue(db,{areas:[area],scan:async()=>{throw Error('offline');}});
 assert.match(result[0].outcome,/Scan failed: offline/);
 assert.equal(stored.length,1);
 process.env.MAP_CHANGE_SCAN='off';
 try{assert.deepEqual(await scanMapChangesIfDue(db,{areas:[area],scan:async()=>{throw Error('must not run');}}),[]);}finally{delete process.env.MAP_CHANGE_SCAN;}
});

test('EGIA on a real database: pieces join, verified roads publish with no rider ids, old suggestions go',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/elesend_test/);
 const {database}=await import('../services/api/db.mjs');
 const {migrate}=await import('../scripts/migrate.mjs');
 const db=database(process.env.TEST_DATABASE_URL);
 try{
  await migrate(db);
  await db.query('DELETE FROM geo_learning_state');
  const baseLat=5.9+Math.random()*0.5;
  const mkRider=async vehicle=>{const id=randomUUID();await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'test-only','rider',now())",[id,'+2332'+String(randomInt(10000000,99999999))]);await db.query("INSERT INTO riders(id,status,vehicle,max_weight_g) VALUES($1,'approved',$2,20000)",[id,vehicle]);return id;};
  const ride=async(rider,minutesAgo,fromStep,toStep)=>{for(let step=fromStep;step<=toStep;step++)await db.query('INSERT INTO rider_location_samples(rider_id,position,observed_at,accuracy_m) VALUES($1,ST_SetSRID(ST_MakePoint(-1.2,$2),4326)::geography,$3,8)',[rider,baseLat+step*0.0005,new Date(Date.now()-(minutesAgo*60000)+step*15000)]);};
  const nearest=async(sample,{vehicle}={})=>{seenVehicles.add(vehicle);return 200;};
  const seenVehicles=new Set();
  const routing={nearestRoadMeters:nearest};
  const vehicles=ids=>db.query('SELECT id,vehicle FROM riders WHERE id=ANY($1::uuid[])',[ids]).then(r=>new Map(r.rows.map(x=>[x.id,x.vehicle])));
  // Read from just before a ride started.
  const cycle=async minutesAgo=>{await db.query('INSERT INTO geo_learning_state(id,processed_until) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET processed_until=EXCLUDED.processed_until',[new Date(Date.now()-(minutesAgo-9)*60000)]);return runGeographicLearningCycle(db,{routing,riderVehicles:vehicles});};
  const road=()=>db.query("SELECT *,ST_Length(corridor) AS length_m FROM candidate_roads WHERE ST_DWithin(corridor,ST_SetSRID(ST_MakePoint(-1.2,$1),4326)::geography,800) ORDER BY created_at",[baseLat+0.005]).then(r=>r.rows);
  const first=await mkRider('motorcycle'),second=await mkRider('motorcycle'),third=await mkRider('car'),cyclist=await mkRider('bicycle');
  await ride(first,300,0,12);
  await cycle(300);
  assert.equal((await road()).length,1,'first trip');
  assert.ok(seenVehicles.has('motorcycle'));
  // A longer trip over the same road adds to it, instead of starting a new road.
  await db.query('DELETE FROM rider_location_samples WHERE rider_id=$1',[first]);
  await ride(second,200,0,24);
  await ride(cyclist,200,0,24);
  await cycle(200);
  let roads=await road();
  assert.equal(roads.length,1,'still one road');
  assert.equal(roads[0].distinct_riders,2);
  assert.ok(roads[0].length_m>1000,'grew to the longer trip');
  assert.equal(roads[0].contributor_rider_ids.includes(cyclist),false,'bicycle trips teach nothing');
  await db.query('DELETE FROM rider_location_samples WHERE rider_id=ANY($1::uuid[])',[[second,cyclist]]);
  // Not yet spread over a full day: confirmed, but waits.
  await ride(third,100,0,24);
  await cycle(100);
  roads=await road();
  assert.equal(roads[0].distinct_riders,3);
  assert.equal(roads[0].status,'CORROBORATED');
  assert.ok(roads[0].allowed_vehicles.includes('car'));
  // Spread over a day: it publishes itself, and rider ids are gone everywhere.
  await db.query('UPDATE candidate_roads SET temporal_span_seconds=90000 WHERE id=$1',[roads[0].id]);
  const published=await createMapLifecycleService(db).autoPublishVerified({rules:verificationRulesOn(),routing:{nearestRoadMeters:async p=>Math.abs(p.latitude-baseLat)<0.0015?10:200}});
  assert.equal(published.roadsPublished,1);
  roads=await road();
  assert.equal(roads[0].status,'PUBLISHED');
  assert.equal(roads[0].published_automatically,true);
  assert.deepEqual(roads[0].contributor_rider_ids,[]);
  const version=(await db.query('SELECT published_by,new_state FROM map_update_versions WHERE feature_id=$1',[roads[0].id])).rows[0];
  assert.equal(version.published_by,null);
  assert.equal('contributor_rider_ids' in version.new_state,false);
  // Old one-rider suggestions do not stay forever.
  const stale=randomUUID();
  await db.query("INSERT INTO candidate_roads(id,name,corridor,updated_at) VALUES($1,'Old',ST_SetSRID(ST_GeomFromText('LINESTRING(-1.3 6.2,-1.301 6.201)'),4326)::geography,now()-interval '100 days')",[stale]);
  await runGeographicLearningCycle(db,{});
  assert.equal((await db.query('SELECT 1 FROM candidate_roads WHERE id=$1',[stale])).rowCount,0);
 }finally{await db.close();}
});

test('EGIA jobs do not start unless turned on',async()=>{
 const {backgroundJobs}=await import('../services/api/background-jobs.mjs');
 const realInterval=globalThis.setInterval;
 const count=async value=>{
  if(value)process.env.EGIA_ENABLED=value;else delete process.env.EGIA_ENABLED;
  const delays=[];
  globalThis.setInterval=(fn,ms)=>{delays.push(ms);return {unref(){}};};
  try{backgroundJobs({db:{query:async()=>({rows:[]})},chat:{}}).start();}finally{globalThis.setInterval=realInterval;delete process.env.EGIA_ENABLED;}
  return delays.filter(ms=>ms===21600000).length;
 };
 assert.equal(await count(),0);
 assert.equal(await count('true'),1);
});
