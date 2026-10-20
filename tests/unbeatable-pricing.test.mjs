import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 calculateCargoSurcharge,
 calculateLongPickupAllowance,
 smoothRushHourMultiplier,
 calculateDynamicDeliveryQuote
} from '../services/api/infrastructure/pricing/unbeatable-pricing-engine.mjs';

const policy={
 id:'00000000-0000-0000-0000-000000000001',
 vehicle:'motorcycle',
 base_minor:1200, // GH₵12.00
 per_km_minor:320, // GH₵3.20/km
 per_minute_minor:25, // GH₵0.25/min
 minimum_minor:2000, // GH₵20.00
 commission_bps:300, // 3%
 commission_mode:'percentage',
 commission_fixed_minor:0,
 commission_cap_minor:null,
 rush_hour_enabled:true
};

test('cargo surcharge applies tiered size and excess weight in integer pesewas',()=>{
 assert.equal(calculateCargoSurcharge({weightG:1000,parcelSize:'small'}),0);
 assert.equal(calculateCargoSurcharge({weightG:2000,parcelSize:'medium'}),400); // GH₵4.00
 assert.equal(calculateCargoSurcharge({weightG:2000,parcelSize:'large'}),800); // GH₵8.00
 // 5kg = 2kg excess over 3kg threshold => 2 * 100 = 200 pesewas + 800 large = 1000 pesewas (GH₵10.00)
 assert.equal(calculateCargoSurcharge({weightG:5000,parcelSize:'large'}),1000);
});

test('long-pickup allowance compensates couriers for pickups over 2.5km',()=>{
 assert.equal(calculateLongPickupAllowance({pickupDistanceMeters:1500,vehicle:'motorcycle'}),0);
 assert.equal(calculateLongPickupAllowance({pickupDistanceMeters:2500,vehicle:'motorcycle'}),0);
 // 3.5km pickup => 1 extra km at GH₵2.00/km (200 pesewas)
 assert.equal(calculateLongPickupAllowance({pickupDistanceMeters:3500,vehicle:'motorcycle'}),200);
 // 4.2km pickup => 2 extra km at GH₵2.00/km = 400 pesewas
 assert.equal(calculateLongPickupAllowance({pickupDistanceMeters:4200,vehicle:'motorcycle'}),400);
 // Car rate is GH₵3.00/km => 2 * 300 = 600 pesewas
 assert.equal(calculateLongPickupAllowance({pickupDistanceMeters:4200,vehicle:'car'}),600);
});

test('smooth continuous rush hour peaks in morning and evening without cliffs',()=>{
 // Off-peak (14:00 UTC = 14:00 Accra time)
 const offPeak=new Date('2026-10-20T14:00:00Z');
 assert.equal(smoothRushHourMultiplier(offPeak),10000); // 1.0x

 // Morning peak (08:00 Accra time)
 const morningPeak=new Date('2026-10-20T08:00:00Z');
 const morningMult=smoothRushHourMultiplier(morningPeak);
 assert.ok(morningMult>=13500&&morningMult<=14000,'Morning peak multiplier should be ~1.4x');

 // Evening peak (17:45 Accra time)
 const eveningPeak=new Date('2026-10-20T17:45:00Z');
 const eveningMult=smoothRushHourMultiplier(eveningPeak);
 assert.ok(eveningMult>=13500&&eveningMult<=14000,'Evening peak multiplier should be ~1.4x');
});

test('dynamic pricing engine delivers unbeatable driver net cash vs Bolt and Yango',()=>{
 const quote=calculateDynamicDeliveryQuote({
  policy,
  distanceMeters:8000, // 8 km
  durationSeconds:1200, // 20 min
  vehicle:'motorcycle',
  weightG:2000,
  parcelSize:'small',
  pickupDistanceMeters:1000,
  isRaining:false,
  now:new Date('2026-10-20T14:00:00Z') // Off-peak
 });

 // Base: 1200, Dist: 8 * 320 = 2560, Time: 20 * 25 = 500 => Subtotal: 4260 pesewas (GH₵42.60)
 assert.equal(quote.amountMinor,4260);
 // ELESEND 3% commission on 4260 = (4260 * 300 + 5000) / 10000 = 128 pesewas (GH₵1.28)
 assert.equal(quote.commissionMinor,128);
 // Driver takes 4260 - 128 = 4132 pesewas (GH₵41.32)
 assert.equal(quote.riderEarningsMinor,4132);
 assert.equal(quote.driverEarningsGhs,41.32);

 // On Bolt (20% commission), driver would only take 80% of GH₵42.60 = GH₵34.08
 assert.equal(quote.competitiveComparison.boltEstimatedDriverEarningsGhs,34.08);
 // On Yango (18% commission), driver would take 82% of GH₵42.60 = GH₵34.93
 assert.equal(quote.competitiveComparison.yangoEstimatedDriverEarningsGhs,34.93);

 // ELESEND driver makes +GH₵7.24 more on this single trip!
 assert.equal(quote.competitiveComparison.elesendDriverAdvantageGhs,7.24);
 assert.ok(quote.driverEarningsGhs>quote.competitiveComparison.boltEstimatedDriverEarningsGhs);
 assert.ok(quote.driverEarningsGhs>quote.competitiveComparison.yangoEstimatedDriverEarningsGhs);
});

test('dynamic pricing engine reflects custom administrator commission policies',()=>{
 const customPolicy={
  ...policy,
  commission_bps:500, // 5%
  commission_mode:'hybrid',
  commission_fixed_minor:100, // GH₵1.00 fixed
  commission_cap_minor:300 // Max GH₵3.00 cap
 };

 const quote=calculateDynamicDeliveryQuote({
  policy:customPolicy,
  distanceMeters:5000,
  durationSeconds:600,
  vehicle:'motorcycle',
  now:new Date('2026-10-20T14:00:00Z')
 });

 assert.equal(quote.commissionRatePercent,5.0);
 // Subtotal: 1200 (base) + 1600 (5km) + 250 (10min) = 3050 pesewas
 // 5% of 3050 = 153 pesewas + 100 fixed = 253 pesewas. Since 253 < cap (300), commission is 253 pesewas
 assert.equal(quote.commissionMinor,253);
});
