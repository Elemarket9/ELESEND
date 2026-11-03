/**
 * No rider is approved without identity on file: a driver's licence for motor vehicles, or a Ghana Card for
 * bicycles. The document number is encrypted, with a keyed hash so one licence cannot back two accounts.
 */
import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';
import {identityConfigured,identityProviderFromEnv} from './identity-verification.mjs';

const uuid=z.string().uuid();
function secretKey(){
 const value=process.env.RIDER_ID_ENCRYPTION_KEY||'';
 check(/^[a-fA-F0-9]{64}$/.test(value),503,'RIDER_ID_ENCRYPTION_KEY must be 64 hexadecimal characters');
 return Buffer.from(value,'hex');
}
const normalize=number=>number.toUpperCase().replace(/[\s/-]/g,'');
const numberHash=number=>createHmac('sha256',secretKey()).update('elesend:rider-licence:'+normalize(number)).digest('hex');
function encryptNumber(number,riderId){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secretKey(),iv);
 cipher.setAAD(Buffer.from('elesend:rider-licence:v1:'+riderId));
 const data=Buffer.concat([cipher.update(number,'utf8'),cipher.final()]);
 return ['v1',iv.toString('base64url'),data.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
}
function decryptNumber(value,riderId){
 const [,iv,data,tag]=value.split('.');
 const decipher=createDecipheriv('aes-256-gcm',secretKey(),Buffer.from(iv,'base64url'));
 decipher.setAAD(Buffer.from('elesend:rider-licence:v1:'+riderId));
 decipher.setAuthTag(Buffer.from(tag,'base64url'));
 return Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8');
}
const ghanaToday=()=>new Date().toISOString().slice(0,10);
const schema=z.object({
 legalName:z.string().trim().min(3).max(120),
 licenceNumber:z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 /-]{3,39}$/),
 licenceClass:z.string().trim().regex(/^[A-Za-z0-9]{1,4}$/).optional(),
 expiresOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 vehiclePlate:z.string().trim().min(3).max(20).optional()
}).strict();

