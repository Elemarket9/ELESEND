import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check,hash,newToken,phone as normalPhone} from '../../shared/security.mjs';
import {companyBalance} from '../payments/index.mjs';
import {queueNotification} from '../orders/index.mjs';
import {approveRiderDocuments,riderPhotoFor} from './rider-documents.mjs';
import {approveRiderLicence} from './rider-licence.mjs';
import {approveVehicleRecord,vehiclePlateFor} from './vehicle.mjs';
import {ACCEPTED_SERVICES} from './company-services.mjs';

const uuid=z.string().uuid();
const SERVICES=ACCEPTED_SERVICES;
const servicesSchema=z.object({services:z.array(z.enum(SERVICES)).min(1).max(2)}).strict();
const audit=(c,actor,action,target)=>c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,action,target]);
const owned=async(c,actor)=>{
 check(actor.kind==='company',403,'Company account required');
 const row=(await c.query('SELECT id,name,status,services FROM companies WHERE owner_id=$1',[actor.id])).rows[0];
 check(row,404,'Company not found');
 return row;
};
const approvedFor=async(c,actor,service)=>{
 const row=await owned(c,actor);
 check(row.status==='approved',403,'Your company is waiting for approval');
 check(row.services.includes(service),403,service==='delivery'?'Turn on delivery services for your company first':'Turn on rider supply for your company first');
 return row;
};
export {ACCEPTED_SERVICES};
/** Stops an account booking or using API access unless its company is approved for deliveries. */
export async function assertCompanyDelivery(c,actor){if(actor.kind==='company')await approvedFor(c,actor,'delivery');}

