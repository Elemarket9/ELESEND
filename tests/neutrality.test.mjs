import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {validateConfig} from '../services/api/config.mjs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('the customer app has no made-up prices, places, addresses or contact details',()=>{
 const app=read('apps/mobile/src/customer/CustomerApp.js');
 for(const fixed of ['from GH₵ 15','from GH₵ 25','from GH₵ 64','Kwame Nkrumah Ave','+233 24 000 0000','defaultLandmarks','POPULAR GHANAIAN','Als Global','Accra, Greater Accra',"region: 'Greater Accra'",'Paystack','v0.2.0'])assert.equal(app.includes(fixed),false,fixed);
 assert.match(app,/\/api\/v1\/pricing\/vehicles/);
});

test('portals and navigation depend on no outside font or map service',()=>{
 for(const file of ['apps/restaurant-web/index.html','services/api/admin-web/admin-portal.mjs','services/api/http.mjs'])assert.equal(/fonts\.(googleapis|gstatic)/.test(read(file)),false,file);
 for(const file of ['apps/mobile/src/maps/map-adapter.js','apps/mobile-shared/src/maps/map-adapter.js'])assert.equal(/google/i.test(read(file)),false,file);
});

test('unused competitor and paid routing code is gone',()=>{
 for(const file of ['services/api/google-routing.mjs','services/api/infrastructure/pricing/unbeatable-pricing-engine.mjs'])assert.equal(existsSync(new URL('../'+file,import.meta.url)),false,file);
});

test('address lookup needs an explicitly chosen service',()=>{
 for(const file of ['services/api/config.mjs','services/api/providers/ghanapostgps.mjs','compose.yaml','compose.private-maps.yaml','deploy/runtime/compose.yaml','.env.example'])assert.equal(read(file).includes('sperixlabs'),false,file);
 const missing=validateConfig({GHANAPOSTGPS_LOOKUP_ENABLED:'true'});
 assert.ok(missing.errors.some(e=>e.includes('GHANAPOSTGPS_LOOKUP_URL')));
 assert.equal(validateConfig({GHANAPOSTGPS_LOOKUP_ENABLED:'true',GHANAPOSTGPS_LOOKUP_URL:'https://lookup.example.test'}).errors.some(e=>e.includes('GHANAPOSTGPS_LOOKUP_URL')),false);
});

test('currency and time zone come from one place outside payment adapters',()=>{
 for(const file of ['checkout','finance','platform','rider-wallet'])assert.equal(/'GHS'/.test(read('services/api/'+file+'.mjs')),false,file);
 for(const file of ['platform.mjs','eta/stage-eta.mjs'])assert.equal(read('services/api/'+file).includes("'Africa/Accra'"),false,file);
});
