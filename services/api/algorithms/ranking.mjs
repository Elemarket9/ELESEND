/** Mandatory eligibility is a hard gate; road ETA dominates non-critical tie breaks. */
export function eligibleAndRank(candidates,{maxPickupEtaSeconds=1800}={}){
 return candidates.filter(r=>r?.eligible===true&&r.locationFresh===true&&r.vehicleFits===true&&r.capacityFits===true&&r.roadVerified===true&&Number.isFinite(r.pickupEtaSeconds)&&r.pickupEtaSeconds>=0&&r.pickupEtaSeconds<=maxPickupEtaSeconds)
  .sort((a,b)=>a.pickupEtaSeconds-b.pickupEtaSeconds||Number(Boolean(b.approaching))-Number(Boolean(a.approaching))||String(a.id).localeCompare(String(b.id)));
}
