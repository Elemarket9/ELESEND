import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateQuote} from '../services/api/pricing.mjs';
const p={base_minor:3000,per_km_minor:0,commission_bps:1000,commission_mode:'percentage',commission_fixed_minor:0,commission_cap_minor:null};
test('GH₵30 cash job splits exactly into GH₵27 rider earnings and GH₵3 commission',()=>{
 assert.deepEqual(calculateQuote(p,0),{amountMinor:3000,commissionMinor:300,riderEarningsMinor:2700});
});
test('ten completed GH₵30 priced jobs imply GH₵30 commission accrued, NOT received',()=>{
 const entries=Array.from({length:10},()=>calculateQuote(p,0));assert.equal(entries.reduce((sum,x)=>sum+x.commissionMinor,0),3000);
});
test('fixed, hybrid and configurable caps do not exceed customer price',()=>{
 assert.equal(calculateQuote({...p,commission_mode:'fixed',commission_fixed_minor:200},0).commissionMinor,200);
 assert.equal(calculateQuote({...p,commission_mode:'hybrid',commission_fixed_minor:50},0).commissionMinor,350);
 assert.equal(calculateQuote({...p,commission_mode:'hybrid',commission_fixed_minor:999999,commission_cap_minor:100},0).commissionMinor,100);
 assert.equal(calculateQuote({...p,commission_mode:'fixed',commission_fixed_minor:999999,commission_cap_minor:null},0).commissionMinor,3000);
});
test('fractional kilometre rounds charge once in integer minor units',()=>{
 assert.equal(calculateQuote({...p,per_km_minor:123},1001).amountMinor,3124);
});
test('invalid money, modes and commission bps fail closed',()=>{
 assert.throws(()=>calculateQuote({...p,commission_bps:10001},100));
 assert.throws(()=>calculateQuote({...p,commission_mode:'surprise'},100));
 assert.throws(()=>calculateQuote(p,NaN));
});