export async function riderLicenceStatus(db,actor){
 check(actor?.kind==='rider',403,'Rider account required');
 if(identityConfigured())await syncIdentityCheck(db,actor.id).catch(()=>{});
 const row=(await db.query('SELECT document_type,legal_name,licence_class,expires_on::text AS expires_on,vehicle_plate,status,rejection_reason,valid_until::text AS valid_until,identity_status,identity_reason FROM rider_licences WHERE rider_id=$1',[actor.id])).rows[0];
 if(!row)return {status:'missing'};
 return {status:row.status,identityStatus:row.identity_status,identityReason:row.identity_reason,documentType:row.document_type,legalName:row.legal_name,licenceClass:row.licence_class,expiresOn:row.expires_on,vehiclePlate:row.vehicle_plate,rejectionReason:row.rejection_reason,validUntil:row.valid_until};
}
export async function submitRiderLicence(db,actor,input){
 check(actor?.kind==='rider',403,'Rider account required');
 const v=schema.parse(input);
 check(!Number.isNaN(Date.parse(v.expiresOn))&&v.expiresOn>=ghanaToday(),400,'This document has expired');
 return db.tx(async c=>{
  const rider=(await c.query('SELECT vehicle FROM riders WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];
  check(rider,403,'Rider account required');
  const bicycle=rider.vehicle==='bicycle';
  if(!bicycle){check(v.licenceClass,400,'Licence class required');check(v.vehiclePlate,400,'Vehicle plate number required');}
  const hash=numberHash(v.licenceNumber);
  check(!(await c.query('SELECT 1 FROM rider_licences WHERE number_hash=$1 AND rider_id<>$2',[hash,actor.id])).rowCount,409,'This document is already linked to another rider');
  await c.query(`INSERT INTO rider_licences(rider_id,document_type,legal_name,number_encrypted,number_hash,licence_class,expires_on,vehicle_plate)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(rider_id) DO UPDATE SET document_type=excluded.document_type,legal_name=excluded.legal_name,number_encrypted=excluded.number_encrypted,number_hash=excluded.number_hash,
     licence_class=excluded.licence_class,expires_on=excluded.expires_on,vehicle_plate=excluded.vehicle_plate,status='pending',rejection_reason=NULL,reviewed_by=NULL,reviewed_at=NULL,submitted_at=now(),identity_session_id=NULL,identity_status='not_started',identity_reason=NULL,identity_checked_at=NULL`,
   [actor.id,bicycle?'ghana_card':'drivers_licence',v.legalName,encryptNumber(v.licenceNumber,actor.id),hash,v.licenceClass??null,v.expiresOn,v.vehiclePlate??null]);
  await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'rider.licence_submitted',$1)",[actor.id]);
  return {status:'pending'};
 });
}
/** Called inside rider approval: the approval fails unless a current document is on file. */
export async function approveRiderLicence(c,riderId,reviewerId){
 const row=(await c.query('SELECT status,expires_on::text AS expires_on,identity_status FROM rider_licences WHERE rider_id=$1 FOR UPDATE',[riderId])).rows[0];
 check(row,409,'This rider has not submitted a licence');
 check(row.status!=='rejected',409,'This rider\'s licence was rejected. They must submit it again');
 check(row.expires_on>=ghanaToday(),409,'This rider\'s licence has expired');
 if(identityConfigured()||process.env.NODE_ENV==='production')check(row.identity_status==='approved',409,'This rider has not passed the photo and selfie check');
 await c.query("UPDATE rider_licences SET status='approved',valid_until=expires_on,reviewed_by=$2,reviewed_at=now() WHERE rider_id=$1",[riderId,reviewerId]);
}
export async function rejectRiderLicence(db,actor,riderId,input){
 uuid.parse(riderId);
 const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).strict().parse(input);
 return db.tx(async c=>{
  check(actor?.kind==='admin'&&(await c.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission='verification:write'",[actor.id])).rowCount,403,'Permission required');
  const updated=await c.query("UPDATE rider_licences SET status='rejected',rejection_reason=$2,reviewed_by=$3,reviewed_at=now(),valid_until=NULL WHERE rider_id=$1 RETURNING rider_id",[riderId,reason,actor.id]);
  check(updated.rowCount,404,'Licence not found');
  await c.query("UPDATE riders SET status='pending',online=false WHERE id=$1 AND status='approved'",[riderId]);
  await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'rider.licence_rejected',$2)",[actor.id,riderId]);
  return {status:'rejected'};
 });
}
/** Riders whose approved document has run out stop working until a new one is approved. */
export async function suspendExpiredLicences(db){
 const rows=(await db.query(`UPDATE riders r SET status='suspended',online=false FROM rider_licences l
   WHERE l.rider_id=r.id AND r.status='approved' AND l.valid_until<(now() AT TIME ZONE 'UTC')::date RETURNING r.id`)).rows;
 for(const {id} of rows)await db.query("INSERT INTO audit_logs(action,entity_id) VALUES('rider.licence_expired_suspended',$1)",[id]);
 return rows.map(r=>r.id);
}
/** For screens already restricted to verification staff. Reading a full number is audited. */
export async function attachLicences(db,actor,rows,idField='id'){
 const ids=rows.map(r=>r[idField]).filter(Boolean);
 if(!ids.length)return rows;
 const licences=(await db.query('SELECT rider_id,document_type,legal_name,number_encrypted,licence_class,expires_on::text AS expires_on,vehicle_plate,status,rejection_reason,identity_status,identity_reason FROM rider_licences WHERE rider_id=ANY($1::uuid[])',[ids])).rows;
 const byRider=new Map(licences.map(l=>[l.rider_id,l]));
 await db.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'rider.licence_numbers_viewed',$1)",[actor.id]);
 return rows.map(r=>{
  const l=byRider.get(r[idField]);
  if(!l)return {...r,licence:null};
  const {number_encrypted,...visible}=l;
  return {...r,licence:{...visible,number:decryptNumber(number_encrypted,l.rider_id)}};
 });
}

