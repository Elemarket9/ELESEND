/**
 * No independent rider is approved without identity on file: a Ghana Card for everyone, plus a driver's licence
 * for motor vehicles. Numbers are encrypted, with keyed hashes so one card or licence cannot back two accounts.
 * Riders who work for a rider supply company are checked by that company instead (see company.mjs).
 */
import {createHmac,hkdfSync} from 'node:crypto';
import {requirePermission} from './permissions.mjs';
import {seal,unseal} from './sealed-values.mjs';
import {saveVehiclePlate,vehiclePlateFor} from './vehicle.mjs';
import {z} from 'zod';
import {check} from './security.mjs';
import {identityConfigured,identityProviderFromEnv} from './identity-verification.mjs';

const uuid=z.string().uuid();
/** Works with no extra setting: unless a key is set, a separate key is derived from the required admin key. */
export function riderDataKey(){
 const own=(process.env.RIDER_ID_ENCRYPTION_KEY||'').trim();
 if(own){check(/^[a-fA-F0-9]{64}$/.test(own),503,'RIDER_ID_ENCRYPTION_KEY must be 64 hexadecimal characters');return Buffer.from(own,'hex');}
 const root=(process.env.ADMIN_MFA_ENCRYPTION_KEY||process.env.OTP_KEY||'').trim();
 check(/^[a-fA-F0-9]{64}$/.test(root),503,'Rider data encryption is not configured');
 return Buffer.from(hkdfSync('sha256',Buffer.from(root,'hex'),Buffer.alloc(0),'elesend:rider-data:v1',32));
}
const secretKey=riderDataKey;
const normalize=number=>number.toUpperCase().replace(/[\s/-]/g,'');
const numberHash=number=>createHmac('sha256',secretKey()).update('elesend:rider-licence:'+normalize(number)).digest('hex');
const numberContext=riderId=>'elesend:rider-licence:v1:'+riderId;
const encryptNumber=(number,riderId)=>seal(secretKey(),numberContext(riderId),number);
const decryptNumber=(value,riderId)=>unseal(secretKey(),numberContext(riderId),value).toString('utf8');
// Ghana Card personal ID number: GHA-123456789-0. Spaces and missing hyphens are accepted and tidied.
export function normalizeGhanaCard(value){
 const compact=String(value??'').toUpperCase().replace(/[\s-]/g,'');
 check(/^GHA\d{10}$/.test(compact),400,'Enter your Ghana Card number as shown on the card, like GHA-123456789-0');
 return `GHA-${compact.slice(3,12)}-${compact.slice(12)}`;
}
const cardHash=card=>createHmac('sha256',secretKey()).update('elesend:ghana-card:'+card).digest('hex');
const cardContext=riderId=>'elesend:ghana-card:v1:'+riderId;
const encryptCard=(card,riderId)=>seal(secretKey(),cardContext(riderId),card);
const decryptCard=(value,riderId)=>unseal(secretKey(),cardContext(riderId),value).toString('utf8');
const ghanaToday=()=>new Date().toISOString().slice(0,10);
const schema=z.object({
 legalName:z.string().trim().min(3).max(120),
 ghanaCardNumber:z.string().trim().min(1).max(20),
 licenceNumber:z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 /-]{3,39}$/).optional(),
 licenceClass:z.string().trim().regex(/^[A-Za-z0-9]{1,4}$/).optional(),
 expiresOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 vehiclePlate:z.string().trim().min(3).max(20).optional()
}).strict();

