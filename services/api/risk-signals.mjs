/** Adds each open risk signal once, whichever watchdog noticed it. */
export async function recordRiderRiskSignals(c,riderId,shipmentId,signals,evidence){
 for(const sig of signals){
  const existing=(await c.query("SELECT id FROM operational_risk_signals WHERE rider_id=$1 AND shipment_id=$2 AND signal_code=$3 AND review_status='pending' LIMIT 1",[riderId,shipmentId,sig.code])).rows[0];
  if(!existing){
   await c.query('INSERT INTO operational_risk_signals(rider_id,shipment_id,signal_code,severity,evidence) VALUES($1,$2,$3,$4,$5)',
    [riderId,shipmentId,sig.code,sig.severity,JSON.stringify(evidence)]);
  }
 }
}
