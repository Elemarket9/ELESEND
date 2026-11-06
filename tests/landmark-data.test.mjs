import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {checkLandmarks,parseTsv,LANDMARK_COLUMNS} from '../scripts/check-landmarks.mjs';
import {database} from '../services/api/db.mjs';
const files=['data/spatial_landmarks_v9_import.tsv',...(existsSync('data/spatial_landmarks_osm_regions.tsv')?['data/spatial_landmarks_osm_regions.tsv']:[])];
const load=file=>parseTsv(readFileSync(file,'utf8'));

test('landmark files pass the import checks',()=>{
 for(const file of files)assert.deepEqual(checkLandmarks(load(file)).errors,[],file);
});
test('the check catches repeated ids, places outside Ghana and bad dates',()=>{
 const good=load(files[0])[0],bad=[good,[...good],good.map((v,i)=>i===0?'x':i===8?'0':i===19?'NOW()':v)];
 const {errors}=checkLandmarks(bad);
 assert.ok(errors.some(e=>e.includes('repeated id')));
 assert.ok(errors.some(e=>e.includes('outside Ghana')));
 assert.ok(errors.some(e=>e.includes('bad created_at')));
});
test('no landmark file claims a check it has no record of',()=>{
 for(const file of files)assert.equal(load(file).filter(r=>r[LANDMARK_COLUMNS.indexOf('verification_status')]==='source_verified').length,0);
});
test('the files load into a real database',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const url=process.env.TEST_DATABASE_URL,db=database(url);
 try{
  const has=()=>db.query('SELECT count(*)::int n FROM spatial_landmarks').then(r=>r.rows[0].n);
  const before=await has();
  await db.query("DELETE FROM spatial_landmarks WHERE id LIKE 'GEO_%' OR id LIKE 'OSM_%'");
  execFileSync('sh',['scripts/import-landmarks.sh'],{env:{...process.env,DATABASE_URL:url},stdio:'pipe'});
  const expected=files.reduce((sum,f)=>sum+load(f).length,0);
  assert.ok(await has()>=expected,String(before));
  const one=await db.query("SELECT region,ST_Y(geom::geometry) AS lat,aliases FROM spatial_landmarks WHERE id='GEO_000001'");
  assert.equal(one.rows[0].region,'Greater Accra');
  assert.ok(Math.abs(one.rows[0].lat-5.6212)<1e-4);
 }finally{await db.end?.();}
});
