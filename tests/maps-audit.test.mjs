import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {calculateBearing,bearingToCardinal,buildUnmappedCommunityRoute} from '../services/api/infrastructure/maps/egia/unmapped-navigation.mjs';
import {runGeographicLearningCycle} from '../services/api/infrastructure/maps/egia/background-learner.mjs';
import {createMapLifecycleService} from '../services/api/infrastructure/maps/egia/map-lifecycle-service.mjs';
import {osrmRouting} from '../services/api/dispatch-routing.mjs';

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

function learnerDb(road,riderId){
 const updates=[];
 const samples=[0,1,2,3].map(i=>({latitude:5.6+i*0.001,longitude:-0.2,accuracyMeters:8,observedAt:new Date(Date.now()-(4-i)*60000).toISOString()}));
 return {updates,query:async(sql,params)=>{
  if(sql.includes('FROM rider_location_samples'))return {rows:[{rider_id:riderId,samples}]};
  if(sql.includes('FROM candidate_roads'))return {rows:road?[road]:[]};
  if(/UPDATE candidate_roads|INSERT INTO candidate_roads/.test(sql)){updates.push({sql,params});return {rowCount:1,rows:[]};}
  return {rows:[],rowCount:0};
 }};
}
const candidate=over=>({id:randomUUID(),status:'OBSERVED',confidence:35,observation_count:1,distinct_riders:1,created_at:new Date(),updated_at:new Date(),mean_accuracy_m:8,is_private_access:false,contributor_rider_ids:[],existing_geojson:null,...over});

test('one rider seen again does not corroborate their own road',async()=>{
 const rider=randomUUID();
 const db=learnerDb(candidate({contributor_rider_ids:[rider]}),rider);
 assert.equal((await runGeographicLearningCycle(db)).roadsCorroborated,0);
 assert.equal(db.updates.length,0);
});

test('a second, different rider corroborates a road and is recorded',async()=>{
 const first=randomUUID(),second=randomUUID();
 const db=learnerDb(candidate({contributor_rider_ids:[first]}),second);
 assert.equal((await runGeographicLearningCycle(db)).roadsCorroborated,1);
 assert.equal(db.updates[0].params.at(-1),second);
});

test('learning never changes a road an administrator has decided on',async()=>{
 for(const status of ['VERIFIED','PUBLISHED','REJECTED','RETIRED']){
  const db=learnerDb(candidate({status}),randomUUID());
  await runGeographicLearningCycle(db);
  assert.equal(db.updates.length,0,status);
 }
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
 }finally{await db.close();}
});
