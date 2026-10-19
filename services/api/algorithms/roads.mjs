/** Algorithm 2 — bounded, validated road-matrix computation with intra-request caching.
 * Haversine must never substitute for a road-provider ETA or proof of connectivity.
 */
export function verifiedRoadEstimate(leg){
 return leg!=null && leg.source!=='haversine' && Number.isFinite(leg.durationSeconds) && leg.durationSeconds>=0 &&
   Number.isFinite(leg.distanceMeters) && leg.distanceMeters>=0 && (leg.source==='routing-provider'||leg.source==='fixture');
}
export async function roadMatrixBatched(routing,sources,destination,{vehicle,batchSize=25}={}){
 if(typeof routing?.matrix!=='function'||!Array.isArray(sources)||!sources.length||sources.length>500||
    !Number.isInteger(batchSize)||batchSize<1||batchSize>30)throw Error('Invalid road matrix request');
 const output=[];
 for(let start=0;start<sources.length;start+=batchSize){
  const points=sources.slice(start,start+batchSize);
  const part=await routing.matrix(points,destination,{vehicle});
  if(!Array.isArray(part)||part.length!==points.length)throw Error('Incomplete routing provider matrix');
  for(const leg of part)output.push(verifiedRoadEstimate(leg)?leg:null);
 }
 return output;
}
export function memoRoadRouting(routing,{maxEntries=2000}={}){
 if(typeof routing?.route!=='function'||!Number.isInteger(maxEntries)||maxEntries<1)throw Error('Invalid road memo');
 const cache=new Map();
 return {route(a,b,opts={}){
  if(![a?.latitude,a?.longitude,b?.latitude,b?.longitude].every(Number.isFinite))throw Error('Invalid route coordinates');
  const key=[opts.vehicle??'',a.latitude.toFixed(6),a.longitude.toFixed(6),b.latitude.toFixed(6),b.longitude.toFixed(6)].join(':');
  if(!cache.has(key)){
   if(cache.size>=maxEntries)cache.clear(); // never persist road ETAs across changing traffic/time
   cache.set(key,Promise.resolve().then(()=>routing.route(a,b,opts)).then(leg=>{
    if(!verifiedRoadEstimate(leg))throw Error('Road provider did not establish valid route');return leg;
   }).catch(e=>{cache.delete(key);throw e;}));
  }
  return cache.get(key);
 }};
}
