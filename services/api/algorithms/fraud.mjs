import {haversine} from '../dispatch-geometry.mjs';
/** Algorithm 12 — explainable risk signals, not automatic allegations or account sanctions.
 * In production signals are persisted in immutable operational_risk_signals.
 */
export function detectFraudSignals({gps,previousGps,otpFailures=0,cashShortfallMinor=0,
 duplicateWebhookCount=0,customerDisputesLast30Days=0,maxPlausibleSpeedMps=60}={}){
 const signals=[];
 if(gps&&previousGps){
  const dt=(Date.parse(gps.observedAt)-Date.parse(previousGps.observedAt))/1000;
  if(!Number.isFinite(dt)||dt<=0)signals.push({code:'GPS_REPLAY',severity:'medium'});
  else if([gps.latitude,gps.longitude,previousGps.latitude,previousGps.longitude].every(Number.isFinite)){
   const speed=haversine(gps,previousGps)/dt;
   const slack=(Math.max(0,Number(gps.accuracyMeters)||0)+Math.max(0,Number(previousGps.accuracyMeters)||0))/dt;
   if(speed>maxPlausibleSpeedMps+slack)signals.push({code:'GPS_IMPLAUSIBLE_TRAVEL',severity:'medium'});
  }
 }
 if(otpFailures>=5)signals.push({code:'OTP_BRUTE_FORCE',severity:'high'});
 if(cashShortfallMinor>0)signals.push({code:'CASH_SHORTFALL_REVIEW',severity:'medium'});
 if(duplicateWebhookCount>=3)signals.push({code:'REPEATED_PAYMENT_EVENTS',severity:'medium'});
 if(customerDisputesLast30Days>=5)signals.push({code:'DISPUTE_CLUSTER_REVIEW',severity:'low'});
 return {signals,requiresReview:signals.some(s=>s.severity==='high'||s.severity==='medium'),autoPunish:false};
}
