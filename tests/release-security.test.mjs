import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {generateAdminTotpSecret,encodeBase32,decodeBase32,totp,verifyAdminTotp,encryptAdminSecret,decryptAdminSecret} from '../services/api/admin-mfa.mjs';
import {httpsSmsGateway} from '../services/api/sms-gateway.mjs';
const master=randomBytes(32).toString('hex');
const actor=randomUUID();
test('TOTP uses RFC6238 compatible six-digit codes and accepts controlled clock skew',()=>{
 const secret=generateAdminTotpSecret(),time=1_760_000_010_000,step=Math.floor(time/30000),code=totp(secret,step);
 assert.match(secret,/^[A-Z2-7]{32}$/);assert.equal(decodeBase32(secret).length,20);
 assert.equal(encodeBase32(decodeBase32(secret)),secret);
 assert.equal(code.length,6);assert.equal(verifyAdminTotp(secret,code,{now:time}),step);
 assert.equal(verifyAdminTotp(secret,code,{now:time,lastUsedStep:step}),null);
 assert.equal(verifyAdminTotp(secret,code,{now:time,lastUsedStep:step+1}),null);
 assert.equal(verifyAdminTotp(secret,code,{now:time+60001}),null);
 assert.equal(verifyAdminTotp(secret,'00000a',{now:time}),null);
});
test('encrypted factors are identity-bound and reject tampering, master key mismatch and malformed configuration',()=>{
 const secret=generateAdminTotpSecret(),cipher=encryptAdminSecret(secret,actor,master);
 assert.equal(decryptAdminSecret(cipher,actor,master),secret);
 assert.ok(!cipher.includes(secret));
 assert.throws(()=>decryptAdminSecret(cipher,randomUUID(),master));
 assert.throws(()=>decryptAdminSecret(cipher,actor,randomBytes(32).toString('hex')));
 assert.throws(()=>decryptAdminSecret(cipher.slice(0,-2)+'ab',actor,master));
 assert.throws(()=>encryptAdminSecret(secret,actor,''),x=>x.status===503);
 assert.throws(()=>encryptAdminSecret('A'.repeat(16),actor,master),x=>x.status===400);
});
test('concurrent step reuse is denied by comparing to locked last-used counter',()=>{
 const seed=generateAdminTotpSecret(),step=Math.floor(Date.now()/30000),code=totp(seed,step);
 assert.equal(verifyAdminTotp(seed,code,{lastUsedStep:step-1}),step);
 assert.equal(verifyAdminTotp(seed,code,{lastUsedStep:step}),null);
});
test('SMS gateway rejects unapproved URLs, private destinations, missing configuration and non-HTTPS',()=>{
 const t='fake-test-token-at-least-sixteen';
 for(const url of ['http://gateway.example.test/send','https://localhost/send','https://127.0.0.1/send','https://user:pw@gateway.example.test/send','https://gateway.example.test:8443/send','https://gateway.example.test.evil.invalid/send']){
  assert.throws(()=>httpsSmsGateway({endpoint:url,allowedHost:'gateway.example.test',token:t}),x=>x.status===503,url);
 }
 assert.throws(()=>httpsSmsGateway({endpoint:'https://gateway.example.test/send',allowedHost:'gateway.example.test',token:'short'}),x=>x.status===503);
});
test('SMS gateway sends 6-digit challenge with authenticated gateway and requires durable gateway acceptance',async()=>{
 const calls=[],fake=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({accepted:true,messageId:'gw-msg-123'})};};
 const api=httpsSmsGateway({endpoint:'https://gateway.example.test/send',allowedHost:'gateway.example.test',token:'secret-test-token-at-least-sixteen',fetchImpl:fake});
 const challengeId=randomUUID(),result=await api.send({phone:'+233241111222',code:'024628',purpose:'delivery',challengeId});
 assert.equal(result.messageId,'gw-msg-123');
 assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.Authorization,'Bearer secret-test-token-at-least-sixteen');
 const body=JSON.parse(calls[0].options.body);assert.match(body.message,/024628/);assert.equal(body.clientReference,challengeId);
 await assert.rejects(()=>api.send({phone:'000',code:'024628',purpose:'pickup',challengeId}),x=>x.status===400);
});
test('SMS gateway never reports unacknowledged or failed provider message as sent',async()=>{
 for(const fake of [async()=>({ok:false}),async()=>({ok:true,json:async()=>({accepted:false,messageId:'nope'})}),async()=>{throw Error('timeout')}]){
  const api=httpsSmsGateway({endpoint:'https://gateway.example.test/send',allowedHost:'gateway.example.test',token:'secret-test-token-at-least-sixteen',fetchImpl:fake});
  await assert.rejects(()=>api.send({phone:'+233241111222',code:'123456',purpose:'pickup',challengeId:randomUUID()}),x=>x.status===503);
 }
});
test('privileged authentication fails closed on unprovisioned MFA and legacy sessions by source contracts',async()=>{
 const p=await readFile(new URL('../services/api/platform.mjs',import.meta.url),'utf8');
 const migration=await readFile(new URL('../database/migrations/019_admin_mfa_and_auth_hardening.sql',import.meta.url),'utf8');
 assert.match(p,/admin_mfa_credentials WHERE user_id=\$1 FOR UPDATE/);
 assert.match(p,/last_used_step=\$2/);assert.match(p,/admin_mfa_verified=true/);
 assert.match(migration,/admin_mfa_verified boolean NOT NULL DEFAULT false/);
 const s=await readFile(new URL('../scripts/admin.mjs',import.meta.url),'utf8');
 assert.match(s,/encryptAdminSecret/);
});

test('account verification SMS is sent only to a bound registered Ghana phone',async()=>{
 const api=httpsSmsGateway({endpoint:'https://gateway.example.test/send',allowedHost:'gateway.example.test',token:'secret-test-token-at-least-sixteen',fetchImpl:async(_url,{body})=>{
  const msg=JSON.parse(body);assert.equal(msg.to,'+233241111222');assert.match(msg.message,/account phone verification/i);return {ok:true,json:async()=>({accepted:true,messageId:'delivery-request-123'})};}});
 const result=await api.send({phone:'+233241111222',code:'473219',purpose:'account',challengeId:randomUUID()});
 assert.equal(result.accepted,true);
});
test('registered phone ownership verification requires signed expiring challenge and protects rollout',async()=>{
 const src=await readFile(new URL('../services/api/platform.mjs',import.meta.url),'utf8');
 const schema=await readFile(new URL('../database/migrations/020_verified_mobile_identity.sql',import.meta.url),'utf8');
 assert.match(src,/\['account-phone-v1',cid,actor.id,u.phone,code\]/);
 assert.match(src,/sent=true WHERE id=\$1/);
 assert.match(src,/ch.attempts<5/);
 assert.match(src,/UPDATE users SET phone_verified_at=now\(\)/);
 assert.match(src,/if\(process.env.NODE_ENV==='production'\).*requireVerifiedPhone/s);
 assert.match(schema,/UPDATE riders SET online=false/);
 assert.match(schema,/status='invalidated'/);
});
