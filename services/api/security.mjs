import {randomBytes,scrypt as scryptCallback,timingSafeEqual,createHash,createHmac,randomInt} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCallback);
export const hash=v=>createHash('sha256').update(v).digest('hex');
export function fail(status,message){throw Object.assign(Error(message),{status});}
export function check(ok,status=409,message='Operation not permitted'){if(!ok)fail(status,message);}
export function phone(v){const s=String(v).replace(/[\s()-]/g,'');const p=s.startsWith('0')?'+233'+s.slice(1):s;check(/^\+233[25]\d{8}$/.test(p),400,'Valid Ghana phone required');return p;}
export async function passwordHash(password){const salt=randomBytes(16).toString('hex');return salt+':'+Buffer.from(await scrypt(password,salt,64)).toString('hex');}
export async function passwordMatches(password,stored){
 if(!stored||typeof stored!=='string'||!stored.includes(':'))return false;
 const [salt,digest]=stored.split(':');
 if(!salt||!digest||digest.length!==128)return false;
 try{
  const derived=Buffer.from(await scrypt(password,salt,64));
  return timingSafeEqual(derived,Buffer.from(digest,'hex'));
 }catch{return false;}
}
export const newToken=()=>randomBytes(32).toString('hex');
export const newCode=()=>randomInt(0,1000000).toString().padStart(6,'0');
export function mac(secret,fields){return createHmac('sha256',Buffer.from(secret,'hex')).update(JSON.stringify(fields)).digest('hex');}
export function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export async function recordAttempt(db,subject,seconds){
 const r=await db.query(`INSERT INTO rate_limits(subject,count,expires_at) VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(subject) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<=now() THEN 1 ELSE rate_limits.count+1 END,expires_at=CASE WHEN rate_limits.expires_at<=now() THEN excluded.expires_at ELSE rate_limits.expires_at END RETURNING count`,[subject,seconds]);
 return r.rows[0].count;
}
export async function limit(db,subject,max,seconds){check(await recordAttempt(db,subject,seconds)<=max,429,'Too many requests');}
/** Refuses once a counter has reached max, without adding to it. Pair with recordAttempt to count only some outcomes. */
export async function assertUnderLimit(db,subject,max){
 const r=await db.query('SELECT count FROM rate_limits WHERE subject=$1 AND expires_at>now()',[subject]);
 check((r.rows[0]?.count??0)<max,429,'Too many requests');
}
