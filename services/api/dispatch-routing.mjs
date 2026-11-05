import {check} from './security.mjs';
import {haversine} from './dispatch-geometry.mjs';

const ROAD_TURNS={uturn:'Make a U-turn','sharp right':'Turn sharp right',right:'Turn right','slight right':'Keep right',straight:'Continue','slight left':'Keep left',left:'Turn left','sharp left':'Turn sharp left'};
/** Words a rider can follow, from one OSRM route step. */
export function stepInstruction({maneuver:m={},name,ref}={},last=false){
 const road=name||ref||'',onto=road?` onto ${road}`:'';
 if(m.type==='arrive'||last)return 'You have arrived';
 if(m.type==='depart')return road?`Head out on ${road}`:'Head out';
 if(m.type==='roundabout'||m.type==='rotary')return `At the roundabout, take exit ${m.exit||1}${onto}`;
 if(m.type==='exit roundabout'||m.type==='exit rotary')return `Leave the roundabout${onto}`;
 if(m.type==='merge')return `Merge${onto}`;
 const turn=ROAD_TURNS[m.modifier]||'Continue';
 if(m.type==='continue'&&m.modifier==='straight')return road?`Continue on ${road}`:'Continue straight';
 return `${turn}${onto}`;
}
export function navigationSteps(route){
 const raw=(route?.legs||[]).flatMap(leg=>leg.steps||[]);
 return raw.map((step,i)=>({type:step.maneuver?.type,modifier:step.maneuver?.modifier??null,name:step.name||step.ref||null,instruction:stepInstruction(step,i===raw.length-1),distanceMeters:Math.ceil(step.distance||0),durationSeconds:Math.ceil(step.duration||0),location:{latitude:step.maneuver?.location?.[1],longitude:step.maneuver?.location?.[0]}}));
}

function routeSegments(route){
 const nodes=[],distances=[],durations=[];
 for(const leg of route?.legs||[]){
  const a=leg.annotation;if(!a?.nodes?.length)continue;
  nodes.push(...(nodes.length?a.nodes.slice(1):a.nodes));distances.push(...(a.distance||[]));durations.push(...(a.duration||[]));
 }
 return {nodes,distances,durations};
}

