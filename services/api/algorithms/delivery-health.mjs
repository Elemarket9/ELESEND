/** One definition of a delivery in trouble, used for parcels and food orders. */
export function assessDeliveryHealth({pickedUp,rider,location,staleSec,pickupGraceSec,readyAt,offer,deliveryDeadlineMs,nowMs=Date.now()}){
 const latestGpsMs=Math.max(rider?.position_at?new Date(rider.position_at).getTime():-Infinity,location?.updated_at?new Date(location.updated_at).getTime():-Infinity);
 const isStaleGps=!rider?.online||!Number.isFinite(latestGpsMs)||(nowMs-latestGpsMs)>staleSec*1000;
 const pickupDeadlineMs=Math.min(
  readyAt?new Date(readyAt).getTime()+pickupGraceSec*1000:Infinity,
  offer?.accepted_at?new Date(offer.accepted_at).getTime()+(Number(offer.pickup_eta_seconds||300)+pickupGraceSec)*1000:Infinity
 );
 const isOverduePickup=!pickedUp&&Number.isFinite(pickupDeadlineMs)&&nowMs>pickupDeadlineMs;
 const isOverdueDelivery=Boolean(pickedUp&&Number.isFinite(deliveryDeadlineMs)&&nowMs>deliveryDeadlineMs);
 const reasons=[],signals=[];
 if(isStaleGps){reasons.push('stale_gps');signals.push({code:'STALE_GPS',severity:pickedUp?'high':'medium'});}
 if(isOverduePickup){reasons.push('overdue_pickup');signals.push({code:'OVERDUE_PICKUP',severity:'medium'});}
 if(isOverdueDelivery){reasons.push('overdue_delivery');signals.push({code:'OVERDUE_DELIVERY',severity:'high'});}
 return {reasons,signals,isStaleGps,isOverduePickup,isOverdueDelivery,nowMs};
}
