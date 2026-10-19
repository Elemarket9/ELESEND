/** RFC 6238 six-digit TOTP for privileged mobile sign-in.
 * Keys are encrypted at rest with a dedicated deployment secret. This is NOT
 * phishing-resistant MFA; device-bound passkeys should be assessed later.
 */
import {createCipheriv,createDecipheriv,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {check} from './security.mjs';
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function decodeBase32(value){
 check(typeof value==='string'&&/^[A-Z2-7]{32,128}$/.test(value),400,'Authenticator secret must be unpadded base32');
 let bits=0,acc=0;const out=[];
 for(const c of value){acc=(acc<<5)|alphabet.indexOf(c);bits+=5;
  if(bits>=8){bits-=8;out.push((acc>>>bits)&255);acc&=(1<<bits)-1;}}
 check(out.length>=20&&out.length<=80,400,'Authenticator secret length must be >=160 bits');
 return Buffer.from(out);
}
export function encodeBase32(bytes){let bits=0,acc=0,out='';for(const b of bytes){acc=(acc<<8)|b;bits+=8;while(bits>=5){bits-=5;out+=alphabet[(acc>>>bits)&31];acc&=(1<<bits)-1;}}
 if(bits)out+=alphabet[(acc<<(5-bits))&31];return out;}
export const generateAdminTotpSecret=()=>encodeBase32(randomBytes(20));
function encryptionKey(masterKey){check(typeof masterKey==='string'&&/^[a-fA-F0-9]{64}$/.test(masterKey),503,'ADMIN_MFA_ENCRYPTION_KEY must be 32 bytes hex');return Buffer.from(masterKey,'hex');}
export function encryptAdminSecret(secret,userId,masterKey){decodeBase32(secret);check(/^[0-9a-f-]{36}$/i.test(userId),400,'Invalid administrator identifier');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(masterKey),iv);
 cipher.setAAD(Buffer.from('elesend:admin-mfa:v1:'+userId));const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
 return ['v1',iv.toString('base64url'),encrypted.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');}
export function decryptAdminSecret(value,userId,masterKey){
 check(typeof value==='string',503,'Administrator factor unavailable');const parts=value.split('.');check(parts.length===4&&parts[0]==='v1',503,'Unknown factor encryption format');
 try{const decipher=createDecipheriv('aes-256-gcm',encryptionKey(masterKey),Buffer.from(parts[1],'base64url'));
  decipher.setAAD(Buffer.from('elesend:admin-mfa:v1:'+userId));decipher.setAuthTag(Buffer.from(parts[3],'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[2],'base64url')),decipher.final()]).toString('utf8');
 }catch{check(false,503,'Administrator factor decryption unavailable');}}
export function totp(secret,step){check(Number.isSafeInteger(step)&&step>=0,400,'Invalid authenticator step');
 const key=decodeBase32(secret),buffer=Buffer.alloc(8);buffer.writeBigUInt64BE(BigInt(step));
 const digest=createHmac('sha1',key).update(buffer).digest(),offset=digest[19]&15;
 const code=((digest.readUInt32BE(offset)&0x7fffffff)%1000000).toString().padStart(6,'0');return code;
}
/** Returns the accepted counter, or null. Never reuse an accepted time step. */
export function verifyAdminTotp(secret,code,{now=Date.now(),lastUsedStep=-1}={}){
 if(typeof code!=='string'||!/^[0-9]{6}$/.test(code)||!Number.isFinite(now))return null;
 const base=Math.floor(now/30000);let match=null;
 for(const step of [base-1,base,base+1]){
  if(step<0)continue;
  const expected=Buffer.from(totp(secret,step)),incoming=Buffer.from(code);
  if(timingSafeEqual(expected,incoming)&&step>Number(lastUsedStep))match=step;
 }
 return match;
}
