import {randomUUID} from 'node:crypto';
import {database} from '../services/api/db.mjs';
import {phone,passwordHash,check} from '../services/api/security.mjs';
import {encryptAdminSecret} from '../services/api/admin-mfa.mjs';
const p=phone(process.env.ADMIN_PHONE);check((process.env.ADMIN_PASSWORD??'').length>=16,400,'ADMIN_PASSWORD must have at least 16 characters');
const mfaSecret=process.env.ADMIN_TOTP_SECRET_BASE32;
const db=database();try{const password=await passwordHash(process.env.ADMIN_PASSWORD);await db.tx(async c=>{const uid=randomUUID();await c.query("INSERT INTO users(id,phone,password_hash,kind) VALUES($1,$2,$3,'admin')",[uid,p,password]);await c.query('INSERT INTO admin_mfa_credentials(user_id,secret_encrypted) VALUES($1,$2)',[uid,encryptAdminSecret(mfaSecret,uid,process.env.ADMIN_MFA_ENCRYPTION_KEY)]);for(const perm of ['verification:write','pricing:write','shipments:read','dispatch:configure','finance:configure','finance:read','finance:adjust','finance:approve','payments:configure'])await c.query('INSERT INTO permissions VALUES($1,$2)',[uid,perm]);await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'admin.bootstrapped',$1)",[uid]);});console.log('Administrator created');}finally{await db.close();}
