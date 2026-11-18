// Searches a real customer typed while booking RAPID Courier to Kasoa, which returned the wrong place first.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ghanaSearch,searchPlaces,GHANA_GAZETTEER} from '../services/api/modules/maps/ghana-geocoder.mjs';
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
 const {searchPlaces}=await import('../services/api/modules/maps/ghana-geocoder.mjs');
 for(const code of ['GA-184-9321','ga1849321','GL-142-1585','GA-1849-3210']){
  const row=ghanaSearch(code)[0];
  assert.equal(row.type,'digital_address');
  assert.equal(row.available,false);
  assert.equal(row.latitude,null);
  assert.match(row.name,/not available yet/i);
  const viaSearch=await searchPlaces(null,code);
  assert.equal(viaSearch[0].latitude,null);
 }
 const {normalizeGhanaDigitalAddress}=await import('../services/api/modules/maps/providers/ghanapostgps.mjs');
 assert.equal(normalizeGhanaDigitalAddress('GA-184-9321'),'GA-184-9321');
 assert.equal(normalizeGhanaDigitalAddress('GA1849321'),'GA-184-9321');
 assert.equal(normalizeGhanaDigitalAddress('GA-1849-3210'),'GA-1849-3210');
});

// Found by searching twenty places across Ghana on 10 Nov 2026.
test('text that matches nothing returns nothing, so the app can offer a map pin',()=>{
 for(const q of ['asdfqwer zxcv','qqqq','xyzzy plugh'])assert.deepEqual(ghanaSearch(q),[],q);
 for(const q of ['kejetea','achimoota','kanishie','tema comunity 1'])assert.ok(ghanaSearch(q).length>0,q+' is a misspelling and must still be found');
});
test('a famous place wins over an obscure spot that shares its first word',()=>{
 const makola=first('Makola');
 assert.equal(makola.name,'Makola Market');
 assert.ok(Math.abs(makola.latitude-5.545)<0.01&&Math.abs(makola.longitude+0.206)<0.01,'in Accra Central');
});
test('a town name means the town, not its station, market or a hamlet that shares the name',()=>{
 for(const town of ['Sunyani','Koforidua','Goaso','Tema','Ho','Wa','Kumasi','Tamale','Bolgatanga'])assert.equal(first(town).name,town);
 assert.equal(first('Madina').region,'Greater Accra');
});
test('the same place is listed once',()=>{
 const names=q=>ghanaSearch(q).map(r=>r.name);
 assert.equal(names('Makola Market').filter(n=>n==='Makola Market').length,1);
 assert.equal(names('Makola').filter(n=>/^Makola Shop/.test(n)).length,1,'a misspelt copy next door is the same place');
 assert.equal(names('Sunyani').filter(n=>n==='Sunyani').length,1);
});
test('a label never repeats itself',()=>{
 for(const q of ['Kejetia Market','Cape Coast Castle','Madina','Bolgatanga','Tamale Teaching Hospital','Shoprite'])
  for(const r of ghanaSearch(q)){const [a,b]=r.label.replace(/^Near [^·]+· /,'').split(', ');assert.notEqual(a,b,`${q}: ${r.label}`);}
 assert.equal(first('Cape Coast Castle').label,'Central Region');
});
test('a business typed with its area finds the nearest one to that area',()=>{
 for(const q of ['Spintex Shoprite','Shoprite Spintex']){
  const hit=first(q);
  assert.equal(hit.name,'Shoprite',q);
  assert.match(hit.label,/^Near Spintex · /);
  assert.ok(Math.abs(hit.latitude-5.64)<0.08&&Math.abs(hit.longitude+0.10)<0.08,'within reach of Spintex');
 }
 assert.doesNotMatch(first('Accra Mall').label,/^Near /,'a place that holds every word is left alone');
});
test('a search the built-in places do not fully answer also asks Photon',async()=>{
 const asked=[];
 const feature=(name,lon,lat)=>({geometry:{coordinates:[lon,lat]},properties:{name,city:'Kasoa',state:'Central'}});
 const fetchImpl=async url=>{asked.push(new URL(url).searchParams.get('q'));return new Response(JSON.stringify({features:[feature('Kasoa Old Market',-0.4301,5.5342),feature('Somewhere Else',-0.43,5.53)]}));};
 const options={photonUrl:'http://photon:2322',fetchImpl};
 const found=await searchPlaces(null,'Kasoa Old Market',options);
 assert.deepEqual(asked,['Kasoa Old Market']);
 assert.equal(found[0].name,'Kasoa Old Market');
 assert.equal(found[0].source,'Photon');
 assert.ok(found.findIndex(r=>r.name==='Somewhere Else')>found.findIndex(r=>r.source!=='Photon'),'a Photon place that lacks the typed words follows the built-in results');
 for(const q of ['Accra Mall','Ho','Wa','Kejetia Market Ashanti','Accra Mall Greater Accra'])await searchPlaces(null,q,options);
 assert.deepEqual(asked,['Kasoa Old Market'],'a search already answered does not call Photon, however short and whether or not it names the region');
 assert.ok((await searchPlaces(null,'Kasoa Old Market',{photonUrl:'http://photon:2322',fetchImpl:async()=>{throw Error('down');}})).length>0,'Photon being down changes nothing');
});
