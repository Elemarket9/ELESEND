import {haversine} from '../dispatch-geometry.mjs';
import {MARKET_TIME_ZONE} from '../market.mjs';

/** Pure stage-based delivery ETA rules. All inputs are explicit, so every result can be tested. */

// Planning assumptions, not measurements. Replace them with values from measured trips.
export const ETA_ASSUMPTIONS=Object.freeze({
 pickupHandoverSeconds:180,
 dropoffHandoverSeconds:120,
 gpsFreshSeconds:75,
 gpsUnusableSeconds:600,
 gpsGoodAccuracyMeters:50,
 gpsJumpSpeedMps:40,
 routeDeviationMeters:150,
 routeMaxAgeSeconds:300,
 displayChangeSeconds:120
});

const CUSTOMER_MESSAGES={
 awaiting_payment:'Your arrival time will appear once payment is confirmed.',
 awaiting_rider:'Finding a rider. Your arrival time will appear once a rider accepts.',
 awaiting_kitchen:'Your arrival time will appear once the kitchen accepts your order.',
 no_route:'We cannot estimate your arrival time right now. You can contact your rider or support.',
 no_location:'We have lost contact with your rider, so we cannot estimate your arrival time right now.',
 closed:null
};

export function classifyGps({latitude,longitude,updatedAt,accuracyMeters,previous=null},{now=Date.now(),assumptions=ETA_ASSUMPTIONS}={}){
 if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180||!updatedAt)return {quality:'missing',usable:false};
 const observedAt=new Date(updatedAt).getTime();
 if(!Number.isFinite(observedAt)||observedAt>now+5000)return {quality:'missing',usable:false};
 const ageSeconds=Math.max(0,(now-observedAt)/1000);
 if(ageSeconds>assumptions.gpsUnusableSeconds)return {quality:'lost',usable:false,ageSeconds};
 if(previous&&Number.isFinite(previous.latitude)&&Number.isFinite(previous.longitude)&&previous.observedAt){
  const elapsed=(observedAt-new Date(previous.observedAt).getTime())/1000;
  if(elapsed>0&&haversine(previous,{latitude,longitude})/elapsed>assumptions.gpsJumpSpeedMps)return {quality:'jumping',usable:true,ageSeconds};
 }
 if(ageSeconds>assumptions.gpsFreshSeconds)return {quality:'stale',usable:true,ageSeconds};
 if(!Number.isFinite(accuracyMeters)||accuracyMeters>assumptions.gpsGoodAccuracyMeters)return {quality:'inaccurate',usable:true,ageSeconds};
 return {quality:'good',usable:true,ageSeconds};
}

/** Distance from a point to a [lon,lat] road path, and the share of the path still ahead of it. */
export function positionOnRoute(point,coordinates){
 if(!Array.isArray(coordinates)||coordinates.length<2)return null;
 const toPoint=([longitude,latitude])=>({latitude,longitude});
 const lengths=[];let total=0;
 for(let i=1;i<coordinates.length;i++){const d=haversine(toPoint(coordinates[i-1]),toPoint(coordinates[i]));lengths.push(d);total+=d;}
 if(total<=0)return null;
 // Metres per degree at this latitude, enough for short segment projection.
 const metresLat=111320,metresLon=111320*Math.cos(point.latitude*Math.PI/180);
 let best={distanceMeters:Infinity,travelled:0},travelled=0;
 for(let i=1;i<coordinates.length;i++){
  const [lon1,lat1]=coordinates[i-1],[lon2,lat2]=coordinates[i];
  const ax=(lon2-lon1)*metresLon,ay=(lat2-lat1)*metresLat,px=(point.longitude-lon1)*metresLon,py=(point.latitude-lat1)*metresLat;
  const len=ax*ax+ay*ay,t=len>0?Math.max(0,Math.min(1,(px*ax+py*ay)/len)):0;
  const distanceMeters=Math.hypot(px-ax*t,py-ay*t);
  if(distanceMeters<best.distanceMeters)best={distanceMeters,travelled:travelled+t*lengths[i-1]};
  travelled+=lengths[i-1];
 }
 return {distanceFromRouteMeters:best.distanceMeters,remainingShare:Math.max(0,1-best.travelled/total)};
}

