/**
 * Profile photo, insurance and roadworthiness, as Bolt asks of drivers in Ghana. The rider uploads through a
 * short-lived link opened in the phone browser. Images are encrypted, so a database copy alone cannot show them.
 */
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';
import {identityConfigured} from './identity-verification.mjs';
import {riderDataKey} from './rider-licence.mjs';

const KINDS=['profile_photo','licence_photo','insurance','roadworthiness'];
const EXPIRING=['insurance','roadworthiness'];
const MAX_BYTES=2*1024*1024;
const today=()=>new Date().toISOString().slice(0,10);
const hashToken=token=>createHash('sha256').update(token).digest('hex');
const key=riderDataKey;
function encryptImage(image,riderId,kind){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);
 cipher.setAAD(Buffer.from(`elesend:rider-document:v1:${riderId}:${kind}`));
 const data=Buffer.concat([cipher.update(image),cipher.final()]);
 return ['v1',iv.toString('base64url'),data.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
}
function decryptImage(value,riderId,kind){
 const [,iv,data,tag]=value.split('.');
 const decipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64url'));
 decipher.setAAD(Buffer.from(`elesend:rider-document:v1:${riderId}:${kind}`));
 decipher.setAuthTag(Buffer.from(tag,'base64url'));
 return Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]);
}
async function requireVerifier(c,actor){
 check(actor?.kind==='admin'&&(await c.query("SELECT 1 FROM permissions WHERE user_id=$1 AND permission='verification:write'",[actor.id])).rowCount,403,'Permission required');
}
// The identity provider photographs the licence when it is on. Otherwise staff review a photo here.
const requiredKinds=vehicle=>KINDS.filter(kind=>(!EXPIRING.includes(kind)||vehicle!=='bicycle')&&(kind!=='licence_photo'||!identityConfigured()));

