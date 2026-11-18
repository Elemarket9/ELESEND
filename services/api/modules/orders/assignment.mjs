// Taking a delivery away from its rider. Used by the dispatch watchdog and by the food module when a kitchen
// cancels or staff reassign, so every path removes the same things inside the caller's transaction.
/** Removes a rider's claim on one delivery: its stop on their route, open codes, live location, delivery promise
 * and offers. The caller has already locked the shipment and, when there is a rider, their route. */
export async function clearRiderAssignment(c, {shipmentId, riderId = null}) {
  if (riderId) {
    const plan = (await c.query('SELECT stops FROM rider_dispatch_plans WHERE rider_id=$1 FOR UPDATE', [riderId])).rows[0];
    if (plan && Array.isArray(plan.stops)) {
      await c.query('UPDATE rider_dispatch_plans SET stops=$2,revision=revision+1,updated_at=now() WHERE rider_id=$1', [riderId, JSON.stringify(plan.stops.filter(x => x.shipmentId !== shipmentId))]);
    }
  }
  await c.query('UPDATE challenges SET expires_at=now() WHERE shipment_id=$1 AND consumed_at IS NULL', [shipmentId]);
  await c.query('DELETE FROM locations WHERE shipment_id=$1', [shipmentId]);
  await c.query('DELETE FROM dispatch_commitments WHERE shipment_id=$1', [shipmentId]);
  await c.query("UPDATE dispatch_offers SET status='invalidated' WHERE shipment_id=$1 AND status IN ('offered','accepted')", [shipmentId]);
}
