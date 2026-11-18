import {haversine} from '../dispatch-geometry.mjs';
/** Conservative adaptive smoother. Only for display/directional hints, NOT OTP or custody proof. */
export function smoothGps(previous,observation,{maxSpeedMps=55,minAccuracyM=5,maxAccuracyM=150}={}){
 const p=observation;const valid=x=>x&&Number.isFinite(x.latitude)&&Math.abs(x.latitude)<=90&&Number.isFinite(x.longitude)&&Math.abs(x.longitude)<=180&&Number.isFinite(x.accuracyMeters)&&x.accuracyMeters>=0&&x.accuracyMeters<=maxAccuracyM&&Number.isFinite(Date.parse(x.observedAt));
 if(!valid(p))return {accepted:false,reason:'inaccurate_or_invalid'};
 if(!previous)return {accepted:true,estimate:{...p},confidence:'initial'};
 if(!valid(previous))return {accepted:false,reason:'bad_previous'};
 const dt=(Date.parse(p.observedAt)-Date.parse(previous.observedAt))/1000;
 if(dt<=0)return {accepted:false,reason:'replayed'};
 if(dt>600)return {accepted:true,estimate:{...p},confidence:'reset_after_gap'};
 const speed=haversine(previous,p)/dt,accuracySlack=(previous.accuracyMeters+p.accuracyMeters)/Math.max(1,dt);
 if(speed>maxSpeedMps+accuracySlack)return {accepted:false,reason:'implausible_jump'};
 const alpha=Math.max(.1,Math.min(.9,dt/(dt+Math.max(minAccuracyM,p.accuracyMeters)*.3)));
 const estimate={...p,latitude:previous.latitude+alpha*(p.latitude-previous.latitude),longitude:previous.longitude+alpha*(p.longitude-previous.longitude)};
 return {accepted:true,estimate,confidence:p.accuracyMeters<=25?'good':'low',speedMps:speed};
}
