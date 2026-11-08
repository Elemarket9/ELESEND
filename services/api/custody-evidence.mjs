/** Ownership: orders. Returns evidence of a parcel already taken into physical custody.
 * Both immutable rider declarations and historical consumed OTP proof remain valid.
 */
export async function hasPickupCustodyEvidence(c,shipmentId){
 const result=await c.query(
  "SELECT 1 FROM shipment_handover_events WHERE shipment_id=$1 AND kind='pickup' UNION SELECT 1 FROM challenges WHERE shipment_id=$1 AND purpose='pickup' AND consumed_at IS NOT NULL",
  [shipmentId]
 );
 return result.rowCount>0;
}
