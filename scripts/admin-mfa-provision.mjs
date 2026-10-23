/** Provision/rotate an existing admin factor from a controlled terminal.
 * Never print, log or transmit secret to the ELESEND mobile app/backend API.
 * Requires the administrator password AND database operator access.
 */
import {database} from '../services/api/db.mjs';
import {check,phone,passwordMatches} from '../services/api/security.mjs';
import {encryptAdminSecret} from '../services/api/admin-mfa.mjs';
const p=phone(process.env.ADMIN_PHONE),pw=process.env.ADMIN_PASSWORD;
check(typeof pw==='string'&&pw.length>=16,400,'ADMIN_PASSWORD must have at least 16 characters');
const db=database();
try{await db.tx(async c=>{
 const user=(await c.query("SELECT id,password_hash FROM users WHERE phone=$1 AND kind='admin' FOR UPDATE",[p])).rows[0];
 check(user&&await passwordMatches(pw,user.password_hash),403,'Admin identity verification failed');
 const encrypted=encryptAdminSecret(process.env.ADMIN_TOTP_SECRET_BASE32,user.id,process.env.ADMIN_MFA_ENCRYPTION_KEY);
 await c.query(`INSERT INTO admin_mfa_credentials(user_id,secret_encrypted,last_used_step) VALUES($1,$2,-1)
 ON CONFLICT(user_id) DO UPDATE SET secret_encrypted=excluded.secret_encrypted,last_used_step=-1,provisioned_at=now()`,[user.id,encrypted]);
 await c.query('DELETE FROM sessions WHERE user_id=$1',[user.id]);
 await c.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'auth.admin_mfa_provisioned',$1)",[user.id]);
 });console.log('Administrator MFA provisioned. All prior sessions revoked.');}
finally{await db.close();}
