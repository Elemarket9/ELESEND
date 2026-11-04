#!/usr/bin/env node
// Writes approved rider-found roads as an OSM file, joined to the existing road network.
// Usage: DATABASE_URL=... OSRM_URL=... node scripts/export-rider-roads.mjs rider-roads.osm
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const MAX_JOIN_METERS=30,FIRST_ID=9000000000000;
const xml=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));

/** `nearest(point)` returns {meters,node}: the closest existing road node. */
export async function riderRoadsOsm(roads,nearest){
 let id=FIRST_ID;const nodes=[],ways=[];
 for(const road of roads){
  const coords=road.coordinates;if(!Array.isArray(coords)||coords.length<2)continue;
  const refs=[];let joined=false;
  for(let i=0;i<coords.length;i++){
   const [longitude,latitude]=coords[i];
   if(i===0||i===coords.length-1){
    const near=await nearest({latitude,longitude}).catch(()=>null);
    if(near&&near.meters<=MAX_JOIN_METERS&&near.node){refs.push(near.node);joined=true;continue;}
   }
   id+=1;nodes.push(`<node id="${id}" version="1" lat="${latitude}" lon="${longitude}"/>`);refs.push(id);
  }
  if(!joined)continue; // A road touching nothing cannot be routed to.
  id+=1;
  const tags={highway:'unclassified',source:'elesend-riders',...(road.name?{name:road.name}:{}),...(road.isOneWay?{oneway:'yes'}:{}),...(road.maxSpeedKmh?{maxspeed:String(road.maxSpeedKmh)}:{}),...(road.allowedVehicles?.includes('car')?{}:{motorcar:'no'})};
  ways.push(`<way id="${id}" version="1">${refs.map(r=>`<nd ref="${r}"/>`).join('')}${Object.entries(tags).map(([k,v])=>`<tag k="${k}" v="${xml(v)}"/>`).join('')}</way>`);
 }
 return {count:ways.length,osm:`<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="elesend">\n${nodes.join('\n')}\n${ways.join('\n')}\n</osm>\n`};
}

export const osrmNearest=(base,fetchImpl=fetch)=>async point=>{
 const res=await fetchImpl(`${base}/nearest/v1/driving/${point.longitude},${point.latitude}?number=1`);
 const way=(await res.json()).waypoints?.[0];
 return way?{meters:way.distance,node:way.nodes?.find(Boolean)}:null;
};

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const pg=(await import('pg')).default;
 const out=process.argv[2];
 if(!out||!process.env.DATABASE_URL||!process.env.OSRM_URL)throw Error('Usage: DATABASE_URL=... OSRM_URL=... export-rider-roads.mjs OUTPUT');
 const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
 const rows=(await client.query(`SELECT name,is_one_way,max_speed_kmh,allowed_vehicles,ST_AsGeoJSON(corridor::geometry) AS geojson FROM candidate_roads WHERE status='PUBLISHED' AND is_private_access=false AND is_pedestrian_only=false`)).rows;
 await client.end();
 const {osm,count}=await riderRoadsOsm(rows.map(r=>({name:r.name,isOneWay:r.is_one_way,maxSpeedKmh:r.max_speed_kmh,allowedVehicles:r.allowed_vehicles,coordinates:JSON.parse(r.geojson).coordinates})),osrmNearest(process.env.OSRM_URL));
 writeFileSync(out,osm);console.log(`Wrote ${count} rider roads to ${out}`);
}
