// Places approved into the database (rider-learned or added by staff) must reach the customer search box.
import test from 'node:test';
import assert from 'node:assert/strict';
import {searchPlaces} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';
const row={id:'lm-1',name:'Mama Esi Chop Bar Kasoa',search_name:'mama esi chop bar kasoa',category:'commerce',subcategory:'restaurant',locality:'Kasoa',city:'Kasoa',region:'Central',latitude:'5.5341',longitude:'-0.4190',aliases:[],entrance:null,popularity:10,street:null,coordinate_kind:'mapped_point',name_sim:0.9,sim:0.9};
test('an approved place from the database is offered first when its name is what was typed',async()=>{
 const r=await searchPlaces({query:async()=>({rows:[row]})},'Mama Esi Chop Bar');
 assert.equal(r[0].name,'Mama Esi Chop Bar Kasoa');assert.equal(typeof r[0].latitude,'number');
});
test('search still answers from built-in places when the database fails or is slow',async()=>{
 const failing=await searchPlaces({query:async()=>{throw Error('down');}},'Kotoka');assert.match(failing[0].name,/Kotoka/);
 const slow=await searchPlaces({query:()=>new Promise(()=>{})},'Kotoka',{timeoutMs:50});assert.match(slow[0].name,/Kotoka/);
});
test('a place in both lists is shown once',async()=>{
 const r=await searchPlaces({query:async()=>({rows:[{...row,name:'Kotoka International Airport',latitude:'5.60519',longitude:'-0.16679'}]})},'Kotoka International Airport');
 assert.equal(r.filter(x=>x.name==='Kotoka International Airport').length,1);
});
test('a search of only filler words does not query the database',async()=>{
 let asked=false;await searchPlaces({query:async()=>{asked=true;return {rows:[]};}},'at the');assert.equal(asked,false);
});
test('the database search runs under its own statement timeout',async()=>{
 const seen=[];const client={query:async sql=>{seen.push(String(sql));return {rows:[]};}};
 await searchPlaces({tx:async fn=>fn(client)},'Kasoa market',{timeoutMs:600});
 assert.match(seen[0],/SET LOCAL statement_timeout = 600/);assert.match(seen[1],/searchable_landmarks_v9/);
});
