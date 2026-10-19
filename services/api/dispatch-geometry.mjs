/** Geodesic distance is used only for spoofing checks and coarse discovery, not assignment ETA. */
export function haversine(a,b){const r=Math.PI/180,lat=(b.latitude-a.latitude)*r,lon=(b.longitude-a.longitude)*r;
 const h=Math.sin(lat/2)**2+Math.cos(a.latitude*r)*Math.cos(b.latitude*r)*Math.sin(lon/2)**2;
 return 12742000*Math.asin(Math.min(1,Math.sqrt(h)));
}
export function classifyMovement({previous,current,priorEtaSeconds,currentEtaSeconds,stationaryMeters=12}){
 if(!previous||!current||!Number.isFinite(priorEtaSeconds)||!Number.isFinite(currentEtaSeconds))return 'unknown';
 const elapsed=(new Date(current.observedAt)-new Date(previous.observedAt))/1000;
 if(!(elapsed>=5&&elapsed<=90))return 'unknown';
 const moved=haversine(previous,current);
 if(moved<stationaryMeters)return 'stationary';
 // Road ETA change is direction evidence; heading alone cannot establish connected streets.
 if(priorEtaSeconds-currentEtaSeconds>=Math.max(5,elapsed*.18))return 'approaching';
 if(currentEtaSeconds-priorEtaSeconds>=Math.max(5,elapsed*.18))return 'moving_away';
 return 'unknown';
}
/** Future multi-stop candidate check. Never authorizes busy riders in this release. */
export function assessDetour({originalRoute,newRoute,parcelWeightG,remainingCapacityG,deadlineSlackSec,maxDetourSeconds}){
 if(!originalRoute||!newRoute||![originalRoute.durationSeconds,newRoute.durationSeconds,parcelWeightG,remainingCapacityG,deadlineSlackSec,maxDetourSeconds].every(Number.isFinite))return {compatible:false,reason:'missing_route_evidence'};
 const detourSeconds=Math.max(0,newRoute.durationSeconds-originalRoute.durationSeconds);
 if(parcelWeightG>remainingCapacityG)return {compatible:false,reason:'capacity'};
 if(detourSeconds>maxDetourSeconds||detourSeconds>deadlineSlackSec)return {compatible:false,reason:'deadline_or_detour',detourSeconds};
 return {compatible:true,detourSeconds,requiresMultiStopAuthorization:true};
}
