#!/usr/bin/env node
/**
 * Validates locally generated Ghana map artifacts. Does not retrieve external maps.
 * Checks the generated MLD graph file set and source/profile provenance; for tiles,
 * opens actual SQLite MBTiles and verifies metadata, integrity and nonempty tiles.
 * This is structural validation, NOT proof that roads are connected or ETA is accurate.
 */
import {createHash} from 'node:crypto';
import {createReadStream,existsSync,readFileSync,statSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';

const fail=message=>{throw new Error(message)};
async function digest(filename){
 const hash=createHash('sha256');
 for await(const chunk of createReadStream(filename))hash.update(chunk);
 return hash.digest('hex');
}
const required=['.osrm','.osrm.partition','.osrm.cells'];
function graphFiles(directory,base){
 const prefix=base+'.osrm';
 const entries=readdirSync(directory).filter(name=>name===prefix||name.startsWith(prefix+'.'));
 const valid=entries.filter(name=>statSync(join(directory,name)).isFile()&&statSync(join(directory,name)).size>0);
 for(const suffix of required)if(!valid.includes(base+suffix))fail('Incomplete OSRM MLD graph: missing/empty '+base+suffix);
 if(valid.length<4)fail('Incomplete OSRM MLD graph: insufficient sidecar files');
 return valid.sort().map(name=>({name,size:statSync(join(directory,name)).size}));
}
export async function recordOsrm(directory,base,profile){
 const files=graphFiles(directory,base);
 const source=join(directory,'ghana-latest.osm.pbf'),profilePath=profile==='car'?'car.lua':join(directory,'motorcycle.lua');
 if(!existsSync(source))fail('Missing Ghana source extract');
 if(profile!=='car'&&!existsSync(profilePath))fail('Missing motorcycle Lua profile');
 const metadata=JSON.parse(readFileSync(join(directory,'ghana-source.json'),'utf8'));
 const sourceSha=await digest(source);
 if(sourceSha!==metadata.sha256)fail('Ghana source checksum mismatch');
 const marker={version:1,base,sourceSha,profileSha:profile==='car'?'osrm-container-car-v26.4.0':await digest(profilePath),files,generatedAt:new Date().toISOString()};
 writeFileSync(join(directory,base+'.osrm.build.json'),JSON.stringify(marker,null,2)+'\n',{flag:'wx'});
 return marker;
}
export async function verifyOsrm(directory,base,profile){
 const markerFile=join(directory,base+'.osrm.build.json');
 if(!existsSync(markerFile))fail('Missing OSRM completion marker for '+base+'; rebuild, do not trust a partial .osrm');
 const marker=JSON.parse(readFileSync(markerFile,'utf8'));
 if(marker.version!==1||marker.base!==base)fail('OSRM marker invalid');
 const files=graphFiles(directory,base);
 if(JSON.stringify(files)!==JSON.stringify(marker.files))fail('OSRM graph files differ from completed build');
 const metadata=JSON.parse(readFileSync(join(directory,'ghana-source.json'),'utf8'));
 const sourceSha=await digest(join(directory,'ghana-latest.osm.pbf'));
 if(sourceSha!==metadata.sha256||sourceSha!==marker.sourceSha)fail('OSRM source data changed since build');
 const profileSha=profile==='car'?'osrm-container-car-v26.4.0':await digest(join(directory,'motorcycle.lua'));
 if(profileSha!==marker.profileSha)fail('OSRM routing profile changed since build');
 return {verified:true,base,fileCount:files.length,verification:'structural only'};
}
export function verifyTiles(filename){
 if(!existsSync(filename)||statSync(filename).size===0)fail('Ghana MBTiles missing or empty');
 let db;
 try{
  db=new DatabaseSync(filename,{readOnly:true});
  const integrity=db.prepare('PRAGMA quick_check').get();
  if(Object.values(integrity)[0]!=='ok')fail('MBTiles SQLite quick_check failed');
  const meta=Object.fromEntries(db.prepare('SELECT name,value FROM metadata').all().map(row=>[row.name,row.value]));
  if(meta.format!=='pbf')fail('MBTiles format must be pbf vector tiles');
  for(const key of ['minzoom','maxzoom']){
   const z=Number(meta[key]);
   if(!Number.isInteger(z)||z<0||z>22)fail('MBTiles '+key+' is invalid');
  }
  if(Number(meta.minzoom)>Number(meta.maxzoom))fail('MBTiles zoom range invalid');
  const count=db.prepare('SELECT count(*) AS n FROM tiles').get().n;
  if(count<=0)fail('MBTiles has no tiles');
  const sample=db.prepare('SELECT length(tile_data) AS n FROM tiles LIMIT 1').get();
  if(!(sample?.n>0))fail('MBTiles contains empty tile payload');
  return {verified:true,tiles:count,format:meta.format,minzoom:meta.minzoom,maxzoom:meta.maxzoom,verification:'SQLite structural only'};
 }finally{db?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [mode,location,base,profile]=process.argv.slice(2);
 try{
  let result;
  if(mode==='record-osrm')result=await recordOsrm(location,base,profile);
  else if(mode==='verify-osrm')result=await verifyOsrm(location,base,profile);
  else if(mode==='verify-tiles')result=verifyTiles(location);
  else fail('Usage: node scripts/map-artifact-integrity.mjs record-osrm|verify-osrm DIR BASE car|motorcycle OR verify-tiles FILE');
  console.log(JSON.stringify(result));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
