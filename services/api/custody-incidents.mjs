import {requirePermission} from './permissions.mjs';
/**
 * A parcel still with its rider long after pickup becomes a custody incident. The system suspends the
 * rider and preserves evidence. Reporting to the police remains a decision for an authorised person.
 */
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';

const IN_CUSTODY=['PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED'];
export function custodyLimitHours(){
 const n=Number(process.env.PARCEL_CUSTODY_LIMIT_HOURS);
 return process.env.PARCEL_CUSTODY_LIMIT_HOURS&&Number.isSafeInteger(n)&&n>0?n:24;
}
const permit=(c,actor)=>requirePermission(c,actor,'verification:write');
async function evidenceFor(c,shipmentId){
 const e=(await c.query(`SELECT s.id AS shipment_id,s.state,s.amount_minor,s.payment_method,s.paid,s.recipient_phone,s.company_id,s.rider_id,
    sender.phone AS sender_phone,rider.phone AS rider_phone,r.vehicle,v.registration_plate,v.make,v.model,v.color,
    l.legal_name,l.document_type,l.licence_class,l.expires_on::text AS document_expires_on,
    q.request->'pickup' AS pickup,q.request->'destination' AS destination,q.request->>'description' AS description,
    COALESCE((SELECT confirmed_at FROM shipment_handover_events h WHERE h.shipment_id=s.id AND h.rider_id=s.rider_id AND h.kind='pickup' ORDER BY confirmed_at DESC LIMIT 1), (SELECT consumed_at FROM challenges ch WHERE ch.shipment_id=s.id AND ch.rider_id=s.rider_id AND ch.purpose='pickup' AND ch.consumed_at IS NOT NULL ORDER BY ch.consumed_at DESC LIMIT 1)) AS picked_up_at,
    ST_Y(r.current_position::geometry) AS last_latitude,ST_X(r.current_position::geometry) AS last_longitude,r.position_at AS last_position_at
   FROM shipments s JOIN users sender ON sender.id=s.customer_id JOIN users rider ON rider.id=s.rider_id JOIN riders r ON r.id=s.rider_id
   JOIN quotes q ON q.id=s.quote_id LEFT JOIN rider_vehicle_registrations v ON v.rider_id=s.rider_id LEFT JOIN rider_licences l ON l.rider_id=s.rider_id
   WHERE s.id=$1`,[shipmentId])).rows[0];
 return {...e,capturedAt:new Date().toISOString()};
}
export async function flagOverdueParcels(db,{limit=50,limitHours=custodyLimitHours()}={}){
 const due=(await db.query(`SELECT s.id FROM shipments s
   WHERE s.state=ANY($1::text[]) AND s.rider_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM food_orders f WHERE f.shipment_id=s.id)
     AND NOT EXISTS(SELECT 1 FROM parcel_custody_incidents i WHERE i.shipment_id=s.id)
     AND (EXISTS(SELECT 1 FROM shipment_handover_events h WHERE h.shipment_id=s.id AND h.rider_id=s.rider_id AND h.kind='pickup' AND h.confirmed_at<now()-make_interval(hours=>$2)) OR EXISTS(SELECT 1 FROM challenges ch WHERE ch.shipment_id=s.id AND ch.rider_id=s.rider_id AND ch.purpose='pickup' AND ch.consumed_at<now()-make_interval(hours=>$2)))
   ORDER BY s.created_at LIMIT $3`,[IN_CUSTODY,limitHours,limit])).rows;
 const flagged=[];
 for(const {id:shipmentId} of due){
  const opened=await db.tx(async c=>{
   const s=(await c.query('SELECT id,rider_id,state FROM shipments WHERE id=$1 FOR UPDATE',[shipmentId])).rows[0];
   if(!s||!IN_CUSTODY.includes(s.state))return null;
   const id=randomUUID();
   const row=await c.query('INSERT INTO parcel_custody_incidents(id,shipment_id,rider_id,evidence) VALUES($1,$2,$3,$4) ON CONFLICT(shipment_id) DO NOTHING RETURNING id',[id,s.id,s.rider_id,JSON.stringify(await evidenceFor(c,s.id))]);
   if(!row.rowCount)return null;
   // Suspension stops new jobs and withdrawals, so the rider's unpaid earnings stay in the balance.
   await c.query("UPDATE riders SET status='suspended',online=false WHERE id=$1",[s.rider_id]);
   await c.query("INSERT INTO operational_risk_signals(rider_id,shipment_id,signal_code,severity,evidence) VALUES($1,$2,'PARCEL_NOT_RETURNED','high',$3)",[s.rider_id,s.id,JSON.stringify({incidentId:id})]);
   await c.query("INSERT INTO audit_logs(action,entity_id) VALUES('parcel.custody_incident_opened',$1)",[s.id]);
   return id;
  });
  if(opened)flagged.push(opened);
 }
 return flagged;
}
export async function listCustodyIncidents(db,actor){
 return db.tx(async c=>{
  await permit(c,actor);
  await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'parcel.custody_incidents_viewed',$1)",[actor.id]);
  return (await c.query('SELECT * FROM parcel_custody_incidents ORDER BY opened_at DESC LIMIT 100')).rows;
 });
}
const decision=z.object({
 outcome:z.enum(['police_reported','recovered','false_alarm']),
 reason:z.string().trim().min(5).max(1000),
 policeReference:z.string().trim().min(2).max(100).optional()
}).strict();
export async function resolveCustodyIncident(db,actor,id,input){
 const v=decision.parse(input);
 return db.tx(async c=>{
  await permit(c,actor);
  const row=(await c.query('UPDATE parcel_custody_incidents SET outcome=$2,outcome_reason=$3,police_reference=coalesce($4,police_reference),decided_by=$5,decided_at=now() WHERE id=$1 RETURNING *',[id,v.outcome,v.reason,v.policeReference??null,actor.id])).rows[0];
  check(row,404,'Incident not found');
  await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'parcel.custody_incident_'+v.outcome,row.shipment_id]);
  return row;
 });
}
