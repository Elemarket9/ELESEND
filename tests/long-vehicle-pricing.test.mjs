import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculateLongVehicleQuote} from '../services/api/modules/orders/index.mjs';
import {renderAdminPortalHtml} from '../services/api/admin-web/admin-portal.mjs';

const tariff={base_minor:1000,per_km_minor:200,per_tonne_km_minor:50,minimum_minor:500,commission_bps:1000,return_leg_bps:5000,per_helper_minor:300,per_floor_minor:200,per_extra_stop_minor:100,booking_fee_bps:200,wait_per_minute_minor:60,free_loading_minutes:30,is_placeholder:false};

test('heavy-freight pricing independently charges road km, loaded tonne-km, helpers, floors and return leg',()=>{
 const q=calculateLongVehicleQuote(tariff,1000,{weightG:1000000,helpers:2,pickupFloors:1,dropoffFloors:2,extraStops:2,tollMinor:50});
 assert.equal(q.breakdown.distanceMeters,1500);
 assert.equal(q.breakdown.distanceMinor,300);
 assert.equal(q.breakdown.tonneKmMinor,50);
 assert.equal(q.breakdown.helperMinor,600);
 assert.equal(q.breakdown.floorMinor,600);
 assert.equal(q.breakdown.extraStopsMinor,200);
 assert.equal(q.breakdown.fareMinor,2750);
 assert.equal(q.breakdown.bookingFeeMinor,55);
 assert.equal(q.breakdown.tollMinor,50);
 assert.equal(q.amountMinor,2855);
 assert.equal(q.commissionMinor,330);
 assert.equal(q.riderEarningsMinor,2525);
 assert.equal(q.amountMinor,q.commissionMinor+q.riderEarningsMinor);
});

test('long freight calculations round upward in integer pesewas and enforce minimums',()=>{
 const q=calculateLongVehicleQuote({...tariff,base_minor:0,per_km_minor:0,per_tonne_km_minor:1,minimum_minor:1000,per_helper_minor:0,per_floor_minor:0,per_extra_stop_minor:0,commission_bps:0,booking_fee_bps:0,return_leg_bps:0},1,{weightG:1});
 assert.equal(q.breakdown.tonneKmMinor,1);
 assert.equal(q.breakdown.minimumApplied,true);
 assert.equal(q.amountMinor,1000);
});

test('heavy-freight engine refuses placeholders and unsafe or incomplete prices',()=>{
 assert.throws(()=>calculateLongVehicleQuote({...tariff,is_placeholder:true},1000,{weightG:1000}),/not configured/);
 assert.throws(()=>calculateLongVehicleQuote({...tariff,commission_bps:10001},1000,{weightG:1000}),/exceeds its limit/);
 assert.throws(()=>calculateLongVehicleQuote(tariff,1000,{weightG:-1}),/Invalid load weight/);
 assert.throws(()=>calculateLongVehicleQuote({...tariff,per_tonne_km_minor:null},1000,{weightG:1000}),/Invalid tonne-kilometre rate/);
});

test('long-vehicle rates use a separate editable policy and no final price is seeded',()=>{
 const sql=readFileSync('database/migrations/078_long_vehicle_pricing_engine.sql','utf8');
 assert.match(sql,/CREATE TABLE long_vehicle_pricing_policies/);
 assert.match(sql,/per_tonne_km_minor integer/);
 assert.match(sql,/return_leg_bps integer/);
 assert.match(sql,/ADD COLUMN long_vehicle_policy_id uuid REFERENCES long_vehicle_pricing_policies/);
 assert.match(sql,/is_placeholder boolean NOT NULL DEFAULT true/);
 assert.match(sql,/INSERT INTO long_vehicle_pricing_policies\(id,is_placeholder,active\)/);
 assert.doesNotMatch(sql,/base_minor\) VALUES[^;]*,[1-9]/s);
});

test('admin separates and explains the long-vehicle heavy-freight engine',()=>{
 const html=renderAdminPortalHtml();
 for(const token of ['/api/v1/admin/pricing/long-vehicle','loaded tonne-km charge','lvTonneKm','saveLongVehiclePricing','no long-vehicle quotes until all real rates are saved'])assert.ok(html.includes(token),`missing ${token}`);
});