/** Sends the rider to the provider's secure page to photograph the document and take a selfie. */
export async function startIdentityCheck(db,actor,{provider=identityProviderFromEnv()}={}){
 check(actor?.kind==='rider',403,'Rider account required');
 const row=(await db.query('SELECT identity_status FROM rider_licences WHERE rider_id=$1',[actor.id])).rows[0];
 check(row,409,'Enter your licence details first');
 check(row.identity_status!=='approved',409,'Your identity check is already approved');
 const session=await provider.createSession({riderId:actor.id});
 await db.query("UPDATE rider_licences SET identity_session_id=$2,identity_status='in_progress',identity_reason=NULL WHERE rider_id=$1",[actor.id,session.sessionId]);
 return {url:session.url};
}
const compact=value=>String(value??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const approved=value=>String(value??'').toLowerCase()==='approved';
/** Every result must pass, and the photographed document must match what the rider entered. */
function evaluateDecision(decision,licence){
 const status=decision?.status;
 if(['Declined','Expired','Kyc Expired','Abandoned'].includes(status))return {status:'failed',reason:'The check was '+String(status).toLowerCase()+'. Please try again'};
 if(status!=='Approved')return {status:'in_progress'};
 const id=decision.id_verifications?.[0];
 if(!id||!approved(id.status))return {status:'failed',reason:'The document was not accepted'};
 if(!decision.liveness_checks?.length||!decision.liveness_checks.every(x=>approved(x.status)))return {status:'failed',reason:'The live selfie check was not passed'};
 if(!decision.face_matches?.length||!decision.face_matches.every(x=>approved(x.status)))return {status:'failed',reason:'The selfie did not match the document'};
 if(compact(id.document_number)!==compact(licence.number))return {status:'failed',reason:'The number on the document does not match the number you entered'};
 const type=String(id.document_type??'').toLowerCase();
 if(licence.document_type==='drivers_licence'&&!/driv/.test(type))return {status:'failed',reason:'A driver\'s licence is required'};
 if(id.expiration_date&&id.expiration_date<ghanaToday())return {status:'failed',reason:'The document has expired'};
 return {status:'approved',expiresOn:/^\d{4}-\d{2}-\d{2}$/.test(id.expiration_date??'')?id.expiration_date:null};
}
export async function syncIdentityCheck(db,riderId,{provider=identityProviderFromEnv()}={}){
 const row=(await db.query("SELECT identity_session_id FROM rider_licences WHERE rider_id=$1 AND identity_status='in_progress'",[riderId])).rows[0];
 if(!row?.identity_session_id)return null;
 const decision=await provider.getDecision(row.identity_session_id);
 check(decision?.vendor_data===riderId&&decision?.session_id===row.identity_session_id,409,'Identity result does not belong to this rider');
 return db.tx(async c=>{
  const licence=(await c.query("SELECT document_type,number_encrypted,identity_session_id,identity_status FROM rider_licences WHERE rider_id=$1 FOR UPDATE",[riderId])).rows[0];
  if(licence?.identity_status!=='in_progress'||licence.identity_session_id!==row.identity_session_id)return null;
  const result=evaluateDecision(decision,{document_type:licence.document_type,number:decryptNumber(licence.number_encrypted,riderId)});
  await c.query('UPDATE rider_licences SET identity_status=$2,identity_reason=$3,identity_checked_at=now(),expires_on=coalesce($4::date,expires_on),reverify_due_at=CASE WHEN $2=\'approved\' THEN NULL ELSE reverify_due_at END WHERE rider_id=$1',[riderId,result.status,result.reason??null,result.expiresOn??null]);
  if(result.status!=='in_progress')await c.query('INSERT INTO audit_logs(action,entity_id) VALUES($1,$2)',['rider.identity_'+result.status,riderId]);
  return result;
 });
}
export async function identityWebhook(db,rawBody,headers,{provider=identityProviderFromEnv()}={}){
 provider.verifyWebhook(rawBody,headers);
 let event;try{event=JSON.parse(rawBody.toString('utf8'));}catch{check(false,400,'Invalid identity event');}
 const row=(await db.query('SELECT rider_id FROM rider_licences WHERE identity_session_id::text=$1',[String(event?.session_id??'')])).rows[0];
 if(row)await syncIdentityCheck(db,row.rider_id,{provider});
 return {status:'acknowledged'};
}
/** Webhooks can be missed, so unfinished checks are also read back on a schedule. */
export async function syncOpenIdentityChecks(db,{limit=50}={}){
 if(!identityConfigured())return 0;
 const rows=(await db.query("SELECT rider_id FROM rider_licences WHERE identity_status='in_progress' ORDER BY identity_checked_at NULLS FIRST LIMIT $1",[limit])).rows;
 for(const {rider_id:riderId} of rows){
  await syncIdentityCheck(db,riderId).catch(()=>{});
  await db.query("UPDATE rider_licences SET identity_checked_at=now() WHERE rider_id=$1 AND identity_status='in_progress'",[riderId]);
 }
 return rows.length;
}

/** Riders repeat the selfie check regularly, so an account cannot be handed to someone else. */
export async function requireIdentityRefresh(db,{everyDays=Number(process.env.RIDER_REVERIFY_DAYS)||90,graceDays=7}={}){
 if(!identityConfigured())return {requested:0,suspended:0};
 const requested=await db.query(`UPDATE rider_licences l SET identity_status='not_started',identity_session_id=NULL,reverify_due_at=now()+make_interval(days=>$2)
   FROM riders r WHERE r.id=l.rider_id AND r.status='approved' AND l.identity_status='approved' AND l.identity_checked_at<now()-make_interval(days=>$1) RETURNING l.rider_id`,[everyDays,graceDays]);
 const suspended=(await db.query(`UPDATE riders r SET status='suspended',online=false FROM rider_licences l
   WHERE l.rider_id=r.id AND r.status='approved' AND l.reverify_due_at<now() AND l.identity_status<>'approved' RETURNING r.id`)).rows;
 for(const {id} of suspended)await db.query("INSERT INTO audit_logs(action,entity_id) VALUES('rider.identity_refresh_suspended',$1)",[id]);
 return {requested:requested.rowCount,suspended:suspended.length};
}
