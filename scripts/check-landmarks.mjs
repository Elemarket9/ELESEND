#!/usr/bin/env node
// Checks the landmark files before import. Errors block the import; warnings are for review.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export const LANDMARK_COLUMNS=['id','name','search_name','category','subcategory','region','locality','city','latitude','longitude','geom','coordinate_kind','source','source_id','verification_status','aliases','entrance','popularity','street','created_at','updated_at'];
const BOUNDS={minLat:4.5,maxLat:11.4,minLng:-3.5,maxLng:1.4};

export function parseTsv(text){
 return text.split('\n').filter(Boolean).map(line=>line.split('\t').map(v=>v.startsWith('"')&&v.endsWith('"')?v.slice(1,-1).replaceAll('""','"'):v));
}
export function checkLandmarks(rows,columns=LANDMARK_COLUMNS){
 const errors=[],warnings=[],seen=new Set(),coords=new Map();
 const at=name=>columns.indexOf(name);
 rows.forEach((row,index)=>{
  const where=`row ${index+1} (${row[0]})`;
  if(row.length!==columns.length){errors.push(`${where}: has ${row.length} columns, expected ${columns.length}`);return;}
  if(seen.has(row[0]))errors.push(`${where}: repeated id`);seen.add(row[0]);
  const lat=Number(row[at('latitude')]),lng=Number(row[at('longitude')]);
  if(!(lat>=BOUNDS.minLat&&lat<=BOUNDS.maxLat&&lng>=BOUNDS.minLng&&lng<=BOUNDS.maxLng))errors.push(`${where}: outside Ghana`);
  if(!row[at('name')]?.trim())errors.push(`${where}: no name`);
  for(const stamp of ['created_at','updated_at'])if(Number.isNaN(Date.parse(row[at(stamp)])))errors.push(`${where}: bad ${stamp}`);
  if(row[at('verification_status')]==='source_verified')warnings.push(`${where}: says verified, with no evidence`);
  if(row[at('name')]?.trim().length<3)warnings.push(`${where}: short name "${row[at('name')]}"`);
  const key=`${lat},${lng}`;coords.set(key,(coords.get(key)||0)+1);
 });
 const shared=[...coords.values()].filter(n=>n>1).reduce((a,b)=>a+b,0);
 if(shared)warnings.push(`${shared} rows share exact coordinates with another row`);
 return {rows:rows.length,errors,warnings};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const files=process.argv.slice(2);let failed=false;
 for(const file of files.length?files:['data/spatial_landmarks_v9_import.tsv']){
  const result=checkLandmarks(parseTsv(readFileSync(file,'utf8')));
  console.log(`${file}: ${result.rows} rows, ${result.errors.length} errors, ${result.warnings.length} warnings`);
  result.errors.slice(0,20).forEach(e=>console.log('ERROR',e));
  result.warnings.slice(0,20).forEach(w=>console.log('WARN',w));
  if(result.errors.length)failed=true;
 }
 process.exit(failed?1:0);
}
