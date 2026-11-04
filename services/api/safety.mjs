import {requirePermission} from './permissions.mjs';
/** Emergency alerts, trusted contacts, live location links and two-way delivery ratings. */
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check,phone} from './security.mjs';
import {createPublicTrackingToken} from './infrastructure/maps/web-tracker.mjs';

const uuid=z.string().uuid();
async function ownShipment(db,actor,shipmentId){
 uuid.parse(shipmentId);
 const s=(await db.query('SELECT id,customer_id,rider_id,state,completed_at FROM shipments WHERE id=$1',[shipmentId])).rows[0];
 check(s&&(s.customer_id===actor.id||s.rider_id===actor.id),403,'This delivery is not yours');
 return s;
}
const requireVerifier=(c,actor)=>requirePermission(c,actor,'verification:write');
export async function saveTrustedContact(db,actor,input){
 const v=z.object({name:z.string().trim().min(2).max(80),phone:z.string().trim().min(9).max(16)}).strict().parse(input);
 const normalized=phone(v.phone);
 await db.query('INSERT INTO trusted_contacts(user_id,name,phone) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,phone=excluded.phone,updated_at=now()',[actor.id,v.name,normalized]);
 return {name:v.name,phone:normalized};
}
export async function getTrustedContact(db,actor){
 return (await db.query('SELECT name,phone FROM trusted_contacts WHERE user_id=$1',[actor.id])).rows[0]??null;
}
const emergencySchema=z.object({
 shipmentId:uuid.optional(),
 latitude:z.number().min(-90).max(90).optional(),
 longitude:z.number().min(-180).max(180).optional()
}).strict();
/** Alerts go to the duty phone and the trusted contact. The app also offers the public emergency number. */
export async function raiseEmergency(db,actor,input,{sms=null,dutyPhone=process.env.SAFETY_ALERT_PHONE}={}){
 const v=emergencySchema.parse(input);
 if(v.shipmentId)await ownShipment(db,actor,v.shipmentId);
 const recent=(await db.query("SELECT id,notified_count FROM safety_alerts WHERE user_id=$1 AND status='open' AND created_at>now()-interval '5 minutes' ORDER BY created_at DESC LIMIT 1",[actor.id])).rows[0];
 const emergencyNumber=process.env.EMERGENCY_NUMBER||'112';
 if(recent)return {id:recent.id,notified:recent.notified_count,duplicate:true,emergencyNumber};
 const id=randomUUID();
 const user=(await db.query('SELECT phone,kind FROM users WHERE id=$1',[actor.id])).rows[0];
 await db.query('INSERT INTO safety_alerts(id,user_id,shipment_id,latitude,longitude) VALUES($1,$2,$3,$4,$5)',[id,actor.id,v.shipmentId??null,v.latitude??null,v.longitude??null]);
 await db.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'safety.emergency_raised',$1)",[actor.id]);
 await db.query("INSERT INTO operational_risk_signals(rider_id,shipment_id,signal_code,severity,evidence) VALUES($1,$2,'EMERGENCY_ALERT','high',$3)",[user?.kind==='rider'?actor.id:null,v.shipmentId??null,JSON.stringify({alertId:id})]);
 const place=v.latitude!==undefined&&v.longitude!==undefined?` Location: https://maps.google.com/?q=${v.latitude},${v.longitude}`:' Location unavailable.';
 const contact=await getTrustedContact(db,actor);
 const targets=[[dutyPhone,`ELESEND EMERGENCY: ${user?.kind||'user'} ${user?.phone||''} pressed the emergency button.${place}`],[contact?.phone,`ELESEND safety alert: ${user?.phone||'Your contact'} pressed the emergency button and named you as a trusted contact.${place}`]].filter(([to])=>to);
 const results=await Promise.allSettled(targets.map(async([to,message],i)=>{
  check(typeof sms?.sendNotification==='function',503,'SMS unavailable');
  return sms.sendNotification({phone:to,message,clientReference:id.slice(0,35)+i,kind:'safety_alert'});
 }));
 const notified=results.filter(r=>r.status==='fulfilled').length;
 await db.query('UPDATE safety_alerts SET notified_count=$2 WHERE id=$1',[id,notified]);
 return {id,notified,duplicate:false,emergencyNumber};
}
export async function listSafetyAlerts(db,actor){
 await requireVerifier(db,actor);
 return (await db.query('SELECT a.*,u.phone,u.kind FROM safety_alerts a JOIN users u ON u.id=a.user_id ORDER BY a.status,a.created_at DESC LIMIT 100')).rows;
}
export async function resolveSafetyAlert(db,actor,id,input){
 uuid.parse(id);
 const {note}=z.object({note:z.string().trim().min(3).max(1000)}).strict().parse(input);
 await requireVerifier(db,actor);
 const row=(await db.query("UPDATE safety_alerts SET status='resolved',resolution_note=$2,resolved_by=$3,resolved_at=now() WHERE id=$1 RETURNING id",[id,note,actor.id])).rows[0];
 check(row,404,'Alert not found');
 return {id,status:'resolved'};
}
export async function createShareLink(db,actor,input){
 const {shipmentId}=z.object({shipmentId:uuid}).strict().parse(input);
 const s=await ownShipment(db,actor,shipmentId);
 check(!['CANCELLED','RETURNED','COMPLETED'].includes(s.state),409,'This delivery has finished');
 return {path:'/track/'+createPublicTrackingToken(shipmentId)};
}
const ratingSchema=z.object({stars:z.number().int().min(1).max(5),comment:z.string().trim().max(500).optional()}).strict();
export async function rateDelivery(db,actor,shipmentId,input){
 const v=ratingSchema.parse(input);
 const s=await ownShipment(db,actor,shipmentId);
 check(['COMPLETED','RETURNED'].includes(s.state),409,'You can rate this delivery once it has finished');
 check(s.rider_id,409,'This delivery had no rider');
 const ratee=s.customer_id===actor.id?s.rider_id:s.customer_id;
 return db.tx(async c=>{
  const row=await c.query('INSERT INTO delivery_ratings(shipment_id,rater_id,ratee_id,stars,comment) VALUES($1,$2,$3,$4,$5) ON CONFLICT(shipment_id,rater_id) DO NOTHING RETURNING shipment_id',[s.id,actor.id,ratee,v.stars,v.comment??null]);
  check(row.rowCount,409,'You have already rated this delivery');
  // Poor recent ratings go to staff for review. A rating alone never suspends anyone.
  const recent=(await c.query('SELECT avg(stars)::float AS average,count(*)::int AS total FROM (SELECT stars FROM delivery_ratings WHERE ratee_id=$1 ORDER BY created_at DESC LIMIT 50) x',[ratee])).rows[0];
  if(recent.total>=20&&recent.average<3.5&&!(await c.query("SELECT 1 FROM operational_risk_signals WHERE signal_code='LOW_RATING' AND review_status='pending' AND evidence->>'userId'=$1",[ratee])).rowCount){
   const isRider=(await c.query('SELECT 1 FROM riders WHERE id=$1',[ratee])).rowCount>0;
   await c.query("INSERT INTO operational_risk_signals(rider_id,signal_code,severity,evidence) VALUES($1,'LOW_RATING','medium',$2)",[isRider?ratee:null,JSON.stringify({userId:ratee,average:recent.average,total:recent.total})]);
  }
  return {shipmentId:s.id,stars:v.stars};
 });
}
export async function myRating(db,actor){
 const r=(await db.query('SELECT avg(stars)::float AS average,count(*)::int AS total FROM (SELECT stars FROM delivery_ratings WHERE ratee_id=$1 ORDER BY created_at DESC LIMIT 200) x',[actor.id])).rows[0];
 return {average:r.total?Math.round(r.average*100)/100:null,total:r.total};
}
export async function pendingRatings(db,actor){
 return (await db.query(`SELECT s.id,s.state,s.completed_at,CASE WHEN s.customer_id=$1 THEN 'rider' ELSE 'customer' END AS rate
   FROM shipments s WHERE (s.customer_id=$1 OR s.rider_id=$1) AND s.rider_id IS NOT NULL AND s.state IN ('COMPLETED','RETURNED')
    AND s.created_at>now()-interval '7 days' AND NOT EXISTS(SELECT 1 FROM delivery_ratings r WHERE r.shipment_id=s.id AND r.rater_id=$1)
   ORDER BY s.created_at DESC LIMIT 5`,[actor.id])).rows;
}
