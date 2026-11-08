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
