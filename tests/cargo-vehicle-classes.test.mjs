import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerVehicleInTx,riderMeetsVehicleLicence} from '../services/api/modules/riders/vehicle.mjs';
import {buildParcelQuoteRequest} from '../apps/mobile/src/booking-contract.js';
import {renderAdminPortalHtml} from '../services/api/admin-web/admin-portal.mjs';
import {hideEndedContacts,warnPlaceholderTariffs} from '../services/api/modules/orders/platform.mjs';

test('cargo vehicle registration stores capacity, body and current vehicle paper expiry', async()=>{
 const calls=[];
 const c={async query(sql,values){calls.push({sql,values});return {rows:[],rowCount:1};}};
 const vehicleDetails={plateNumber:'GT 2345-26',make:'Toyota',model:'Hilux',color:'White',payloadCapacityG:950000,bodyType:'open',roadworthyExpiresOn:'2027-10-01',insuranceExpiresOn:'2027-11-01'};
 await registerVehicleInTx(c,'rider-id',{vehicle:'pickup',maxWeightG:900000,vehicleDetails});
 const record=calls.find(x=>x.sql.includes('INSERT INTO rider_vehicle_registrations'));
 assert.equal(record.values[1],'pickup');
 assert.equal(record.values[6],950000);
 assert.equal(record.values[7],'open');
 assert.equal(record.values[8],'2027-10-01');
 assert.equal(record.values[9],'2027-11-01');
});

test('long vehicle payload remains an integer gram value through thirty tonnes',async()=>{
 const calls=[];
 const c={async query(sql,values){calls.push({sql,values});return {rows:[],rowCount:1};}};
 await registerVehicleInTx(c,'long-rider',{vehicle:'long_vehicle',maxWeightG:30000000,vehicleDetails:{plateNumber:'GT 2345-26',make:'MAN',model:'TGX',color:'Blue',payloadCapacityG:30000000,bodyType:'flatbed',roadworthyExpiresOn:'2027-10-01',insuranceExpiresOn:'2027-11-01'}});
 assert.equal(calls.find(x=>x.sql.includes('UPDATE riders SET vehicle')).values[2],30000000);
});

test('cargo registration refuses expired roadworthy or insurance dates',async()=>{
 const details={plateNumber:'GT 2345-26',make:'Toyota',model:'Hilux',color:'White',payloadCapacityG:950000,bodyType:'open',roadworthyExpiresOn:'2020-01-01',insuranceExpiresOn:'2027-11-01'};
 await assert.rejects(()=>registerVehicleInTx({query:async()=>({rows:[],rowCount:1})},'rider-id',{vehicle:'pickup',maxWeightG:900000,vehicleDetails:details}),/expired/);
});

test('configured minimum vehicle licence is checked inside the riders module',async()=>{
 let calls=0;
 const match=await riderMeetsVehicleLicence({query:async(sql,values)=>{calls++;assert.match(sql,/FROM rider_licences/);assert.equal(values[1],'F3');return {rowCount:1};}},'rider-id','F3');
 assert.equal(match,true);assert.equal(calls,1);
 assert.equal(await riderMeetsVehicleLicence({query:async()=>({rowCount:0})},'rider-id','F3'),false);
 assert.equal(await riderMeetsVehicleLicence({query:async()=>{throw Error('should not query');}},'rider-id',null),true);
});

test('mobile quote contract preserves cargo class and dimensions',()=>{
 const pickup={address:'Makola Market, Accra',latitude:5.5428,longitude:-0.2064,customerConfirmed:true};
 const destination={address:'Kasoa New Market, Central Region',latitude:5.5367,longitude:-0.4215,customerConfirmed:true};
 const quote=buildParcelQuoteRequest({pickup,destination,vehicle:'box_truck',weightG:6800000,lengthCm:650,volumeL:24000,recipientPhone:'0241234567',description:'Shop stock'});
 assert.equal(quote.vehicle,'box_truck');assert.equal(quote.weightG,6800000);assert.equal(quote.lengthCm,650);assert.equal(quote.volumeL,24000);
});

test('mobile quote contract sends helper, floor and dispute-only declared value counts',()=>{
 const pickup={address:'East Legon, Accra',latitude:5.636,longitude:-0.157,customerConfirmed:true};
 const destination={address:'Spintex, Accra',latitude:5.625,longitude:-0.07,customerConfirmed:true};
 const quote=buildParcelQuoteRequest({pickup,destination,vehicle:'van',weightG:120000,lengthCm:180,volumeL:7000,helpers:2,pickupFloorsNoLift:1,dropoffFloorsNoLift:2,declaredGoodsValueMinor:250000,recipientPhone:'0241234567',description:'Household furniture'});
 assert.equal(quote.helpers,2);assert.equal(quote.pickupFloorsNoLift,1);assert.equal(quote.dropoffFloorsNoLift,2);assert.equal(quote.declaredGoodsValueMinor,250000);
 assert.equal('helperPriceMinor' in quote,false);assert.equal('floorPriceMinor' in quote,false);
});

