import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateConfig} from '../services/api/config.mjs';
import {database} from '../services/api/db.mjs';
import {osrmRouting} from '../services/api/dispatch-routing.mjs';
import {httpsSmsGateway} from '../services/api/sms-gateway.mjs';
const base={NODE_ENV:'production',DATABASE_URL:'postgres://test:test@localhost/test',OTP_KEY:'a'.repeat(64),ADMIN_MFA_ENCRYPTION_KEY:'b'.repeat(64),RIDER_ID_ENCRYPTION_KEY:'d'.repeat(64),SAFETY_ALERT_PHONE:'+233241234567',DIDIT_API_KEY:'didit-key',DIDIT_WORKFLOW_ID:'11111111-1111-4111-8111-111111111111',DIDIT_WEBHOOK_SECRET:'didit-secret',API_PUBLIC_ORIGIN:'https://api.example.test',WEB_PUBLIC_ORIGIN:'https://app.example.test',ADMIN_HOST:'admin.example.test',ROUTING_OSRM_CAR_URL:'http://car:5000',ROUTING_OSRM_MOTORCYCLE_URL:'http://bike:5000'};
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

test('production rejects malformed origin overrides; a bad routing URL only switches routing off',()=>{
 const r1=validateConfig({...base,HUBTEL_CALLBACK_BASE_URL:'http://insecure.test'});
 assert.equal(r1.ok,false);
 assert.ok(r1.errors.some(e=>e.includes('HUBTEL_CALLBACK_BASE_URL must use HTTPS')));

 const r2=validateConfig({...base,ROUTING_OSRM_URL:'not-a-valid-url'});
 assert.equal(r2.errors.some(e=>e.includes('ROUTING_OSRM_URL')),false);
 assert.ok(r2.warnings.some(e=>e.includes('ROUTING_OSRM_URL is not a valid URL')));
});

test('a motorbike graph pointing at the car graph is dropped with a warning instead of crashing startup',()=>{
 const r=validateConfig({...base,ROUTING_OSRM_CAR_URL:'http://osrm:5000',ROUTING_OSRM_MOTORCYCLE_URL:'http://osrm:5000'});
 assert.ok(r.warnings.some(e=>e.includes('motorcycle road graph points at the car graph')));
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

test('production starts with no provider settings',()=>{
 const r=validateConfig({NODE_ENV:'production',DATABASE_URL:'postgres://test:test@localhost/test',OTP_KEY:'a'.repeat(64),ADMIN_MFA_ENCRYPTION_KEY:'b'.repeat(64),API_PUBLIC_ORIGIN:'https://api.example.test',WEB_PUBLIC_ORIGIN:'https://app.example.test',ADMIN_HOST:'admin.example.test'});
 assert.deepEqual(r.errors,[]);assert.equal(r.ok,true);
});

test('production requires an admin host and any named payment provider with its secrets',()=>{
 const missing=validateConfig({...base,ADMIN_HOST:''});
 assert.equal(missing.ok,false);
 assert.ok(missing.errors.some(e=>e.includes('ADMIN_HOST is required')));
 const hubtel=validateConfig({...base,PAYMENT_PROVIDER:'hubtel',HUBTEL_CLIENT_ID:'id',HUBTEL_CLIENT_SECRET:'secret',HUBTEL_MERCHANT_ACCOUNT_NUMBER:'1',HUBTEL_DISBURSEMENT_ACCOUNT_NUMBER:'2'});
 assert.equal(hubtel.ok,true,hubtel.errors.join('; '));
 assert.equal(hubtel.config.payment.provider,'hubtel');
 const incomplete=validateConfig({...base,PAYMENT_PROVIDER:'hubtel',HUBTEL_CLIENT_ID:'id',HUBTEL_CLIENT_SECRET:'secret',HUBTEL_MERCHANT_ACCOUNT_NUMBER:'1'});
 assert.equal(incomplete.ok,false);
 assert.ok(incomplete.errors.some(e=>e.includes('HUBTEL_DISBURSEMENT_ACCOUNT_NUMBER')));
});

test('production still requires ELESEND own secrets',()=>{
 const r=validateConfig({NODE_ENV:'production',DATABASE_URL:'postgres://test:test@localhost/test',OTP_KEY:'a'.repeat(64),API_PUBLIC_ORIGIN:'https://api.example.test',WEB_PUBLIC_ORIGIN:'https://app.example.test'});
 assert.ok(r.errors.some(e=>e.includes('ADMIN_MFA_ENCRYPTION_KEY must be exactly')));
});

test('the API tells apps where the map lives, with no address in the code',async()=>{
 const {publicMapConfig}=await import('../services/api/map-config.mjs');
 assert.deepEqual(publicMapConfig({MAPS_PUBLIC_ORIGIN:'https://maps.example.test/'}),{tileUrl:'https://maps.example.test/tiles/{z}/{x}/{y}.pbf',glyphsUrl:'https://maps.example.test/fonts/{fontstack}/{range}.pbf'});
 assert.deepEqual(publicMapConfig({}),{tileUrl:null,glyphsUrl:null});
});

test('no deployment domain is stored in the repository',()=>{
 for(const file of ['.env.example','deploy/runtime/.env.example'])assert.match(readFileSync(new URL('../'+file,import.meta.url),'utf8'),/^ELESEND_DOMAIN=your-domain\.example$/m,file);
 assert.equal(readFileSync(new URL('../apps/mobile/eas.json',import.meta.url),'utf8').includes('EXPO_PUBLIC_ELESEND_API_BASE_URL'),false);
});

test('a production database reached over a network without TLS gets a warning, never a refusal to start',()=>{
 const remote={...base,DATABASE_URL:'postgres://app:pw@db.example-cloud.test:5432/elesend'};
 const plain=validateConfig(remote);
 assert.equal(plain.errors.some(e=>/without TLS/.test(e)),false,'never blocks the deploy');
 assert.ok(plain.warnings.some(e=>/without TLS/.test(e)));
 assert.equal(validateConfig({...remote,DATABASE_URL:remote.DATABASE_URL+'?sslmode=verify-full'}).warnings.some(e=>/without TLS/.test(e)),false);
 assert.equal(validateConfig({...remote,DATABASE_SSL:'disable'}).warnings.some(e=>/without TLS/.test(e)),false,'an explicit choice for a private network');
 for(const local of ['postgres://a:b@localhost/x','postgres://a:b@db:5432/x'])
  assert.equal(validateConfig({...base,DATABASE_URL:local}).warnings.some(e=>/without TLS/.test(e)),false,local);
});
