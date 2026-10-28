import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateConfig} from '../services/api/config.mjs';
import {database} from '../services/api/db.mjs';
import {osrmRouting} from '../services/api/dispatch-routing.mjs';
import {httpsSmsGateway} from '../services/api/sms-gateway.mjs';
const base={NODE_ENV:'production',DATABASE_URL:'postgres://test:test@localhost/test',OTP_KEY:'a'.repeat(64),ADMIN_MFA_ENCRYPTION_KEY:'b'.repeat(64),API_PUBLIC_ORIGIN:'https://api.example.test',WEB_PUBLIC_ORIGIN:'https://app.example.test',ROUTING_OSRM_CAR_URL:'http://car:5000',ROUTING_OSRM_MOTORCYCLE_URL:'http://bike:5000'};
test('vehicle settings produce working adapter contract',()=>{const r=validateConfig(base);assert.equal(r.ok,true);assert.doesNotThrow(()=>osrmRouting({vehicleRoutes:r.config.routing.vehicleRoutes,profiles:r.config.routing.profiles}));});
test('production rejects absent origins, malformed origins and malformed port',()=>{
 for(const extra of [{API_PUBLIC_ORIGIN:''},{API_PUBLIC_ORIGIN:'https://user:pass@host/'},{WEB_PUBLIC_ORIGIN:'https://host/path'},{PORT:'3090oops'}])assert.equal(validateConfig({...base,...extra}).ok,false);
});
test('production origins never silently fall back to hardcoded domains',()=>{
 const r=validateConfig({...base,API_PUBLIC_ORIGIN:'',WEB_PUBLIC_ORIGIN:''});
 assert.equal(r.ok,false);
 assert.equal(r.config.origins.apiPublicOrigin,'');
 assert.equal(r.config.origins.webPublicOrigin,'');
 assert.ok(r.errors.some(e=>e.includes('API_PUBLIC_ORIGIN is required')));
 assert.ok(r.errors.some(e=>e.includes('WEB_PUBLIC_ORIGIN is required')));
});
test('background jobs configuration flag is parsed accurately',()=>{
 const r1=validateConfig({...base,BACKGROUND_JOBS_ENABLED:'false'});
 assert.equal(r1.ok,true);
 assert.equal(r1.config.server.backgroundJobsEnabled,false);

 const r2=validateConfig({...base,BACKGROUND_JOBS_ENABLED:'true'});
 assert.equal(r2.ok,true);
 assert.equal(r2.config.server.backgroundJobsEnabled,true);
});
test('database uses validated TLS and preserves CA despite URL SSL overrides',async()=>{
 const db=database('postgres://test:test@localhost/test?sslmode=require',{enabled:true,rejectUnauthorized:true,ca:'fixture-ca'});
 try{assert.deepEqual(db.pool.options.ssl,{rejectUnauthorized:true,ca:'fixture-ca'});assert.equal(new URL(db.pool.options.connectionString).searchParams.has('sslmode'),false);}finally{await db.close();}
});

test('production rejects malformed optional origin overrides and invalid routing URLs',()=>{
 const r1=validateConfig({...base,HUBTEL_CALLBACK_BASE_URL:'http://insecure.test'});
 assert.equal(r1.ok,false);
 assert.ok(r1.errors.some(e=>e.includes('HUBTEL_CALLBACK_BASE_URL must use HTTPS')));

 const r2=validateConfig({...base,ROUTING_OSRM_URL:'not-a-valid-url'});
 assert.equal(r2.ok,false);
 assert.ok(r2.errors.some(e=>e.includes('ROUTING_OSRM_URL must be a valid URL')));
});

test('generic SMS gateway configuration validates required fields and is wired into compose files',()=>{
 const missingEndpoint=validateConfig({...base,SMS_PROVIDER:'https_gateway'});
 assert.equal(missingEndpoint.ok,false);
 assert.ok(missingEndpoint.errors.some(e=>e.includes('SMS_GATEWAY_ENDPOINT is missing')));
 assert.ok(missingEndpoint.errors.some(e=>e.includes('SMS_GATEWAY_ALLOWED_HOST is missing')));
 assert.ok(missingEndpoint.errors.some(e=>e.includes('SMS_GATEWAY_TOKEN is missing')));

 const hostMismatch=validateConfig({
  ...base,
  SMS_PROVIDER:'https_gateway',
  SMS_GATEWAY_ENDPOINT:'https://sms.example.test/send',
  SMS_GATEWAY_ALLOWED_HOST:'other.example.test',
  SMS_GATEWAY_TOKEN:'s'.repeat(24)
 });
 assert.equal(hostMismatch.ok,false);
 assert.ok(hostMismatch.errors.some(e=>e.includes('SMS_GATEWAY_ALLOWED_HOST must match')));

 const insecureSms=validateConfig({
  ...base,
  SMS_PROVIDER:'https_gateway',
  SMS_GATEWAY_ENDPOINT:'http://sms.example.test/send',
  SMS_GATEWAY_ALLOWED_HOST:'sms.example.test',
  SMS_GATEWAY_TOKEN:'s'.repeat(24)
 });
 assert.equal(insecureSms.ok,false);

 const validSms=validateConfig({
  ...base,
  SMS_PROVIDER:'https_gateway',
  SMS_GATEWAY_ENDPOINT:'https://sms.example.test/send',
  SMS_GATEWAY_ALLOWED_HOST:'sms.example.test',
  SMS_GATEWAY_TOKEN:'s'.repeat(24)
 });
 assert.equal(validSms.ok,true);
 assert.equal(validSms.config.sms.provider,'https_gateway');
 assert.doesNotThrow(()=>httpsSmsGateway(validSms.config.sms.httpsGateway));

 for(const path of ['compose.yaml','deploy/runtime/compose.yaml']){
  const yaml=readFileSync(new URL('../'+path,import.meta.url),'utf8');
  assert.match(yaml,/SMS_GATEWAY_ENDPOINT:\s*\$\{SMS_GATEWAY_ENDPOINT:-\}/);
  assert.match(yaml,/SMS_GATEWAY_ALLOWED_HOST:\s*\$\{SMS_GATEWAY_ALLOWED_HOST:-\}/);
  assert.match(yaml,/SMS_GATEWAY_TOKEN:\s*\$\{SMS_GATEWAY_TOKEN:-\}/);
 }
});