export async function createDocumentUploadLink(db,actor){
 check(actor?.kind==='rider',403,'Rider account required');
 const token=randomBytes(32).toString('hex');
 await db.query('DELETE FROM rider_document_links WHERE rider_id=$1 OR expires_at<now()',[actor.id]);
 await db.query("INSERT INTO rider_document_links(token_hash,rider_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')",[hashToken(token),actor.id]);
 // The token sits in the fragment, which browsers never send to servers or put in logs.
 return {path:'/rider-documents#'+token,expiresInSeconds:1800};
}
const uploadSchema=z.object({
 token:z.string().regex(/^[0-9a-f]{64}$/),
 kind:z.enum(KINDS),
 expiresOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
 imageBase64:z.string().min(100).max(3*1024*1024)
}).strict();
export async function uploadRiderDocument(db,input){
 const v=uploadSchema.parse(input);
 const link=(await db.query('SELECT rider_id FROM rider_document_links WHERE token_hash=$1 AND expires_at>now()',[hashToken(v.token)])).rows[0];
 check(link,403,'This link has expired. Open it again from the rider app');
 const image=Buffer.from(v.imageBase64,'base64');
 check(image.length<=MAX_BYTES,413,'This photo is too large');
 check(image[0]===0xff&&image[1]===0xd8&&image[2]===0xff,400,'Please upload a photo');
 if(EXPIRING.includes(v.kind))check(v.expiresOn&&!Number.isNaN(Date.parse(v.expiresOn))&&v.expiresOn>=today(),400,'Enter a valid expiry date for this document');
 await db.query(`INSERT INTO rider_documents(rider_id,kind,data_encrypted,byte_size,expires_on) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(rider_id,kind) DO UPDATE SET data_encrypted=excluded.data_encrypted,byte_size=excluded.byte_size,expires_on=excluded.expires_on,status='pending',rejection_reason=NULL,valid_until=NULL,reviewed_by=NULL,reviewed_at=NULL,uploaded_at=now()`,
  [link.rider_id,v.kind,encryptImage(image,link.rider_id,v.kind),image.length,EXPIRING.includes(v.kind)?v.expiresOn:null]);
 await db.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$1)',[link.rider_id,'rider.document_uploaded:'+v.kind]);
 return {status:'pending',kind:v.kind};
}
export async function riderDocumentStatus(db,actor){
 check(actor?.kind==='rider',403,'Rider account required');
 const rider=(await db.query('SELECT vehicle FROM riders WHERE id=$1',[actor.id])).rows[0];
 check(rider,403,'Rider account required');
 const rows=(await db.query('SELECT kind,status,expires_on::text AS expires_on,rejection_reason FROM rider_documents WHERE rider_id=$1',[actor.id])).rows;
 return {documents:requiredKinds(rider.vehicle).map(kind=>{const d=rows.find(r=>r.kind===kind);return {kind,status:d?.status??'missing',expiresOn:d?.expires_on??null,rejectionReason:d?.rejection_reason??null};})};
}
/** Called inside rider approval, alongside the licence check. */
export async function approveRiderDocuments(c,riderId,reviewerId){
 const rider=(await c.query('SELECT vehicle FROM riders WHERE id=$1',[riderId])).rows[0];
 check(rider,404,'Rider not found');
 const rows=(await c.query('SELECT kind,status,expires_on::text AS expires_on FROM rider_documents WHERE rider_id=$1 FOR UPDATE',[riderId])).rows;
 for(const kind of requiredKinds(rider.vehicle)){
  const d=rows.find(r=>r.kind===kind),label=kind.replace('_',' ');
  check(d,409,`This rider has not uploaded their ${label}`);
  check(d.status!=='rejected',409,`This rider's ${label} was rejected. They must upload it again`);
  check(!d.expires_on||d.expires_on>=today(),409,`This rider's ${label} has expired`);
 }
 await c.query("UPDATE rider_documents SET status='approved',valid_until=expires_on,reviewed_by=$2,reviewed_at=now() WHERE rider_id=$1",[riderId,reviewerId]);
}
export async function rejectRiderDocument(db,actor,riderId,kind,input){
 z.string().uuid().parse(riderId);z.enum(KINDS).parse(kind);
 const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).strict().parse(input);
 return db.tx(async c=>{
  await requireVerifier(c,actor);
  const updated=await c.query("UPDATE rider_documents SET status='rejected',rejection_reason=$3,valid_until=NULL,reviewed_by=$4,reviewed_at=now() WHERE rider_id=$1 AND kind=$2 RETURNING kind",[riderId,kind,reason,actor.id]);
  check(updated.rowCount,404,'Document not found');
  await c.query("UPDATE riders SET status='pending',online=false WHERE id=$1 AND status='approved'",[riderId]);
  await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'rider.document_rejected:'+kind,riderId]);
  return {status:'rejected'};
 });
}
export async function viewRiderDocument(db,actor,riderId,kind){
 z.string().uuid().parse(riderId);z.enum(KINDS).parse(kind);
 return db.tx(async c=>{
  await requireVerifier(c,actor);
  const d=(await c.query('SELECT data_encrypted,expires_on::text AS expires_on,status FROM rider_documents WHERE rider_id=$1 AND kind=$2',[riderId,kind])).rows[0];
  check(d,404,'Document not found');
  await c.query('INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,$2,$3)',[actor.id,'rider.document_viewed:'+kind,riderId]);
  return {kind,status:d.status,expiresOn:d.expires_on,imageBase64:decryptImage(d.data_encrypted,riderId,kind).toString('base64')};
 });
}
export async function attachDocumentStatuses(db,rows){
 const ids=rows.map(r=>r.id);
 if(!ids.length)return rows;
 const docs=(await db.query('SELECT rider_id,kind,status,expires_on::text AS expires_on FROM rider_documents WHERE rider_id=ANY($1::uuid[])',[ids])).rows;
 return rows.map(r=>({...r,documents:docs.filter(d=>d.rider_id===r.id)}));
}
export async function suspendExpiredDocuments(db){
 const rows=(await db.query(`UPDATE riders r SET status='suspended',online=false FROM rider_documents d
   WHERE d.rider_id=r.id AND r.status='approved' AND d.valid_until<(now() AT TIME ZONE 'UTC')::date RETURNING r.id,d.kind`)).rows;
 for(const {id,kind} of rows)await db.query('INSERT INTO audit_logs(action,entity_id) VALUES($1,$2)',['rider.document_expired_suspended:'+kind,id]);
 return rows.map(r=>r.id);
}
export function renderDocumentUploadPage({includeLicencePhoto=!identityConfigured()}={}){
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rider Documents</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#f8fafc;color:#0f172a}section{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:14px}h1{font-size:20px}h2{font-size:16px;margin:0 0 8px}label{display:block;font-size:14px;margin:10px 0 4px}input{font-size:16px;width:100%;box-sizing:border-box}button{margin-top:12px;width:100%;padding:12px;font-size:16px;font-weight:700;border:0;border-radius:8px;background:#0f172a;color:#fff}p.s{font-size:14px;margin:8px 0 0}</style></head><body>
<h1>Rider documents</h1><p>Take clear photos where all the writing can be read.</p><div id="forms"></div>
<script>
var token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
var docs=[['profile_photo','Profile photo','user',false],${includeLicencePhoto?"['licence_photo','Licence or Ghana Card photo','environment',false],":''}['insurance','Insurance certificate','environment',true],['roadworthiness','Roadworthiness certificate','environment',true]];
function shrink(file){return new Promise(function(ok,no){var r=new FileReader();r.onerror=no;r.onload=function(){var i=new Image();i.onerror=no;i.onload=function(){var s=Math.min(1,1600/Math.max(i.width,i.height));var c=document.createElement('canvas');c.width=Math.round(i.width*s);c.height=Math.round(i.height*s);c.getContext('2d').drawImage(i,0,0,c.width,c.height);ok(c.toDataURL('image/jpeg',0.8).split(',')[1]);};i.src=r.result;};r.readAsDataURL(file);});}
docs.forEach(function(d){var f=document.createElement('section');var h=document.createElement('h2');h.textContent=d[1];f.appendChild(h);
var inp=document.createElement('input');inp.type='file';inp.accept='image/*';inp.setAttribute('capture',d[2]);f.appendChild(inp);var date;
if(d[3]){var l=document.createElement('label');l.textContent='Expiry date';f.appendChild(l);date=document.createElement('input');date.type='date';f.appendChild(date);}
var b=document.createElement('button');b.type='button';b.textContent='Upload';f.appendChild(b);var s=document.createElement('p');s.className='s';f.appendChild(s);
b.onclick=function(){if(!inp.files[0]){s.textContent='Choose a photo first.';return;}if(d[3]&&!date.value){s.textContent='Enter the expiry date.';return;}b.disabled=true;s.textContent='Uploading...';
shrink(inp.files[0]).then(function(image){var body={token:token,kind:d[0],imageBase64:image};if(d[3])body.expiresOn=date.value;return fetch('/api/v1/rider-documents/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}).then(function(res){return res.json().then(function(j){s.textContent=res.ok?'Uploaded. Waiting for review.':(j.error||j.message||'Upload failed.');});}).catch(function(){s.textContent='Upload failed. Check your connection and try again.';}).finally(function(){b.disabled=false;});};
document.getElementById('forms').appendChild(f);});
</script></body></html>`;
}