export async function riderLicenceStatus(db,actor){
 check(actor?.kind==='rider',403,'Rider account required');
 if(identityConfigured())await syncIdentityCheck(db,actor.id).catch(()=>{});
 const company=(await db.query('SELECT c.name FROM riders r JOIN companies c ON c.id=r.company_id WHERE r.id=$1',[actor.id])).rows[0];
 const row=(await db.query('SELECT document_type,legal_name,licence_class,expires_on::text AS expires_on,status,rejection_reason,valid_until::text AS valid_until,identity_status,identity_reason,ghana_card_hash IS NOT NULL AS ghana_card_on_file FROM rider_licences WHERE rider_id=$1',[actor.id])).rows[0];
 // Company riders are checked by their company, so ELESEND does not ask them for a Ghana Card or licence.
 if(company&&!row)return {status:'not_required',companyName:company.name,identityAvailable:false};
 if(!row)return {status:'missing',identityAvailable:identityConfigured()};
 return {status:row.status,companyName:company?.name??null,ghanaCardOnFile:row.ghana_card_on_file,identityAvailable:identityConfigured(),identityStatus:row.identity_status,identityReason:row.identity_reason,documentType:row.document_type,legalName:row.legal_name,licenceClass:row.licence_class,expiresOn:row.expires_on,vehiclePlate:await vehiclePlateFor(db,actor.id),rejectionReason:row.rejection_reason,validUntil:row.valid_until};
}
export async function submitRiderLicence(db,actor,input){
 check(actor?.kind==='rider',403,'Rider account required');
 const v=schema.parse(input);
 check(!Number.isNaN(Date.parse(v.expiresOn))&&v.expiresOn>=ghanaToday(),400,'This document has expired');
 return db.tx(async c=>{
  const rider=(await c.query('SELECT vehicle FROM riders WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];
  check(rider,403,'Rider account required');
  const bicycle=rider.vehicle==='bicycle';
  const card=normalizeGhanaCard(v.ghanaCardNumber);
  if(!bicycle){
   check(v.licenceNumber,400,'Driver\'s licence number required');
   check(v.licenceClass,400,'Licence class required');
   // The plate lives only in the vehicle record, so a rider who already gave it is not asked again.
   if(v.vehiclePlate)await saveVehiclePlate(c,actor.id,rider.vehicle,v.vehiclePlate);
   check(await vehiclePlateFor(c,actor.id),400,'Vehicle plate number required');
  }
  // Bicycle riders need no licence, so their Ghana Card is the main document.
  const number=bicycle?card:v.licenceNumber;
  const hash=numberHash(number),ghanaHash=cardHash(card);
  check(!(await c.query('SELECT 1 FROM rider_licences WHERE number_hash=$1 AND rider_id<>$2',[hash,actor.id])).rowCount,409,'This document is already linked to another rider');
  check(!(await c.query('SELECT 1 FROM rider_licences WHERE ghana_card_hash=$1 AND rider_id<>$2',[ghanaHash,actor.id])).rowCount,409,'This Ghana Card is already linked to another rider');
  await c.query(`INSERT INTO rider_licences(rider_id,document_type,legal_name,number_encrypted,number_hash,licence_class,expires_on,ghana_card_encrypted,ghana_card_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(rider_id) DO UPDATE SET document_type=excluded.document_type,legal_name=excluded.legal_name,number_encrypted=excluded.number_encrypted,number_hash=excluded.number_hash,ghana_card_encrypted=excluded.ghana_card_encrypted,ghana_card_hash=excluded.ghana_card_hash,
     licence_class=excluded.licence_class,expires_on=excluded.expires_on,status='pending',rejection_reason=NULL,reviewed_by=NULL,reviewed_at=NULL,submitted_at=now(),identity_session_id=NULL,identity_status='not_started',identity_reason=NULL,identity_checked_at=NULL`,
   [actor.id,bicycle?'ghana_card':'drivers_licence',v.legalName,encryptNumber(number,actor.id),hash,bicycle?null:v.licenceClass??null,v.expiresOn,encryptCard(card,actor.id),ghanaHash]);
  await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'rider.licence_submitted',$1)",[actor.id]);
  return {status:'pending'};
 });
}
const profileSchema=z.object({displayName:z.string().trim().min(2).max(60).optional(),vehiclePlate:z.string().trim().min(3).max(20).optional()}).strict();
/** Name customers see and the plate they check at the door. A plate is fixed once approved, so it cannot be swapped quietly. */
export async function saveRiderProfile(db,actor,input){
 check(actor?.kind==='rider',403,'Rider account required');
 const v=profileSchema.parse(input);
 return db.tx(async c=>{
  const rider=(await c.query('SELECT vehicle,status FROM riders WHERE id=$1 FOR UPDATE',[actor.id])).rows[0];
  check(rider,403,'Rider account required');
  if(v.displayName)await c.query('UPDATE riders SET display_name=$2 WHERE id=$1',[actor.id,v.displayName]);
  if(v.vehiclePlate){
   check(rider.vehicle!=='bicycle',400,'Bicycles have no number plate');
   const current=await vehiclePlateFor(c,actor.id),next=v.vehiclePlate.toUpperCase().replace(/\s+/g,' ').trim();
   check(rider.status!=='approved'||current===next,409,'Your plate is already approved. Ask ELESEND support or your company to change it');
   await saveVehiclePlate(c,actor.id,rider.vehicle,v.vehiclePlate);
  }
  await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'rider.profile_saved',$1)",[actor.id]);
  const row=(await c.query('SELECT display_name FROM riders WHERE id=$1',[actor.id])).rows[0];
  return {displayName:row.display_name,vehiclePlate:await vehiclePlateFor(c,actor.id)};
 });
}
/** Called inside rider approval: the approval fails unless a current document is on file. */
export async function approveRiderLicence(c,riderId,reviewerId){
 const row=(await c.query('SELECT status,expires_on::text AS expires_on,identity_status,ghana_card_hash FROM rider_licences WHERE rider_id=$1 FOR UPDATE',[riderId])).rows[0];
 check(row,409,'This rider has not submitted a licence');
 check(row.ghana_card_hash,409,'This rider has not given their Ghana Card number');
 check(row.status!=='rejected',409,'This rider\'s licence was rejected. They must submit it again');
 check(row.expires_on>=ghanaToday(),409,'This rider\'s licence has expired');
 // Without a provider, staff check the licence photo uploaded with the rider's documents.
 if(identityConfigured())check(row.identity_status==='approved',409,'This rider has not passed the photo and selfie check');
 await c.query("UPDATE rider_licences SET status='approved',valid_until=expires_on,reviewed_by=$2,reviewed_at=now() WHERE rider_id=$1",[riderId,reviewerId]);
}
export async function rejectRiderLicence(db,actor,riderId,input){
 uuid.parse(riderId);
 const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).strict().parse(input);
 return db.tx(async c=>{
  await requirePermission(c,actor,'verification:write');
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
 const licences=(await db.query('SELECT l.rider_id,l.document_type,l.legal_name,l.number_encrypted,l.ghana_card_encrypted,l.licence_class,l.expires_on::text AS expires_on,v.registration_plate AS vehicle_plate,l.status,l.rejection_reason,l.identity_status,l.identity_reason FROM rider_licences l LEFT JOIN rider_vehicle_registrations v ON v.rider_id=l.rider_id WHERE l.rider_id=ANY($1::uuid[])',[ids])).rows;
 const byRider=new Map(licences.map(l=>[l.rider_id,l]));
 await db.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'rider.licence_numbers_viewed',$1)",[actor.id]);
 return rows.map(r=>{
  const l=byRider.get(r[idField]);
  if(!l)return {...r,licence:null};
  const {number_encrypted,ghana_card_encrypted,...visible}=l;
  return {...r,licence:{...visible,number:decryptNumber(number_encrypted,l.rider_id),ghanaCard:ghana_card_encrypted?decryptCard(ghana_card_encrypted,l.rider_id):null}};
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
export async function requireIdentityRefresh(db,{everyDays=Number(process.env.RIDER_REVERIFY_DAYS)||90,graceDays=Number(process.env.RIDER_REVERIFY_GRACE_DAYS)||7}={}){
 if(!identityConfigured())return {requested:0,suspended:0};
 const requested=await db.query(`UPDATE rider_licences l SET identity_status='not_started',identity_session_id=NULL,reverify_due_at=now()+make_interval(days=>$2)
   FROM riders r WHERE r.id=l.rider_id AND r.status='approved' AND l.identity_status='approved' AND l.identity_checked_at<now()-make_interval(days=>$1) RETURNING l.rider_id`,[everyDays,graceDays]);
 const suspended=(await db.query(`UPDATE riders r SET status='suspended',online=false FROM rider_licences l
   WHERE l.rider_id=r.id AND r.status='approved' AND l.reverify_due_at<now() AND l.identity_status<>'approved' RETURNING r.id`)).rows;
 for(const {id} of suspended)await db.query("INSERT INTO audit_logs(action,entity_id) VALUES('rider.identity_refresh_suspended',$1)",[id]);
 return {requested:requested.rowCount,suspended:suspended.length};
}
