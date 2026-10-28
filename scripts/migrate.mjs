import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {database} from '../services/api/db.mjs';
export async function migrate(db){await db.tx(async c=>{
 await c.query('SELECT pg_advisory_xact_lock(617290112)');
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
if(process.argv[1]===import.meta.filename){const db=database();try{await migrate(db);console.log('Migrations applied');}finally{await db.close();}}
