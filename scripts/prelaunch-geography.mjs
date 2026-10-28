import assert from 'node:assert/strict';
import {database} from '../services/api/db.mjs';
import {simulationTarget} from './local-simulation-support.mjs';
import {searchInformalLocation} from '../services/api/infrastructure/maps/egia/informal-geocoder.mjs';
process.env.NODE_ENV ||= 'test';
const db=database(simulationTarget().toString());
try{
 const before=performance.now();
 const totals=(await db.query(`SELECT count(*)::int AS records,count(*) FILTER(WHERE latitude BETWEEN 4.5 AND 11.4 AND longitude BETWEEN -3.5 AND 1.5)::int AS in_ghana,count(*) FILTER(WHERE ST_IsValid(geom))::int AS valid_geometry,count(*) FILTER(WHERE verification_status='source_coordinates_not_field_verified')::int AS not_field_verified FROM mapped_restaurants`)).rows[0];
 assert(totals.records>=1000,'Load the existing geographic dataset with local:prepare first');
 assert.equal(totals.records,totals.in_ghana);assert.equal(totals.records,totals.valid_geometry);
 const nearest=(await db.query(`SELECT count(*)::int AS checked,max(distance) AS max_self_distance FROM (SELECT r.id,ST_Distance(r.geom,n.geom) AS distance FROM mapped_restaurants r CROSS JOIN LATERAL (SELECT geom FROM mapped_restaurants ORDER BY geom <-> r.geom LIMIT 1) n) verified`)).rows[0];
 assert.equal(nearest.checked,totals.records);assert.equal(Number(nearest.max_self_distance),0);
 const names=(await db.query('SELECT name,latitude,longitude FROM mapped_restaurants ORDER BY restaurant_id LIMIT 200')).rows;
 const latencies=[];let nonempty=0;
 for(const r of names){const start=performance.now();const result=await searchInformalLocation(r.name,{db,userCoordinates:{latitude:r.latitude,longitude:r.longitude},limit:8});latencies.push(performance.now()-start);if(Array.isArray(result)?result.length:result?.results?.length)nonempty++;}
 latencies.sort((a,b)=>a-b);
 console.log(JSON.stringify({scope:'Local source records; geometry and lookup validation, not field accuracy',totals,nearest,searches:names.length,nonemptySearchResults:nonempty,searchP95Ms:latencies[Math.floor(latencies.length*.95)],elapsedSeconds:(performance.now()-before)/1000,sourceRecordsUnchanged:true},null,2));
}finally{await db.close();}
