/** Transparent, bounded policy, not an imitation of a proprietary algorithm. */
export function smoothSurge({demand,supply,previousBps=10000}){
 for(const value of [demand,supply,previousBps])if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid surge observation');
 if(previousBps<10000||previousBps>20000)throw Error('Invalid prior multiplier');
 // At least three independent senders; browsing/repeated quotes cannot raise it.
 const target=demand<3?10000:Math.min(20000,10000+Math.floor(Math.max(0,demand-supply)*10000/Math.max(1,supply)));
 if(Math.abs(target-previousBps)<500)return target===10000?10000:previousBps;
 const smoothed=Math.round((3*previousBps+target)/4);
 return Math.max(10000,Math.min(20000,previousBps+Math.max(-500,Math.min(500,smoothed-previousBps))));
}
export async function measuredSurge(db,pickup,vehicle){
 const zone=(await db.query(`SELECT id FROM pricing_surge_zones WHERE enabled
  AND ST_DWithin(center,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,radius_m)
  ORDER BY radius_m,id LIMIT 1`,[pickup.longitude,pickup.latitude])).rows[0];
 if(!zone)return {multiplierBps:10000,reason:'no_enabled_surge_zone'};
 return db.tx(async c=>{
  await c.query('INSERT INTO pricing_surge_state(zone_id,vehicle) VALUES($1,$2) ON CONFLICT DO NOTHING',[zone.id,vehicle]);
  const state=(await c.query(`SELECT *,updated_at>now()-interval '30 seconds' AS fresh FROM pricing_surge_state
   WHERE zone_id=$1 AND vehicle=$2 FOR UPDATE`,[zone.id,vehicle])).rows[0];
  if(state.fresh)return {multiplierBps:state.multiplier_bps,zoneId:zone.id,demand:state.demand,supply:state.supply,reason:'cached_observation'};
  const observation=(await c.query(`SELECT
   (SELECT count(DISTINCT s.customer_id)::int FROM shipments s JOIN quotes q ON q.id=s.quote_id
    WHERE s.state='AWAITING_ASSIGNMENT' AND (s.paid OR s.payment_method='CASH')
     AND s.created_at>now()-interval '10 minutes' AND q.request->>'vehicle'=$2
     AND ST_DWithin(ST_SetSRID(ST_MakePoint((q.request->'pickup'->>'longitude')::float8,
      (q.request->'pickup'->>'latitude')::float8),4326)::geography,z.center,z.radius_m)) AS demand,
   (SELECT count(*)::int FROM riders r LEFT JOIN companies co ON co.id=r.company_id
    JOIN vehicle_capabilities vc ON vc.vehicle=r.vehicle AND vc.enabled
    WHERE r.status='approved' AND r.online AND r.vehicle=$2 AND (r.company_id IS NULL OR co.status='approved')
     AND r.position_at>now()-interval '60 seconds' AND r.position_accuracy_m<=100
     AND (r.vehicle<>'car' OR EXISTS(SELECT 1 FROM rider_vehicle_registrations vr WHERE vr.rider_id=r.id AND vr.verification_status='approved'))
     AND ST_DWithin(r.current_position,z.center,z.radius_m)
     AND NOT EXISTS(SELECT 1 FROM shipments active WHERE active.rider_id=r.id AND active.state IN
      ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED'))) AS supply
   FROM pricing_surge_zones z WHERE z.id=$1 AND z.enabled`,[zone.id,vehicle])).rows[0];
  if(!observation)return {multiplierBps:10000,reason:'zone_disabled'};
  const multiplierBps=smoothSurge({...observation,previousBps:state.multiplier_bps});
  await c.query('UPDATE pricing_surge_state SET multiplier_bps=$3,demand=$4,supply=$5,updated_at=now() WHERE zone_id=$1 AND vehicle=$2',[zone.id,vehicle,multiplierBps,observation.demand,observation.supply]);
  return {multiplierBps,zoneId:zone.id,...observation,reason:'observed_local_supply_demand'};
 });
}
