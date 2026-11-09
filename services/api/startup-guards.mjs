import {readdirSync} from 'node:fs';
import {check} from './security.mjs';

// Every database update shipped with this code. A server that skipped an earlier file refuses to start,
// even when the newest name is already recorded.
const MIGRATION_DIR=new URL('../../database/migrations/',import.meta.url);
export const REQUIRED_MIGRATIONS=readdirSync(MIGRATION_DIR).filter(n=>n.endsWith('.sql')).sort();
export const REQUIRED_MIGRATION=REQUIRED_MIGRATIONS.at(-1);

export async function assertRequiredSchema(db){
 const result=await db.query('SELECT name FROM schema_migrations WHERE name = ANY($1::text[])',[REQUIRED_MIGRATIONS]);
 const have=new Set(result.rows.map(row=>row.name));
 const missing=REQUIRED_MIGRATIONS.filter(name=>!have.has(name));
 const listed=missing.slice(0,8).join(', ');
 check(missing.length===0,503,`Apply migrations through ${REQUIRED_MIGRATION} before starting ELESEND.${missing.length?` Missing: ${listed}${missing.length>8?'…':''}`:''}`);
}

export function assertPaymentOperations(provider,{production=false}={}){
 if(!production||!provider)return;
 check(provider.name!=='hubtel',503,'PAYMENT_PROVIDER=hubtel cannot be used in production. Choose paystack or gateway.');
 const required=['createCheckout','verifyPayment','createRefund','verifyRefund','verifyBeneficiary','createPayout','verifyPayout'];
 const missing=required.filter(name=>typeof provider[name]!=='function');
 check(!missing.length,503,`Payment adapter ${provider.name} lacks required operations: ${missing.join(', ')}. Configure a complete payment gateway adapter before production startup.`);
}

const LIMITED_ROLE_HINT='Set ELESEND_APP_DB_PASSWORD, run migrations, and point DATABASE_URL (DOCKER_APP_DATABASE_URL in the runtime compose file) at the limited elesend_app role.';

/**
 * Production refuses to run as the table owner or a superuser. Those roles can switch off the triggers that keep
 * payment records unchangeable, and a superuser can run programs on the database server. scripts/migrate.mjs creates
 * the limited login when ELESEND_APP_DB_PASSWORD is set.
 */
export async function warnIfOwnerDatabaseLogin(db,{production=false,log=line=>process.stderr.write(line+'\n')}={}){
 if(!production)return null;
 let r;
 try{
  r=(await db.query(`SELECT current_user AS login,r.rolsuper OR r.rolbypassrls AS powerful,
    EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='shipments' AND tableowner=current_user) AS owner
    FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
 }catch(error){
  check(false,503,`Could not verify the database login (${error.message}). ${LIMITED_ROLE_HINT}`);
 }
 if(r&&(r.powerful||r.owner)){
  const why=`${r.owner?'owns the tables':''}${r.owner&&r.powerful?' and ':''}${r.powerful?'is a superuser':''}`;
  const message=`The API is logged in to the database as "${r.login}", which ${why}. ${LIMITED_ROLE_HINT}`;
  log(JSON.stringify({level:'error',component:'database_login',code:'owner_login',message}));
  check(false,503,message);
 }
 return null;
}