/** Decides whether a stored route can still be used, so not every GPS update costs a routing call. */
export function routeDecision({cached,stage,position,now=Date.now(),assumptions=ETA_ASSUMPTIONS}){
 if(!cached||cached.stage!==stage)return {recalculate:true,reason:cached?'stage_changed':'no_route_yet'};
 if((now-new Date(cached.computedAt).getTime())/1000>assumptions.routeMaxAgeSeconds)return {recalculate:true,reason:'route_expired'};
 const placed=position?positionOnRoute(position,cached.geometry):null;
 if(!placed)return {recalculate:true,reason:'route_unusable'};
 if(placed.distanceFromRouteMeters>assumptions.routeDeviationMeters)return {recalculate:true,reason:'route_deviation'};
 return {recalculate:false,reason:'on_route',remainingSeconds:cached.durationSeconds*placed.remainingShare};
}

const unavailable=(stage,reason)=>({status:'unavailable',stage,reason,confidence:'none',remainingSeconds:null,customerMessage:CUSTOMER_MESSAGES[reason]??null});

/** Remaining seconds from the current delivery stage. Food preparation and rider travel run in
 * parallel, so only the longer one counts before the pickup handover. */
export function calculateStageEta({state,isFood=false,foodState=null,foodReadyAt=null,gps=null,riderToPickupSeconds=null,riderToDropoffSeconds=null,pickupToDropoffSeconds=null,now=Date.now(),assumptions=ETA_ASSUMPTIONS}){
 const stage=state;
 if(['COMPLETED','CANCELLED','RETURNED','FAILED','RETURN_REQUESTED'].includes(state))return unavailable(stage,'closed');
 if(state==='AWAITING_PAYMENT')return unavailable(stage,'awaiting_payment');
 if(state==='AWAITING_ASSIGNMENT'){
  if(isFood&&['SUBMITTED','PLACED'].includes(foodState))return unavailable(stage,'awaiting_kitchen');
  return unavailable(stage,'awaiting_rider');
 }
 if(!gps?.usable)return unavailable(stage,'no_location');
 if(state==='AWAITING_DELIVERY_OTP'){
  return {status:'estimated',stage,reason:'rider_at_handover',confidence:gps.quality==='good'?'medium':'low',remainingSeconds:assumptions.dropoffHandoverSeconds,breakdown:{handoverSeconds:assumptions.dropoffHandoverSeconds}};
 }
 let breakdown;
 if(state==='RIDER_ASSIGNED'){
  if(!Number.isFinite(riderToPickupSeconds)||!Number.isFinite(pickupToDropoffSeconds))return unavailable(stage,'no_route');
  const readyAtMs=foodReadyAt?new Date(foodReadyAt).getTime():NaN;
  const prepRemainingSeconds=isFood&&foodState!=='READY_FOR_PICKUP'&&Number.isFinite(readyAtMs)?Math.max(0,(readyAtMs-now)/1000):0;
  breakdown={riderToPickupSeconds,prepRemainingSeconds,pickupWaitSeconds:Math.max(riderToPickupSeconds,prepRemainingSeconds),pickupHandoverSeconds:assumptions.pickupHandoverSeconds,pickupToDropoffSeconds,dropoffHandoverSeconds:assumptions.dropoffHandoverSeconds};
 }else if(['PICKUP_VERIFIED','IN_TRANSIT'].includes(state)){
  if(!Number.isFinite(riderToDropoffSeconds))return unavailable(stage,'no_route');
  breakdown={riderToDropoffSeconds,dropoffHandoverSeconds:assumptions.dropoffHandoverSeconds};
 }else return unavailable(stage,'no_route');
 const remainingSeconds=breakdown.riderToDropoffSeconds!==undefined
  ?breakdown.riderToDropoffSeconds+breakdown.dropoffHandoverSeconds
  :breakdown.pickupWaitSeconds+breakdown.pickupHandoverSeconds+breakdown.pickupToDropoffSeconds+breakdown.dropoffHandoverSeconds;
 return {status:'estimated',stage,reason:'stage_estimate',confidence:gps.quality==='good'?'medium':'low',remainingSeconds:Math.ceil(remainingSeconds),breakdown};
}

