import {check} from './security.mjs';
import {verifiedRoadEstimate,memoRoadRouting} from './algorithms/roads.mjs';

const validPoint=p=>p&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude);
const stop=(shipmentId,kind,place,weightG)=>({shipmentId,kind,latitude:place.latitude,longitude:place.longitude,weightG});
export const activeStates=['RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED'];
export function freshStops(shipmentId,request){return [stop(shipmentId,'pickup',request.pickup,request.weightG),stop(shipmentId,'dropoff',request.destination,request.weightG)];}
export function removeStop(stops,shipmentId,kind){return stops.filter(s=>!(s.shipmentId===shipmentId&&s.kind===kind));}
export function removeShipment(stops,shipmentId){return stops.filter(s=>s.shipmentId!==shipmentId);}
/** Insert new pickup/dropoff into the current immutable order of accepted obligations. */
export function candidateInsertions(existing,newStops){const [pickup,dropoff]=newStops;const plans=[];
 for(let i=0;i<=existing.length;i++)for(let j=i+1;j<=existing.length+1;j++){
  const seq=[...existing];seq.splice(i,0,pickup);seq.splice(j,0,dropoff);plans.push(seq);
 }
 return plans;
}
export function weightCapacityValid(stops,alreadyOnboardIds,maxWeightG){const onboard=new Set(alreadyOnboardIds);let loaded=0;
 // Existing already-collected parcels must count against capacity from start.
 for(const id of onboard){const item=stops.find(s=>s.shipmentId===id&&s.kind==='dropoff');if(!item)return false;loaded+=item.weightG;}
 if(loaded>maxWeightG)return false;
 for(const s of stops){if(s.kind==='pickup'){if(onboard.has(s.shipmentId))return false;onboard.add(s.shipmentId);loaded+=s.weightG;}
  else{if(!onboard.has(s.shipmentId))return false;onboard.delete(s.shipmentId);loaded-=s.weightG;}
  if(loaded<0||loaded>maxWeightG)return false;
 }
 return onboard.size===0;
}
const key=p=>`${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
/** A route is only feasible using authoritative provider road legs; no aerial-distance substitution. */
export async function evaluateStops(routing,start,stops,{vehicle,deadlines={},now=Date.now(),capacityG,onboardIds=[],maxPickupSeconds=1800,shipmentId}={}){
 check(validPoint(start)&&Array.isArray(stops)&&stops.every(validPoint),400,'Route coordinates unavailable');
 if(!weightCapacityValid(stops,onboardIds,capacityG))return null;
 let t=0,d=0,previous=start,pickupEtaSeconds=null,dropoffEtaSeconds=null;const arrivals={};
 for(const s of stops){let leg;
  try{leg=await routing.route(previous,s,{vehicle});}catch{return null;}
  if(!verifiedRoadEstimate(leg))return null;
  t+=leg.durationSeconds;d+=leg.distanceMeters;
  if(s.shipmentId===shipmentId&&s.kind==='pickup')pickupEtaSeconds=t;
  if(s.shipmentId===shipmentId&&s.kind==='dropoff')dropoffEtaSeconds=t;
  if(s.kind==='dropoff'){
   arrivals[s.shipmentId]=t;
   const deadline=deadlines[s.shipmentId];if(deadline&&now+t*1000>new Date(deadline).getTime())return null;
  }
  previous=s;
 }
 if(pickupEtaSeconds!==null&&pickupEtaSeconds>maxPickupSeconds)return null;
 return {stops,durationSeconds:Math.ceil(t),distanceMeters:Math.ceil(d),pickupEtaSeconds,dropoffEtaSeconds,arrivals};
}
/** Keep accepted stop order; search bounded positions for the new job, respecting existing deadlines. */
export async function bestInsertion(routing,start,existing,newStops,options){
 const cached=memoRoadRouting(routing);
 const base=await evaluateStops(cached,start,existing,{...options,shipmentId:undefined});if(!base)return null;
 let winning=null;
 for(const stops of candidateInsertions(existing,newStops)){
  const next=await evaluateStops(cached,start,stops,{...options,shipmentId:newStops[0].shipmentId});
  if(!next)continue;
  const detourSeconds=next.durationSeconds-base.durationSeconds;
  if(detourSeconds>(options.maxDetourSeconds??0))continue;
  const score=[next.pickupEtaSeconds,detourSeconds,next.durationSeconds];
  if(!winning||score[0]<winning.score[0]||(score[0]===winning.score[0]&&score[1]<winning.score[1])||(score[0]===winning.score[0]&&score[1]===winning.score[1]&&score[2]<winning.score[2]))winning={...next,detourSeconds,score};
 }
 return winning;
}
