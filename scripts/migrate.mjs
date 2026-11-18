import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {database} from '../services/api/shared/db.mjs';
export async function migrate(db){await db.tx(async c=>{
 await c.query('SELECT pg_advisory_xact_lock(617290112)');
 // An index build on a big table can take minutes, so the app's 15-second limit does not apply here. Waiting for a
 // table that live requests are using is capped instead: the deploy stops and can be retried, rather than holding
 // a lock while every request queues behind it.
 await c.query("SET LOCAL statement_timeout=0");
 await c.query(`SET LOCAL lock_timeout='${Number(process.env.MIGRATION_LOCK_TIMEOUT_MS)||10000}ms'`);
 await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
 for(const name of (await readdir(new URL('../database/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){
  const sql=await readFile(new URL('../database/migrations/'+name,import.meta.url),'utf8');
  const sha=createHash('sha256').update(sql).digest('hex');
  const old=(await c.query('SELECT sha256 FROM schema_migrations WHERE name=$1',[name])).rows[0];
  const lfSha=createHash('sha256').update(sql.replace(/\r\n/g,'\n')).digest('hex');
  const crlfSha=createHash('sha256').update(sql.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n')).digest('hex');
  if(old){if(old.sha256!==sha&&old.sha256!==lfSha&&old.sha256!==crlfSha)throw Error('Applied migration checksum mismatch: '+name);continue;}
  await c.query(sql);await c.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,sha]);
 }
});}
/** Optional second database login for the API. It can use data but cannot change tables or switch off the audit triggers. */
export async function applyAppRole(db,env=process.env){
 if(!env.ELESEND_APP_DB_PASSWORD)return false;
 const role=env.ELESEND_APP_DB_ROLE||'elesend_app';
 if(!/^[a-z_][a-z0-9_]{0,62}$/.test(role))throw Error('ELESEND_APP_DB_ROLE is not a valid role name');
 await db.tx(async c=>{
  if(!(await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)await c.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  const password=(await c.query('SELECT format($1::text,$2::text) AS sql',[`ALTER ROLE ${role} PASSWORD %L`,env.ELESEND_APP_DB_PASSWORD])).rows[0].sql;
  await c.query(password);
  const database=(await c.query('SELECT current_database() AS name')).rows[0].name.replace(/"/g,'""');
  for(const sql of [
   `GRANT CONNECT ON DATABASE "${database}" TO ${role}`,
   'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
   `GRANT USAGE ON SCHEMA public TO ${role}`,
   `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
   `REVOKE INSERT,UPDATE,DELETE ON schema_migrations FROM ${role}`,
   `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`
  ])await c.query(sql);
 });
 return true;
}
if(process.argv[1]===import.meta.filename){const db=database();try{await migrate(db);await applyAppRole(db);console.log('Migrations applied');}finally{await db.close();}}
