import test from 'node:test';
import assert from 'node:assert/strict';
import {smoothSurge} from '../services/api/pricing-surge.mjs';
import {calculateQuote} from '../services/api/pricing.mjs';
import {readFileSync} from 'node:fs';
test('surge rises slowly, requires independent demand and decays within bounds',()=>{
 assert.equal(smoothSurge({demand:2,supply:0}),10000);
 assert.equal(smoothSurge({demand:100,supply:0}),10500);
 assert.equal(smoothSurge({demand:0,supply:100,previousBps:20000}),19500);
 assert.equal(smoothSurge({demand:10,supply:10,previousBps:10200}),10000);
 let previousBps=10000;for(let i=0;i<100;i++)previousBps=smoothSurge({demand:100,supply:1,previousBps});assert.ok(previousBps<=20000);
 assert.throws(()=>smoothSurge({demand:-1,supply:1}));
});
test('minimum applies after surge and accepted commission arithmetic stays exact',()=>{
 const policy={base_minor:1000,per_km_minor:0,minimum_minor:2000,commission_bps:2000};
 assert.deepEqual(calculateQuote(policy,0,{surgeBps:14000}),{amountMinor:2000,commissionMinor:400,riderEarningsMinor:1600});
 assert.throws(()=>calculateQuote(policy,0,{surgeBps:20001}));
});
test('approved owner tariffs price road minutes and kilometres without floating point',()=>{
 const tariffs=JSON.parse(readFileSync(new URL('../config/vehicle-tariffs.json',import.meta.url),'utf8'));
 for(const [vehicle,normal,rush] of [['motorcycle',5150,7210],['car',9000,12600],['van',17300,24220]]){
  const t=tariffs[vehicle],policy={base_minor:t.baseMinor,per_km_minor:t.perKmMinor,per_minute_minor:t.perMinuteMinor,minimum_minor:t.minimumMinor,commission_bps:2000};
  assert.equal(calculateQuote(policy,10000,{durationSeconds:1800}).amountMinor,normal);
  const result=calculateQuote(policy,10000,{durationSeconds:1800,surgeBps:14000});assert.equal(result.amountMinor,rush);
  assert.equal(result.commissionMinor+result.riderEarningsMinor,rush);
  assert.equal(calculateQuote(policy,0,{durationSeconds:0}).amountMinor,t.minimumMinor);
 }
});
