import {randomBytes,scrypt as scryptCallback,timingSafeEqual,createHash,createHmac,randomInt} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCallback);
export const hash=v=>createHash('sha256').update(v).digest('hex');
export function fail(status,message){throw Object.assign(Error(message),{status});}
export function check(ok,status=409,message='Operation not permitted'){if(!ok)fail(status,message);}
export function phone(v){const s=String(v).replace(/[\s()-]/g,'');const p=s.startsWith('0')?'+233'+s.slice(1):s;check(/^\+233[25]\d{8}$/.test(p),400,'Valid Ghana phone required');return p;}
// OWASP's listed scrypt setting for this memory budget. Older hashes are replaced at the next sign-in.
const SCRYPT={N:32768,r:8,p:3,maxmem:64*1024*1024};
const CURRENT_PREFIX='v2$';
export const UNKNOWN_ACCOUNT_HASH=CURRENT_PREFIX+'0'.repeat(32)+':'+'0'.repeat(128);
export const passwordNeedsUpgrade=stored=>typeof stored==='string'&&stored.includes(':')&&!stored.startsWith(CURRENT_PREFIX);
export async function passwordHash(password){const salt=randomBytes(16).toString('hex');return CURRENT_PREFIX+salt+':'+Buffer.from(await scrypt(password,salt,64,SCRYPT)).toString('hex');}
export async function passwordMatches(password,stored){
 if(!stored||typeof stored!=='string'||!stored.includes(':'))return false;
 const current=stored.startsWith(CURRENT_PREFIX);
 const [salt,digest]=(current?stored.slice(CURRENT_PREFIX.length):stored).split(':');
 if(!salt||!digest||digest.length!==128)return false;
 try{
  const derived=Buffer.from(await (current?scrypt(password,salt,64,SCRYPT):scrypt(password,salt,64)));
  return timingSafeEqual(derived,Buffer.from(digest,'hex'));
 }catch{return false;}
}
const COMMON_WORDS=new Set(['password','passwords','passw','qwerty','qwertyuiop','asdfgh','asdfghjkl','zxcvbn','abc','abcd','abcdef','abcdefgh','abcdefghijkl','letmein','welcome','iloveyou','admin','administrator','login','master','monkey','dragon','football','sunshine','princess','trustno','elesend','rider','customer','restaurant','company','ghana','accra','kumasi','changeme','secret','test','testing','user','default']);
/** Refuses passwords that are widely used or easy to work out, without adding other composition rules. */
export function assertAcceptablePassword(password,{phone:ownPhone}={}){
 const lower=String(password).toLowerCase();
 const refuse=()=>check(false,400,'Choose a less common password. A few unrelated words work well.');
 if(new Set(lower).size<5)refuse();
 const digits=lower.replace(/\D/g,'');
 if(digits.length===lower.length)refuse();
 if(ownPhone){const local=String(ownPhone).replace(/\D/g,'').slice(-9);if(local&&digits.includes(local))refuse();}
 // Compares the word itself, once any repeats, a number or symbols at the end, and look-alike characters are removed.
 const plain=value=>{const letters=value.replace(/[^a-z]/g,'');return /^(.+?)\1+$/.exec(letters)?.[1]??letters;};
 const core=lower.replace(/[\d\W_]+$/,'');
 const lookalike=core.replace(/[@4]/g,'a').replace(/3/g,'e').replace(/[1!]/g,'i').replace(/0/g,'o').replace(/[$5]/g,'s');
 if([plain(lower),plain(core),plain(lookalike)].some(word=>COMMON_WORDS.has(word)))refuse();
}
/** One line for each security-relevant refusal, for log monitoring. Holds no credentials or personal data. */
export function securityEvent(type,fields={}){process.stderr.write(JSON.stringify({level:'security',type,at:new Date().toISOString(),...fields})+'\n');}
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
