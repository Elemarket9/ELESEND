import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerVehicleInTx,riderMeetsVehicleLicence} from '../services/api/modules/riders/vehicle.mjs';
import {buildParcelQuoteRequest} from '../apps/mobile/src/booking-contract.js';
import {renderAdminPortalHtml} from '../services/api/admin-web/admin-portal.mjs';

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

test('admin portal exposes editable cargo class limits and launch switches',()=>{
 const html=renderAdminPortalHtml();
 for(const token of ['vehiclePolicyRows','maxLengthCm','maxVolumeL','minLicenceClass','/api/v1/admin/vehicle-policy'])assert.ok(html.includes(token),`missing admin vehicle control ${token}`);
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
