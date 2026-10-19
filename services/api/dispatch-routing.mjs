import {check} from './security.mjs';
/** Distances and durations are ONLY from a configured road-network routing service. */
export function osrmRouting({endpoint,profiles,timeoutMs=3500,fetchImpl=fetch}){
 check(endpoint&&/^https?:\/\//.test(endpoint),500,'ROUTING_OSRM_URL required');
 const origin=new URL(endpoint);
 check(!origin.username&&!origin.password&&!origin.search&&!origin.hash,500,'Routing base URL must not contain secrets/query');
 check(Number.isInteger(timeoutMs)&&timeoutMs>=200&&timeoutMs<=15000,500,'Invalid routing timeout');
 check(profiles&&typeof profiles==='object',500,'Routing vehicle profiles required');
 function profile(vehicle){const p=profiles[vehicle];check(typeof p==='string'&&/^[a-zA-Z0-9_-]{1,32}$/.test(p),503,'No certified route profile for vehicle');return p;}
 function coords(point){check(Number.isFinite(point.latitude)&&Math.abs(point.latitude)<=90&&Number.isFinite(point.longitude)&&Math.abs(point.longitude)<=180,400,'Invalid coordinates');return `${point.longitude},${point.latitude}`;}
 async function request(path){const url=new URL(origin.toString());const split=path.indexOf('?');url.pathname=origin.pathname.replace(/\/$/,'')+(split===-1?path:path.slice(0,split));if(split!==-1)url.search=path.slice(split+1);
  const response=await fetchImpl(url,{signal:AbortSignal.timeout(timeoutMs),headers:{Accept:'application/json'}});
  check(response.ok,503,'Routing service unavailable');const body=await response.json();check(body.code==='Ok',503,'Routing service could not resolve road path');return body;
 }
 function normalize(distance,duration){check(Number.isFinite(distance)&&distance>=0&&Number.isFinite(duration)&&duration>=0,503,'Invalid road estimate');return {distanceMeters:Math.ceil(distance),durationSeconds:Math.ceil(duration),source:'routing-provider',trafficAware:false};}
 return {
  async route(from,to,{vehicle='car'}={}){const p=profile(vehicle),body=await request(`/route/v1/${p}/${coords(from)};${coords(to)}?overview=full&geometries=geojson&steps=false`);check(body.routes?.length&&body.routes[0].geometry,503,'No connected road route');return {...normalize(body.routes[0].distance,body.routes[0].duration),geometry:body.routes[0].geometry};},
  async matrix(sources,destination,{vehicle='car'}={}){check(Array.isArray(sources)&&sources.length>0&&sources.length<=30,400,'Invalid matrix');const p=profile(vehicle);
   const all=[...sources,destination],last=all.length-1;const body=await request(`/table/v1/${p}/${all.map(coords).join(';')}?sources=${sources.map((_,i)=>i).join(';')}&destinations=${last}&annotations=duration,distance`);
   check(body.durations?.length===sources.length&&body.distances?.length===sources.length,503,'Route matrix response malformed');return sources.map((_,i)=>{
    const d=body.durations[i]?.[0],m=body.distances[i]?.[0];return d===null||m===null?null:normalize(m,d);
   });
  },
  capabilities:Object.freeze({roadNetwork:true,traffic:false,mapMatching:false,multiVehicleProfileMustBeConfigured:true})
 };
}
/** Strictly test-only: caller supplies a deterministic road graph/fixture, not a GPS heuristic. */
export function fixtureRouting(estimate){const f=async(a,b,opts)=>({...await estimate(a,b,opts),source:'fixture',trafficAware:false});return {route:async(a,b,opts={})=>f(a,b,opts),matrix:async(points,target,opts={})=>Promise.all(points.map(p=>f(p,target,opts))),capabilities:{roadNetwork:'simulated',traffic:false,mapMatching:false}};}