/** Width of the customer range: measured when trips support it, otherwise a deliberately wide default. */
export function etaRange(remainingSeconds,{confidence='low',measuredSpread=null}={}){
 const defaultShare={high:0.15,medium:0.25,low:0.4}[confidence]??0.4;
 const low=measuredSpread?.low??1-defaultShare,high=measuredSpread?.high??1+defaultShare;
 const toMinutes=v=>Math.max(1,Math.ceil(v/60));
 const minMinutes=toMinutes(remainingSeconds*low);
 return {minMinutes,maxMinutes:Math.max(minMinutes+1,toMinutes(remainingSeconds*high))};
}

/** Keeps the customer's arrival time steady unless the stage changes or it moves materially. */
export function stabilizeArrival({previous,arrivalMs,stage,now=Date.now(),assumptions=ETA_ASSUMPTIONS}){
 if(!previous||previous.stage!==stage||!Number.isFinite(previous.arrivalMs))return {arrivalMs,changed:true};
 // A passed arrival time must not stay frozen on screen.
 if(previous.arrivalMs<=now)return {arrivalMs,changed:true};
 if(Math.abs(arrivalMs-previous.arrivalMs)>=assumptions.displayChangeSeconds*1000)return {arrivalMs,changed:true};
 return {arrivalMs:previous.arrivalMs,changed:false};
}

export function etaCustomerMessage({confidence,minMinutes,maxMinutes,gpsQuality}){
 const base=`Arriving in about ${minMinutes}–${maxMinutes} minutes.`;
 if(confidence==='low')return gpsQuality==='good'?`${base} This is a rough estimate.`:`${base} This is a rough estimate because your rider's location is not up to date.`;
 return base;
}

/** Trip outcomes usable as evidence: rejects impossible ratios and very short trips. */
export function summarizeTripEvidence(samples,{minSamples=30}={}){
 const ratios=[],errors=[];let rejected=0;
 for(const s of samples??[]){
  const p=Number(s.predictedSeconds),a=Number(s.actualSeconds);
  const ratio=a/p;
  if(!Number.isFinite(p)||!Number.isFinite(a)||p<60||a<=0||a>14400||ratio<0.25||ratio>4){rejected++;continue;}
  ratios.push(ratio);errors.push(Math.abs(a-p));
 }
 ratios.sort((x,y)=>x-y);errors.sort((x,y)=>x-y);
 const pick=(list,share)=>list[Math.min(list.length-1,Math.floor(list.length*share))];
 const sampleCount=ratios.length,sufficient=sampleCount>=minSamples;
 return {
  sampleCount,rejectedCount:rejected,minSamples,sufficient,
  medianRatio:sampleCount?pick(ratios,0.5):null,
  p10Ratio:sampleCount?pick(ratios,0.1):null,
  p90Ratio:sampleCount?pick(ratios,0.9):null,
  medianAbsoluteErrorSeconds:sampleCount?Math.round(pick(errors,0.5)):null
 };
}

/** Travel-time adjustment for the customer ETA only. Measured trips replace the assumption
 * once there are enough of them; otherwise the configured baseline applies. */
export function travelAdjustment({evidence,baselineFactor=1,minFactor=0.5,maxFactor=3}){
 if(evidence?.sufficient)return {factor:Math.max(minFactor,Math.min(maxFactor,evidence.medianRatio)),source:'measured',sampleCount:evidence.sampleCount,measuredSpread:{low:evidence.p10Ratio/evidence.medianRatio,high:evidence.p90Ratio/evidence.medianRatio}};
 return {factor:baselineFactor,source:baselineFactor===1?'none':'assumed_baseline',sampleCount:evidence?.sampleCount??0,measuredSpread:null};
}

export function timeBucket(date){
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:MARKET_TIME_ZONE,hour:'2-digit',hourCycle:'h23'}).format(new Date(date)));
 if(hour>=6&&hour<10)return 'morning_peak';
 if(hour>=10&&hour<16)return 'midday';
 if(hour>=16&&hour<20)return 'evening_peak';
 return 'off_peak';
}

export function cityBucket(point){
 const inBox=(a,b,c,d)=>point?.latitude>=a&&point?.latitude<=b&&point?.longitude>=c&&point?.longitude<=d;
 if(inBox(5.45,5.85,-0.45,0.1))return 'accra';
 if(inBox(6.55,6.8,-1.75,-1.5))return 'kumasi';
 return 'other';
}