test('admin portal exposes editable cargo class limits and launch switches',()=>{
 const html=renderAdminPortalHtml();
 for(const token of ['vehiclePolicyRows','maxLengthCm','maxVolumeL','minLicenceClass','scheduledDispatchLeadMinutes','/api/v1/admin/vehicle-policy'])assert.ok(html.includes(token),`missing admin vehicle control ${token}`);
});

test('cargo pricing migration seeds clearly marked zero-price placeholders and no liability cap',()=>{
 const sql=readFileSync('database/migrations/077_cargo_pricing_options.sql','utf8');
 for(const vehicle of ['tricycle','pickup','box_truck','long_vehicle'])assert.match(sql,new RegExp(`'${vehicle}'`));
 assert.match(sql,/is_placeholder boolean NOT NULL DEFAULT false/);
 assert.match(sql,/1300,true,true/);
 assert.match(sql,/liability_limit_minor integer CHECK\(liability_limit_minor IS NULL/);
 assert.match(sql,/free_loading_minutes/);
 assert.doesNotMatch(sql,/UPDATE pricing_policies SET[^;]*base_minor\s*=\s*[1-9]/s);
});

test('cargo tariff and liability controls are present in admin pricing',()=>{
 const html=renderAdminPortalHtml();
 for(const token of ['tariffHelper','tariffFloor','tariffLoading','cargoLiabilityCap','cargoLiabilityTerms','/api/v1/admin/cargo-policy','PLACEHOLDER'])assert.ok(html.includes(token),`missing admin cargo pricing control ${token}`);
});

test('startup reports which active cargo tariffs still need real staff prices',async()=>{
 const original=process.stderr.write;let warning='';
 process.stderr.write=chunk=>{warning+=chunk;return true;};
 try{await warnPlaceholderTariffs({query:async sql=>{assert.match(sql,/is_placeholder/);return {rows:[{vehicle:'box_truck'},{vehicle:'long_vehicle'}]};}});}
 finally{process.stderr.write=original;}
 const record=JSON.parse(warning);assert.equal(record.level,'warn');assert.equal(record.code,'placeholder_vehicle_tariffs');assert.deepEqual(record.vehicles,['box_truck','long_vehicle']);
});

test('declared goods value is never returned in rider delivery details',()=>{
 const shipment={state:'RIDER_ASSIGNED',details:{description:'Furniture',declaredGoodsValueMinor:250000,recipientPhone:'+233241234567'}};
 const view=hideEndedContacts({kind:'rider'},shipment);
 assert.equal(view.details.declaredGoodsValueMinor,undefined);
 assert.equal(view.details.recipientPhone,'+233241234567','normal in-progress contact remains available');
 const ended=hideEndedContacts({kind:'rider'},{...shipment,state:'COMPLETED',completed_at:'2020-01-01T00:00:00Z'});
 assert.equal(ended.details.declaredGoodsValueMinor,undefined);assert.equal(ended.details.recipientPhone,undefined);assert.equal(ended.recipient_phone,null);
});

test('migration seeds bounded cargo classes and leaves heavy classes disabled',()=>{
 const sql=readFileSync('database/migrations/076_cargo_vehicle_capabilities.sql','utf8');
 for(const token of ["WHEN 'tricycle' THEN 300000","WHEN 'tricycle' THEN 25000","WHEN 'pickup' THEN 1000000","WHEN 'pickup' THEN 300000","WHEN 'van' THEN 1500000","WHEN 'van' THEN 400000","7000000,600000","30000000,800000"])assert.ok(sql.includes(token));
 assert.match(sql,/UPDATE vehicle_capabilities SET enabled=false WHERE vehicle IN \('van','box_truck','long_vehicle','truck'\)/);
 assert.match(sql,/min_licence_class text/);
});

test('rider app captures cargo vehicle details and current paper expiry',()=>{
 const app=readFileSync('apps/mobile/src/rider/RiderApp.js','utf8');
 for(const token of ['box_truck','long_vehicle','plateNumber','payloadCapacityG','bodyType','roadworthyExpiresOn','insuranceExpiresOn'])assert.ok(app.includes(token),`missing rider app registration field ${token}`);
});
