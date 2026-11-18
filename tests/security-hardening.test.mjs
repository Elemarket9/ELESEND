import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID,randomInt} from 'node:crypto';
import {assertAcceptablePassword,passwordHash,passwordMatches,passwordNeedsUpgrade} from '../services/api/shared/security.mjs';
import {findSecrets} from '../scripts/secret-scan.mjs';
import {companyPortalCsp,renderCompanyPortalHtml} from '../services/api/company-web/company-portal.mjs';

test('common and guessable passwords are refused, long unrelated ones are not',()=>{
 for(const p of ['password1234','Password1234!','123456789012','aaaaaaaaaaaa','qwertyuiop12','P@ssw0rd1234','elesend12345','Ghana2026!!!','abababababab','iloveyou1234'])assert.throws(()=>assertAcceptablePassword(p),{status:400},p);
 assert.throws(()=>assertAcceptablePassword('x241234567y-z',{phone:'+233241234567'}),{status:400});
 for(const p of ['mango river lantern','Correct-pass-1','correct horse battery staple'])assert.doesNotThrow(()=>assertAcceptablePassword(p),p);
});

test('passwords use the stronger setting and older hashes keep working',async()=>{
 const stored=await passwordHash('mango river lantern');
 assert.ok(stored.startsWith('v2$'));
 assert.equal(passwordNeedsUpgrade(stored),false);
 assert.equal(await passwordMatches('mango river lantern',stored),true);
 assert.equal(await passwordMatches('wrong password here',stored),false);
 const {scryptSync}=await import('node:crypto');
 const salt='a'.repeat(32),legacy=salt+':'+scryptSync('old password value',salt,64).toString('hex');
 assert.equal(passwordNeedsUpgrade(legacy),true);
 assert.equal(await passwordMatches('old password value',legacy),true);
});

test('no live credentials are committed',()=>{assert.deepEqual(findSecrets(),[]);});

test('company portal policy allows only its own script and style, and they match',()=>{
 const html=renderCompanyPortalHtml(),csp=companyPortalCsp();
 const hash=t=>`'sha256-${createHash('sha256').update(t).digest('base64')}'`;
 assert.ok(csp.includes(hash(/<script>([\s\S]*)<\/script>/.exec(html)[1])));
 assert.ok(csp.includes(hash(/<style>([\s\S]*)<\/style>/.exec(html)[1])));
 assert.ok(!csp.includes('unsafe'));
 assert.ok(!/\son[a-z]+=|\sstyle="/.test(html.replace(/<script>[\s\S]*<\/script>/,'')),'no inline handlers or style attributes');
});

test('admin routes stay off the public hosts, and only the admin host can be restricted',()=>{
 const caddy=readFileSync(new URL('../deploy/runtime/Caddyfile',import.meta.url),'utf8');
 assert.equal((caddy.match(/@blocked path [^\n]*\/api\/v1\/admin\*/g)||[]).length,2);
 assert.match(caddy,/@outside not remote_ip \{\$ADMIN_ALLOWED_IPS\}/);
 assert.match(readFileSync(new URL('../deploy/runtime/compose.yaml',import.meta.url),'utf8'),/ADMIN_ALLOWED_IPS:-0\.0\.0\.0\/0 ::\/0/);
});

const url=process.env.TEST_DATABASE_URL;
test('limited database login cannot change structure or audit history',{skip:!url},async()=>{
 assert.match(new URL(url).pathname,/^\/elesend_test/,'Requires dedicated test database');
 const {database}=await import('../services/api/shared/db.mjs');
 const {migrate,applyAppRole}=await import('../scripts/migrate.mjs');
 const db=database(url);
 try{
  await migrate(db);
  assert.equal(await applyAppRole(db,{}),false,'nothing changes unless a password is set');
  assert.equal(await applyAppRole(db,{ELESEND_APP_DB_ROLE:'elesend_app_test',ELESEND_APP_DB_PASSWORD:"it's a test value"}),true);
  const asApp=async sql=>db.tx(async c=>{await c.query('SET LOCAL ROLE elesend_app_test');return c.query(sql);});
  assert.equal((await asApp('SELECT count(*)::int AS n FROM users')).rows.length,1);
  await asApp("INSERT INTO audit_logs(action) VALUES('role.test')");
  await assert.rejects(asApp("UPDATE audit_logs SET action='changed' WHERE action='role.test'"));
  await assert.rejects(asApp("DELETE FROM audit_logs WHERE action='role.test'"));
  for(const sql of ['ALTER TABLE audit_logs DISABLE TRIGGER immutable_audit','TRUNCATE audit_logs','DROP TABLE audit_logs','CREATE TABLE public.intruder(id int)',"DELETE FROM schema_migrations"])await assert.rejects(asApp(sql),undefined,sql);
  for(const table of ['chat_audit_logs','commission_audit_logs','promotion_audit_logs'])assert.equal((await db.query('SELECT 1 FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal',[table])).rows.length>=1,true,table);
 }finally{await db.close();}
});

test('administrator sessions end after 30 minutes without use',{skip:!url},async()=>{
 const {database}=await import('../services/api/shared/db.mjs');
 const {platform}=await import('../services/api/modules/orders/platform.mjs');
 const db=database(url);
 try{
  const id=randomUUID(),token='a'.repeat(32)+randomUUID().replaceAll('-','');
  const {hash}=await import('../services/api/shared/security.mjs');
  await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'test-only','admin',now())",[id,'+2332'+randomInt(10000000,99999999)]);
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at,admin_mfa_verified,last_seen_at) VALUES($1,$2,now()+interval '4 hours',true,now()-interval '31 minutes')",[hash(token),id]);
  await assert.rejects(platform(db,{otpKey:'d'.repeat(64)}).authenticate(token),{status:401});
  await db.query("UPDATE sessions SET last_seen_at=now()-interval '10 minutes' WHERE token_hash=$1",[hash(token)]);
  assert.equal((await platform(db,{otpKey:'d'.repeat(64)}).authenticate(token)).id,id);
  assert.ok((await db.query("SELECT 1 FROM sessions WHERE token_hash=$1 AND last_seen_at>now()-interval '1 minute'",[hash(token)])).rowCount);
 }finally{await db.close();}
});
