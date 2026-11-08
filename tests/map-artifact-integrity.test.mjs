import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {recordOsrm,verifyOsrm,verifyTiles} from '../scripts/map-artifact-integrity.mjs';

function fixture(fn){
 const directory=mkdtempSync(join(tmpdir(),'elesend-map-artifacts-'));
 try{return fn(directory);}finally{rmSync(directory,{recursive:true,force:true});}
}
async function graphFixture(fn){
 const directory=mkdtempSync(join(tmpdir(),'elesend-osrm-'));
 try{
  const content='fixture-only-not-a-real-osm-extract';
  writeFileSync(join(directory,'ghana-latest.osm.pbf'),content);
  writeFileSync(join(directory,'ghana-source.json'),JSON.stringify({sha256:createHash('sha256').update(content).digest('hex')}));
  for(const extension of ['.osrm','.osrm.partition','.osrm.cells','.osrm.geometry']){
   writeFileSync(join(directory,'ghana-latest'+extension),'fake-nonempty-sidecar');
  }
  await fn(directory);
 }finally{rmSync(directory,{recursive:true,force:true});}
}
test('map manifest: complete mock graph passes structural checks and refuses changed sidecars',async()=>{
 await graphFixture(async directory=>{
  await recordOsrm(directory,'ghana-latest','car');
  assert.equal((await verifyOsrm(directory,'ghana-latest','car')).fileCount,4);
  appendFileSync(join(directory,'ghana-latest.osrm.cells'),'changed');
  await assert.rejects(verifyOsrm(directory,'ghana-latest','car'),/differ/);
 });
});
test('map manifest: OSRM partial graph cannot be recorded',async()=>{
 await graphFixture(async directory=>{
  rmSync(join(directory,'ghana-latest.osrm.partition'));
  await assert.rejects(recordOsrm(directory,'ghana-latest','car'),/Incomplete OSRM/);
 });
});
test('map manifest: changed source invalidates completed graph',async()=>{
 await graphFixture(async directory=>{
  await recordOsrm(directory,'ghana-latest','car');
  appendFileSync(join(directory,'ghana-latest.osm.pbf'),'changed');
  await assert.rejects(verifyOsrm(directory,'ghana-latest','car'),/source data changed/);
 });
});
test('tile validator checks SQLite vector metadata, tiles and integrity',()=>{
 fixture(directory=>{
  const file=join(directory,'ghana.mbtiles');
  const db=new DatabaseSync(file);
  db.exec('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB)');
  for(const [name,value] of Object.entries({format:'pbf',minzoom:'0',maxzoom:'14'}))
   db.prepare('INSERT INTO metadata(name,value) VALUES(?,?)').run(name,value);
  assert.throws(()=>verifyTiles(file),/database is locked|no tiles|SQLITE_BUSY/i);
  db.prepare('INSERT INTO tiles(zoom_level,tile_column,tile_row,tile_data) VALUES(0,0,0,?)').run(Buffer.from([0x1a,0x00]));
  db.close();
  assert.equal(verifyTiles(file).tiles,1);
 });
});
test('tile validator rejects raster tiles masquerading as ELESEND vector MBTiles',()=>{
 fixture(directory=>{
  const file=join(directory,'bad.mbtiles');
  const db=new DatabaseSync(file);
  db.exec("CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB); INSERT INTO metadata VALUES('format','png'); INSERT INTO metadata VALUES('minzoom','0'); INSERT INTO metadata VALUES('maxzoom','10'); INSERT INTO tiles VALUES(0,0,0,X'0102')");
  db.close();
  assert.throws(()=>verifyTiles(file),/format must be pbf/);
 });
});
