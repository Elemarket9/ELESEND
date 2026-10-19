import {check} from './security.mjs';
/** Google Maps Routes REST adapter, server-side only. No key is shipped in the APK.
 * TWO_WHEELER Ghana support verified against Google docs Oct 2026; beta warnings required.
 * Bicycle/truck profiles are intentionally not mapped to DRIVE by default.
 */
export function googleRouting({apiKey,vehicleModes={car:'DRIVE',motorcycle:'TWO_WHEELER',pickup:'DRIVE',van:'DRIVE'},fetchImpl=fetch,timeoutMs=5500}={}){
 check(typeof apiKey==='string'&&apiKey.length>=8,500,'GOOGLE_ROUTES_API_KEY required');
 check(Number.isInteger(timeoutMs)&&timeoutMs>=200&&timeoutMs<=20000,500,'Invalid routing timeout');
 function mode(vehicle){const value=vehicleModes[vehicle];check(['DRIVE','TWO_WHEELER'].includes(value),503,'Vehicle lacks approved Google Routes profile');return value;}
 function waypoint(p){check(p&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&Math.abs(p.latitude)<=90&&Math.abs(p.longitude)<=180,400,'Invalid coordinates');return {location:{latLng:{latitude:p.latitude,longitude:p.longitude}}};}
 function settings(vehicle){const travelMode=mode(vehicle);return {travelMode,...(travelMode==='DRIVE'?{routingPreference:'TRAFFIC_AWARE'}:{})};}
 function normalized(distance,duration,travelMode,polyline=null){
  const seconds=typeof duration==='string'&&/^\d+(?:\.\d+)?s$/.test(duration)?Number(duration.slice(0,-1)):NaN;
  check(Number.isInteger(distance)&&distance>=0&&Number.isFinite(seconds)&&seconds>=0,503,'Malformed Google road estimate');
  return {distanceMeters:distance,durationSeconds:Math.ceil(seconds),source:'routing-provider',trafficAware:travelMode==='DRIVE',geometry:polyline?{encodedPolyline:polyline}:undefined,
   motorcycleBeta:travelMode==='TWO_WHEELER'};
 }
 async function post(path,body,mask){const res=await fetchImpl('https://routes.googleapis.com/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':apiKey,'X-Goog-FieldMask':mask},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
  check(res.ok,503,'Google routing service unavailable');return res.json();}
 return {
  async route(from,to,{vehicle='car'}={}){const s=settings(vehicle);const result=await post('directions/v2:computeRoutes',{origin:waypoint(from),destination:waypoint(to),...s},'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline');
   const r=result.routes?.[0];check(r,503,'No Google route available');return normalized(r.distanceMeters,r.duration,s.travelMode,r.polyline?.encodedPolyline);
  },
  async matrix(sources,destination,{vehicle='car'}={}){check(Array.isArray(sources)&&sources.length>=1&&sources.length<=30,400,'Invalid route matrix batch');const s=settings(vehicle);
   const rows=await post('distanceMatrix/v2:computeRouteMatrix',{origins:sources.map(point=>({waypoint:waypoint(point)})),destinations:[{waypoint:waypoint(destination)}],...s},'originIndex,destinationIndex,status,condition,duration,distanceMeters');
   check(Array.isArray(rows),503,'Invalid route matrix result');const output=Array.from({length:sources.length},()=>null),seen=new Set();
   for(const row of rows){const i=row.originIndex;check(Number.isInteger(i)&&i>=0&&i<sources.length&&row.destinationIndex===0&&!seen.has(i),503,'Malformed matrix origin index');seen.add(i);
    if(row.condition==='ROUTE_EXISTS'&&(!row.status||!row.status.code||row.status.code===0))output[i]=normalized(row.distanceMeters??0,row.duration,s.travelMode);
    else if(row.condition!=='ROUTE_NOT_FOUND')check(false,503,'Routing provider returned an error');
   }
   check(seen.size===sources.length,503,'Incomplete route matrix');return output;
  },
  capabilities:Object.freeze({roadNetwork:true,traffic:'DRIVE when traffic-aware route supported',mapMatching:false,motorcycleRoutesBeta:true})
 };
}