export function companyService(db){return {
 async profile(actor){
  const row=await owned(db,actor);
  const riders=(await db.query('SELECT count(*)::int AS total,count(*) FILTER (WHERE online)::int AS online FROM riders WHERE company_id=$1',[row.id])).rows[0];
  return {...row,riders,balance:await companyBalance(db,row.id)};
 },
 async setServices(actor,input){
  const v=servicesSchema.parse(input);
  const services=[...new Set(v.services)];
  return db.tx(async c=>{
   const row=await owned(c,actor);
   if(!services.includes('riders'))check(!(await c.query('SELECT 1 FROM riders WHERE company_id=$1 LIMIT 1',[row.id])).rowCount,409,'Remove your riders before turning off rider supply');
   await c.query('UPDATE companies SET services=$2 WHERE id=$1',[row.id,services]);
   if(!services.includes('delivery'))await c.query('UPDATE api_clients SET revoked_at=now() WHERE owner_id=$1 AND revoked_at IS NULL',[actor.id]);
   if(!services.includes('riders'))await c.query("UPDATE rider_invitations SET status='revoked' WHERE company_id=$1 AND status='pending'",[row.id]);
   await audit(c,actor,'company.services_changed',row.id);
   return {services};
  });
 },
 /** The same answer for every number, so this cannot be used to find out who is a rider. */
 async inviteByPhone(actor,input){
  const v=z.object({phone:z.string().min(9).max(30)}).strict().parse(input);
  const phone=normalPhone(v.phone);
  await db.tx(async c=>{
   const co=await approvedFor(c,actor,'riders');
   const rider=(await c.query("SELECT r.id FROM riders r JOIN users u ON u.id=r.id WHERE u.phone=$1 AND r.status IN ('approved','pending') AND r.company_id IS NULL FOR UPDATE OF r",[phone])).rows[0];
   if(!rider)return;
   const open=(await c.query("UPDATE rider_invitations SET expires_at=now()+interval '48 hours' WHERE company_id=$1 AND rider_id=$2 AND status='pending' RETURNING id",[co.id,rider.id])).rows[0];
   if(open)return;
   const id=randomUUID();
   // The rider accepts in the app, so this random value is never given to anyone.
   await c.query("INSERT INTO rider_invitations(id,company_id,rider_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '48 hours')",[id,co.id,rider.id,hash(newToken())]);
   await audit(c,actor,'company.rider_invited',rider.id);
   await queueNotification(c,{id:`company-invite:${id}`,recipientId:rider.id,kind:'company_invitation',payload:{invitationId:id,message:`${co.name} has invited you to ride for them. Open the Rider app to answer.`}});
  });
  return {ok:true,message:'If this number has an ELESEND rider account, they will see your invitation in their app for 48 hours. New riders can sign up first, then accept.'};
 },
 async invitations(actor){
  const co=await approvedFor(db,actor,'riders');
  return (await db.query(`SELECT i.id,i.status,i.expires_at,i.created_at,right(u.phone,4) AS rider_phone_ending FROM rider_invitations i JOIN users u ON u.id=i.rider_id
    WHERE i.company_id=$1 AND i.status='pending' AND i.expires_at>now() ORDER BY i.created_at DESC LIMIT 100`,[co.id])).rows;
 },
 async revokeInvitation(actor,id){
  uuid.parse(id);
  return db.tx(async c=>{
   const co=await approvedFor(c,actor,'riders');
   check((await c.query("UPDATE rider_invitations SET status='revoked' WHERE id=$1 AND company_id=$2 AND status='pending' RETURNING id",[id,co.id])).rowCount,404,'Invitation not found');
   await audit(c,actor,'company.invitation_revoked',id);
   return {ok:true};
  });
 },
 /**
  * The company approves its own rider only after the same Ghana Card record an independent rider needs.
  * Customers still see the profile photo and, for motor vehicles, the plate.
  */
 async approveRider(actor,riderId){
  uuid.parse(riderId);
  return db.tx(async c=>{
   const co=await approvedFor(c,actor,'riders');
   const r=(await c.query('SELECT r.id,r.status,r.vehicle,r.display_name FROM riders r WHERE r.id=$1 AND r.company_id=$2 FOR UPDATE',[riderId,co.id])).rows[0];
   check(r,404,'Company rider not found');
   check(r.status==='pending',409,r.status==='approved'?'This rider is already approved':'ELESEND has stopped this rider. Contact ELESEND support');
   check(r.display_name,409,'This rider has not added their name');
   if(r.vehicle!=='bicycle')check(await vehiclePlateFor(c,r.id),409,'This rider has not added their number plate');
   await approveRiderLicence(c,r.id,actor.id);
   await approveRiderDocuments(c,r.id,actor.id,{companyRider:true});
   await approveVehicleRecord(c,r.id,actor.id);
   await c.query("UPDATE riders SET status='approved',verified_by_company_id=$2 WHERE id=$1",[r.id,co.id]);
   await audit(c,actor,'company.rider_approved',r.id);
   await queueNotification(c,{id:`company-approved:${r.id}:${Date.now()}`,recipientId:r.id,kind:'account_approved',payload:{message:`${co.name} has approved you. You can go online in the Rider app.`}});
   return {status:'approved'};
  });
 },
 /** The company compares the photo with the person before approving them. */
 async riderPhoto(actor,riderId){
  uuid.parse(riderId);
  const co=await approvedFor(db,actor,'riders');
  check((await db.query('SELECT 1 FROM riders WHERE id=$1 AND company_id=$2',[riderId,co.id])).rowCount,404,'Company rider not found');
  const imageBase64=await riderPhotoFor(db,riderId,{approvedOnly:false});
  check(imageBase64,404,'This rider has not uploaded a profile photo');
  await audit(db,actor,'company.rider_photo_viewed',riderId);
  return {imageBase64};
 },
 async riderInvitations(actor){
  check(actor.kind==='rider',403);
  return (await db.query(`SELECT i.id,i.expires_at,c.name AS company_name FROM rider_invitations i JOIN companies c ON c.id=i.company_id
    WHERE i.rider_id=$1 AND i.status='pending' AND i.expires_at>now() AND c.status='approved' ORDER BY i.created_at DESC LIMIT 20`,[actor.id])).rows;
 },
 async declineInvitation(actor,id){
  uuid.parse(id);check(actor.kind==='rider',403);
  return db.tx(async c=>{
   check((await c.query("UPDATE rider_invitations SET status='revoked' WHERE id=$1 AND rider_id=$2 AND status='pending' RETURNING id",[id,actor.id])).rowCount,404,'Invitation not found');
   await audit(c,actor,'company.invitation_declined',id);
   return {ok:true};
  });
 }
};}