/** Distances and durations are ONLY from a configured road-network routing service. */
export function osrmRouting({endpoint,profiles={},vehicleRoutes,timeoutMs=3500,maxSnapMeters=2500,billingSnapMeters=500,minBilledRoadRatio=0.75,maxInFlight=48,fetchImpl=fetch}){
 function base(value){const u=new URL(value);check(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash,500,'Routing base URL must not contain secrets/query');return u;}
 check(endpoint||vehicleRoutes,500,'OSRM graph configuration required');
 const origin=endpoint?base(endpoint):null;
 if(vehicleRoutes){check(typeof vehicleRoutes==='object'&&!Array.isArray(vehicleRoutes)&&Object.keys(vehicleRoutes).length>0,500,'Invalid graph configuration');
  for(const [vehicle,entry] of Object.entries(vehicleRoutes)){check(['motorcycle','car','van','bicycle','tricycle','pickup','truck'].includes(vehicle)&&entry&&typeof entry.endpoint==='string'&&/^[a-zA-Z0-9_-]{1,32}$/.test(entry.profile??''),500,'Invalid vehicle graph');base(entry.endpoint);}
  const car=vehicleRoutes.car;if(car)for(const [vehicle,entry] of Object.entries(vehicleRoutes))if(vehicle!=='car')check(base(entry.endpoint).toString()!==base(car.endpoint).toString(),500,'Non-car vehicles require a separate verified graph endpoint');
 }
 check(Number.isInteger(timeoutMs)&&timeoutMs>=200&&timeoutMs<=15000,500,'Invalid routing timeout');
 check(Number.isFinite(maxSnapMeters)&&maxSnapMeters>=50&&maxSnapMeters<=10000,500,'Invalid routing snap threshold');
 check(profiles&&typeof profiles==='object',500,'Routing vehicle profiles required');
 function profile(vehicle){const p=vehicleRoutes?vehicleRoutes[vehicle]?.profile:profiles[vehicle];check(typeof p==='string'&&/^[a-zA-Z0-9_-]{1,32}$/.test(p),503,'No configured road graph for vehicle');return p;}
 function coords(point){check(point&&Number.isFinite(point.latitude)&&Math.abs(point.latitude)<=90&&Number.isFinite(point.longitude)&&Math.abs(point.longitude)<=180,400,'Invalid coordinates');return `${point.longitude},${point.latitude}`;}
 let inFlight=0;
 async function decode(response){
  if(!response.body?.getReader){check(process.env.NODE_ENV!=='production'&&typeof response.json==='function',503,'Missing routing response body');return response.json();}
  const reader=response.body.getReader(),chunks=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;check(length<=1048576,503,'Routing response too large');chunks.push(Buffer.from(value));}}
  catch(error){try{await reader.cancel();}catch{}throw error;}finally{reader.releaseLock();}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{check(false,503,'Invalid routing JSON');}
 }
 async function request(path,vehicle){const configured=vehicleRoutes?base(vehicleRoutes[vehicle].endpoint):origin;const url=new URL(configured.toString());const split=path.indexOf('?');url.pathname=configured.pathname.replace(/\/$/,'')+(split===-1?path:path.slice(0,split));if(split!==-1)url.search=path.slice(split+1);
  check(inFlight<maxInFlight,503,'Routing service admission limit reached');inFlight++;
  try{const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{Accept:'application/json','Accept-Encoding':'gzip, deflate'}});
   check(response.status!==429,429,'Routing service rate limited');check(response.ok,503,'Routing service unavailable');const body=await decode(response);check(body&&typeof body==='object'&&!Array.isArray(body),503,'Invalid routing response');
   check(!['NoRoute','NoTable'].includes(body.code),422,'No connected road path');check(body.code==='Ok',503,'Routing service could not resolve road path');return body;
  }finally{inFlight--;}
 }
 function validateWaypoints(waypoints,limit=maxSnapMeters,message='No connected road path'){
  if(!Array.isArray(waypoints))return;
  for(const wp of waypoints){
   if(wp&&Number.isFinite(wp.distance)){
    check(wp.distance<=limit,422,message);
   }
  }
 }
 function normalize(distance,duration){check(Number.isFinite(distance)&&distance>=0&&distance<=10000000&&Number.isFinite(duration)&&duration>=0&&duration<=604800,503,'Invalid road estimate');return {distanceMeters:Math.ceil(distance),durationSeconds:Math.ceil(duration),source:'routing-provider',trafficAware:false};}
 return {
  async route(from,to,{vehicle='car',steps=false,annotations=false,alternatives=false,billing=false}={}){
   const p=profile(vehicle),body=await request(`/route/v1/${p}/${coords(from)};${coords(to)}?overview=full&geometries=geojson&steps=${steps?'true':'false'}${annotations?'&annotations=nodes,distance,duration':''}${alternatives?'&alternatives=true':''}`,vehicle);
   check(body.routes?.length&&body.routes[0].geometry,503,'No connected road route');
   // A fare pays for the road between the pins, so a pin far from the road would ride unbilled.
   if(billing)validateWaypoints(body.waypoints,billingSnapMeters,'This pin is too far from a mapped road. Move it closer to the road.');
   else validateWaypoints(body.waypoints);
   const straightLine=haversine(from,to);
   if(straightLine>250){
    check(Number(body.routes[0].distance)>=straightLine*(billing?minBilledRoadRatio:0.25),422,billing?'This route looks too short for these pins. Check both pins.':'No connected road path');
   }
   const shape=route=>({...normalize(route.distance,route.duration),geometry:route.geometry,...(steps?{steps:navigationSteps(route)}:{}),...(annotations?{segments:routeSegments(route)}:{})});
   return {...shape(body.routes[0]),...(alternatives&&body.routes.length>1?{alternatives:body.routes.slice(1).map(shape)}:{})};
  },
  async matrix(sources,destination,{vehicle='car'}={}){
   check(Array.isArray(sources)&&sources.length>0&&sources.length<=30,400,'Invalid matrix');const p=profile(vehicle);
   const all=[...sources,destination],last=all.length-1;const body=await request(`/table/v1/${p}/${all.map(coords).join(';')}?sources=${sources.map((_,i)=>i).join(';')}&destinations=${last}&annotations=duration,distance`,vehicle);
   check(body.durations?.length===sources.length&&body.distances?.length===sources.length,503,'Route matrix response malformed');
   validateWaypoints(body.destinations);
   const srcWps=Array.isArray(body.sources)?body.sources:null;
   return sources.map((src,i)=>{
    if(srcWps&&srcWps[i]&&Number.isFinite(srcWps[i].distance)&&srcWps[i].distance>maxSnapMeters)return null;
    const d=body.durations[i]?.[0],m=body.distances[i]?.[0];
    if(d===null||m===null||!Number.isFinite(d)||!Number.isFinite(m))return null;
    const straightLine=haversine(src,destination);
    if(straightLine>250&&m<straightLine*0.25)return null;
    return normalize(m,d);
   });
  },
  /** Metres from a point to the nearest road on the vehicle's graph. */
  async nearestRoadMeters(point,{vehicle='car'}={}){
   const body=await request(`/nearest/v1/${profile(vehicle)}/${coords(point)}?number=1`,vehicle);
   const meters=body.waypoints?.[0]?.distance;
   check(Number.isFinite(meters),503,'Invalid nearest road response');
   return meters;
  },
  /** Snaps a rider's GPS trip to roads. Used to measure road speeds. */
  async matchTrace(points,{vehicle='car'}={}){
   check(Array.isArray(points)&&points.length>=2&&points.length<=100,400,'Invalid trace');
   const times=points.map(p=>Math.floor(Date.parse(p.observedAt)/1000)),radii=points.map(p=>Math.max(5,Math.min(50,Math.round(p.accuracyMeters||20))));
   return request(`/match/v1/${profile(vehicle)}/${points.map(coords).join(';')}?overview=false&annotations=nodes,distance&gaps=split&timestamps=${times.join(';')}&radiuses=${radii.join(';')}`,vehicle);
  },
  capabilities:Object.freeze({roadNetwork:true,traffic:false,mapMatching:true,multiVehicleProfileMustBeConfigured:true})
 };
}
/** Strictly test-only: caller supplies a deterministic road graph/fixture, not a GPS heuristic. */
export function fixtureRouting(estimate){const f=async(a,b,opts)=>({...await estimate(a,b,opts),source:'fixture',trafficAware:false});return {route:async(a,b,opts={})=>f(a,b,opts),matrix:async(points,target,opts={})=>Promise.all(points.map(p=>f(p,target,opts))),capabilities:{roadNetwork:'simulated',traffic:false,mapMatching:false}};}
