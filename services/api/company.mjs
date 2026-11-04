import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check,hash,newToken,phone as normalPhone} from './security.mjs';
import {companyBalance} from './modules/payments/index.mjs';
import {queueNotification} from './notifications.mjs';

const uuid=z.string().uuid();
const SERVICES=['delivery','riders'];
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
export const ACCEPTED_SERVICES=SERVICES;
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
   const rider=(await c.query("SELECT r.id FROM riders r JOIN users u ON u.id=r.id WHERE u.phone=$1 AND r.status='approved' AND r.company_id IS NULL FOR UPDATE OF r",[phone])).rows[0];
   if(!rider)return;
   const open=(await c.query("UPDATE rider_invitations SET expires_at=now()+interval '48 hours' WHERE company_id=$1 AND rider_id=$2 AND status='pending' RETURNING id",[co.id,rider.id])).rows[0];
   if(open)return;
   const id=randomUUID();
   // The rider accepts in the app, so this random value is never given to anyone.
   await c.query("INSERT INTO rider_invitations(id,company_id,rider_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '48 hours')",[id,co.id,rider.id,hash(newToken())]);
   await audit(c,actor,'company.rider_invited',rider.id);
   await queueNotification(c,{id:`company-invite:${id}`,recipientId:rider.id,kind:'company_invitation',payload:{invitationId:id,message:`${co.name} has invited you to ride for them. Open the Rider app to answer.`}});
  });
  return {ok:true,message:'If this number belongs to an approved independent rider, they will see your invitation in their app for 48 hours.'};
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
