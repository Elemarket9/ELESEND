// Searches a real customer typed while booking RAPID Courier to Kasoa, which returned the wrong place first.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ghanaSearch,GHANA_GAZETTEER} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';
const first=q=>ghanaSearch(q,{limit:5})[0]||{};
test('a brand typed as one word still finds the branch in the named town',()=>{
 assert.match(first('GTBank Cape Coast').name,/GT ?Bank/i);
 assert.match(`${first('GTBank Cape Coast').locality||''} ${first('GTBank Cape Coast').name}`,/Cape Coast/i);
});
test('a name typed as two words finds the one-word place',()=>assert.match(first('Shop Rite').name,/Shoprite/i));
test('a well-known single word is not beaten by a fuzzy look-alike',()=>assert.match(first('Kotoka').name,/Kotoka/i));
test('a town name is never ranked under a place that lacks it',()=>{
 for(const r of ghanaSearch('Ecobank Kasoa',{limit:3}))assert.match(`${r.name} ${r.locality||''} ${r.city||''} ${r.region||''}`,/kasoa|ecobank/i);
});
test('placeholder names such as "village" or "shop" are not offered as places',()=>{
 assert.ok(!GHANA_GAZETTEER.some(p=>['village','shop','church','yes'].includes(String(p.name).trim().toLowerCase())));
});
test('the airport domestic terminal is found by the words customers use',()=>{
 for(const q of ['Domestic Terminal','Kotoka domestic terminal','Accra Airport Terminal 2'])assert.match(first(q).name,/Domestic Terminal/i,q);
});
test('GTBank Kasoa is found however the customer spells the bank',()=>{
 for(const q of ['GTBank Kasoa','GT Bank Kasoa','GTBank Kasoa branch','gtb kasoa'])assert.match(first(q).name,/GTBank Kasoa/i,q);
});
test('a transport stop does not outrank the place customers mean',()=>{
 assert.match(first('Circle').name,/Kwame Nkrumah Circle/i);
 assert.match(first('Korle Bu').name,/Korle-Bu Teaching Hospital/i);
 assert.match(first('Kaneshie Market').name,/Kaneshie Market Complex/i);
 assert.equal(first('Action Chapel').category,'religion');
 assert.match(first('PRESEC').name,/Presbyterian Boys/i);
 assert.equal(first('PRESEC').locality,'Legon');
 assert.match(first('PRESEC Legon').name,/Presbyterian Boys/i);
});
test('a village that shares a brand name does not hide the business',()=>{
 assert.equal(first('Papaye').category,'commerce');
 assert.match(first('Papaye').name,/Papaye/i);
});
test('common Ghanaian names and the J/Dz spelling reach the existing place',()=>{
 assert.equal(first('Nkran').name,'Accra');
 assert.match(first('Jorwulu').name,/Dzorwulu/i);
 assert.match(first('Kotoka').name,/Kotoka/i);
 assert.match(first('Bolga').name,/Bolgatanga/i);
});
test('the customer location breaks a tie between same-named markets',()=>{
 const accra={latitude:5.6037,longitude:-0.187};
 const top=ghanaSearch('Central Market',{limit:1,near:accra})[0];
 assert.equal(top.region,'Greater Accra');
 assert.ok(top.distanceMeters<40000);
});
test('category words search the kind of place, and near me uses the customer location',()=>{
 const accra={latitude:5.6037,longitude:-0.187};
 assert.notEqual(first('pharmacy').category,'transport');
 assert.match(`${first('pharmacy').name} ${first('pharmacy').subcategory}`,/pharmac|chemist/i);
 const nearby=ghanaSearch('pharmacy near me',{limit:1,near:accra})[0];
 assert.ok(nearby.distanceMeters<5000,nearby.name);
 assert.match(`${nearby.name} ${nearby.subcategory}`,/pharmac|chemist/i);
 assert.equal(first('church').category,'religion');
 assert.match(first('church').name,/church|chapel/i);
 assert.doesNotMatch(first('church').name,/mosque/i);
 assert.match(first('chop bar').name,/chop bar/i);
 assert.match(first('market').name,/market/i);
});
test('a digital address is recognised and not given a guessed coordinate while lookup is off',async()=>{
 const {searchPlaces}=await import('../services/api/infrastructure/maps/ghana-geocoder.mjs');
 for(const code of ['GA-184-9321','ga1849321','GL-142-1585','GA-1849-3210']){
  const row=ghanaSearch(code)[0];
  assert.equal(row.type,'digital_address');
  assert.equal(row.available,false);
  assert.equal(row.latitude,null);
  assert.match(row.name,/not available yet/i);
  const viaSearch=await searchPlaces(null,code);
  assert.equal(viaSearch[0].latitude,null);
 }
 const {normalizeGhanaDigitalAddress}=await import('../services/api/providers/ghanapostgps.mjs');
 assert.equal(normalizeGhanaDigitalAddress('GA-184-9321'),'GA-184-9321');
 assert.equal(normalizeGhanaDigitalAddress('GA1849321'),'GA-184-9321');
 assert.equal(normalizeGhanaDigitalAddress('GA-1849-3210'),'GA-1849-3210');
});
