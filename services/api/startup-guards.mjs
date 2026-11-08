import {readdirSync} from 'node:fs';
import {check} from './security.mjs';

// The newest database update shipped with this code. Read from the folder so a new migration can never be missed:
// a server started before migrating refuses to run instead of failing on every request that needs the new columns.
export const REQUIRED_MIGRATION=readdirSync(new URL('../../database/migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort().at(-1);

export async function assertRequiredSchema(db){
 const result=await db.query('SELECT 1 FROM schema_migrations WHERE name=$1',[REQUIRED_MIGRATION]);
 check(result.rowCount>0,503,`Apply migrations through ${REQUIRED_MIGRATION} before starting ELESEND`);
}

export function assertPaymentOperations(provider,{production=false}={}){
 if(!production||!provider)return;
 const required=['createCheckout','verifyPayment','createRefund','verifyRefund','verifyBeneficiary','createPayout','verifyPayout'];
 const missing=required.filter(name=>typeof provider[name]!=='function');
 check(!missing.length,503,`Payment adapter ${provider.name} lacks required operations: ${missing.join(', ')}. Configure a complete payment gateway adapter before production startup.`);
}

/**
 * Warns when the production API logs in to the database as the table owner or a superuser. Those can switch off the
 * triggers that keep payment records unchangeable, and a superuser can run programs on the database server. This is a
 * warning only and never stops the server. scripts/migrate.mjs creates a limited login when ELESEND_APP_DB_PASSWORD
 * is set; point DOCKER_APP_DATABASE_URL at it to clear the warning.
 */
export async function warnIfOwnerDatabaseLogin(db,{production=false,log=line=>process.stderr.write(line+'\n')}={}){
 if(!production)return null;
 try{
  const r=(await db.query(`SELECT current_user AS login,r.rolsuper OR r.rolbypassrls AS powerful,
    EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='shipments' AND tableowner=current_user) AS owner
    FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  if(r&&(r.powerful||r.owner)){
   log(JSON.stringify({level:'warn',component:'database_login',code:'owner_login',message:`The API is logged in to the database as "${r.login}", which ${r.owner?'owns the tables':''}${r.owner&&r.powerful?' and ':''}${r.powerful?'is a superuser':''}. Set ELESEND_APP_DB_PASSWORD, run migrations and set DOCKER_APP_DATABASE_URL to the limited login.`}));
   return 'owner_login';
  }
  return null;
 }catch{return null;}
}
