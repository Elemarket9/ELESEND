import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {gzipSync} from 'node:zlib';
import {privateRoutingPriority} from '../services/api/infrastructure/maps/PrivateRoutingPolicy.mjs';
import {privateTileUrl,privateMapStyle,displayRoadRoute} from '../apps/mobile/src/maps/private-map-style.mjs';
import {configuredGhanaPostGps,ghanaPostGps,normalizeGhanaDigitalAddress} from '../services/api/providers/ghanapostgps.mjs';
import {tileServer} from '../services/maps/tile-server.mjs';
import {httpServer} from '../services/api/http.mjs';

test('routing policy is OSRM-only, independent of any legacy Google key',async()=>{
 assert.equal(privateRoutingPriority({GOOGLE_ROUTES_API_KEY:'unused-legacy'}),'osrm');
 for(const priority of ['google_routes','osrm,google_routes','','osrm,osrm'])assert.throws(()=>privateRoutingPriority({ROUTING_PROVIDER_PRIORITY:priority}),{status:500});
 const source=await readFile(new URL('../services/api/server.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/googleRouting|process\.env\.GOOGLE_ROUTES_API_KEY/);
});

test('MapLibre style accepts only a configured private tile URL',()=>{
 const url='https://maps.elesend.example/tiles/{z}/{x}/{y}.pbf';assert.equal(privateTileUrl(url),url);
 for(const value of ['http://maps.example/{z}/{x}/{y}.pbf','https://tile.openstreetmap.org/{z}/{x}/{y}.png','https://maps.example/a','https://user:pass@maps.example/{z}/{x}/{y}.pbf'])assert.throws(()=>privateTileUrl(value));
 assert.equal(privateTileUrl('http://10.0.2.2:3145/tiles/{z}/{x}/{y}.pbf',{development:true}),'http://10.0.2.2:3145/tiles/{z}/{x}/{y}.pbf');
 assert.deepEqual(Object.keys(privateMapStyle(null).sources),[]);
 const style=privateMapStyle(url);assert.deepEqual(style.sources.ghana.tiles,[url]);assert.equal(style.glyphs,undefined);assert.equal(style.sprite,undefined);
 const route={providerId:'osrm',mapContentFamily:'independent',points:[{},{}]};assert.equal(displayRoadRoute(route),route);
 assert.equal(displayRoadRoute({...route,providerId:'google_routes',mapContentFamily:'google'}),null);
});

test('GhanaPostGPS is optional, validates address input and uses only get-location',async()=>{
 assert.equal(configuredGhanaPostGps({GHANAPOSTGPS_LOOKUP_ENABLED:'false'}),null);
 assert.equal(normalizeGhanaDigitalAddress('ak4849321'),'AK-484-9321');
 for(const value of [null,'GA-123-12345',''])assert.throws(()=>normalizeGhanaDigitalAddress(value),{status:400});
 let calls=0;const client=ghanaPostGps({endpoint:'https://address.elesend.example',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url.pathname,'/get-location');assert.deepEqual(JSON.parse(options.body),{address:'AK-484-9321'});assert.equal(options.redirect,'error');
  return Response.json({found:true,data:{Table:[{CenterLatitude:5.6,CenterLongitude:-.2,Area:'Accra'}]}});
 }});
 await assert.rejects(()=>client('invalid'),{status:400});assert.equal(calls,0);
 const found=await client('AK-484-9321');assert.equal(found.requiresPinReview,true);assert.equal(found.latitude,5.6);assert.equal(calls,1);
});

test('address lookup rejects malformed, ambiguous and foreign provider coordinates',async()=>{
 for(const payload of [{found:true,data:{Table:[]}},{found:true,data:{Table:[{CenterLatitude:null,CenterLongitude:null}]}},{found:true,data:{Table:[{CenterLatitude:51,CenterLongitude:0}]}}]){
  const client=ghanaPostGps({endpoint:'https://address.example',fetchImpl:async()=>Response.json(payload)});
  await assert.rejects(()=>client('AK-484-9321'),{status:502});
 }
 const missing=ghanaPostGps({endpoint:'https://address.example',fetchImpl:async()=>Response.json({found:false})});
 assert.equal((await missing('AK-484-9321')).found,false);
});

test('address HTTP route requires customer or business auth, strict request body and rate limits',async()=>{
 const counts=new Map(),calls=[];const db={async query(sql,args){if(sql.startsWith('INSERT INTO rate_limits')){const count=(counts.get(args[0])??0)+1;counts.set(args[0],count);return {rows:[{count}]};}return {rows:[],rowCount:0};}};
 const actors={customer:{id:'customer-test',kind:'customer'},rider:{id:'rider-test',kind:'rider'}};
 const app={async authenticate(token){return actors[token];}};
 const server=httpServer(db,app,null,null,null,{ghanaPostGps:async address=>{calls.push(address);return {found:false,address};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const request=(method,path,token,body)=>fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const config=await (await request('GET','/api/v1/maps/config','customer')).json();assert.equal(config.renderer,'private');assert.equal(config.routing,'osrm');assert.equal(config.ghanaPostGpsLookup,true);
  assert.equal((await request('POST','/api/v1/maps/ghana-address','rider',{address:'AK-484-9321'})).status,403);
  assert.equal((await request('POST','/api/v1/maps/ghana-address','customer',{address:'AK-484-9321',url:'https://attacker.invalid'})).status,400);
  for(let i=0;i<5;i++)assert.equal((await request('POST','/api/v1/maps/ghana-address','customer',{address:'AK-484-9321'})).status,200);
  assert.equal((await request('POST','/api/v1/maps/ghana-address','customer',{address:'AK-484-9321'})).status,429);assert.equal(calls.length,5);
 }finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('tile server serves read-only MBTiles with XYZ-to-TMS conversion and bounded URLs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'elesend-map-')),file=join(dir,'test.mbtiles');
 const db=new DatabaseSync(file);db.exec('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB);');
 db.prepare('INSERT INTO metadata VALUES (?,?)').run('format','pbf');db.prepare('INSERT INTO tiles VALUES (2,1,2,?)').run(gzipSync(Buffer.from('synthetic-vector-tile')));db.close();
 const server=tileServer(file);server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const tile=await fetch(base+'/tiles/2/1/1.pbf');assert.equal(tile.status,200);assert.equal(await tile.text(),'synthetic-vector-tile');
  assert.equal((await fetch(base+'/tiles/2/1/2.pbf')).status,204);
  for(const path of ['/tiles/2/4/1.pbf','/tiles/15/1/1.pbf'])assert.equal((await fetch(base+path)).status,400);
  assert.equal((await fetch(base+'/ghana.mbtiles')).status,404);assert.equal((await fetch(base+'/health',{method:'POST'})).status,405);
 }finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(dir,{recursive:true,force:true});}
});
