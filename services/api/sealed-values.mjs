import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
/** AES-256-GCM with the context bound in, so a value cannot be moved to another record. */
export function seal(key,context,value){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 cipher.setAAD(Buffer.from(context));
 const data=Buffer.concat([cipher.update(value),cipher.final()]);
 return ['v1',iv.toString('base64url'),data.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
}
export function unseal(key,context,value){
 const [,iv,data,tag]=value.split('.');
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));
 decipher.setAAD(Buffer.from(context));
 decipher.setAuthTag(Buffer.from(tag,'base64url'));
 return Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]);
}
