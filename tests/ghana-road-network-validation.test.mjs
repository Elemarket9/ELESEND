import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GHANA_GAZETTEER,
  ghanaSearch,
  ghanaReverseGeocode
} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';
import {
  calculateCargoSurcharge,
  calculateLongPickupAllowance,
  smoothRushHourMultiplier,
  calculateDynamicDeliveryQuote
} from '../services/api/infrastructure/pricing/unbeatable-pricing-engine.mjs';
import {calculateQuote} from '../services/api/pricing.mjs';
import {osrmRouting} from '../services/api/dispatch-routing.mjs';

test('Ghana Road Network & Intelligent Pricing Validation Suite', async t => {
  await t.test('1. Local Ghana Gazetteer & Address Resolution', () => {
    // Check known Accra, Kumasi and Tema landmarks
    const accraMall = ghanaSearch('Accra Mall');
    assert.ok(accraMall.length > 0);
    assert.equal(accraMall[0].name, 'Accra Mall');
    assert.ok(accraMall[0].latitude >= 5.6 && accraMall[0].latitude <= 5.7);

    const kejetia = ghanaSearch('Kejetia');
    assert.ok(kejetia.length > 0);
    assert.equal(kejetia[0].city, 'Kumasi');

    const tema = ghanaSearch('Tema Community 1');
    assert.ok(tema.length > 0);
    assert.equal(tema[0].city, 'Tema');

    // Reverse geocoding resolves nearest Ghanaian neighborhood
    const reverse = ghanaReverseGeocode(5.5562, -0.1825); // Osu Oxford St
    assert.ok(reverse);
    assert.equal(reverse.locality, 'Osu');
    assert.equal(reverse.city, 'Accra');
  });

  await t.test('2. Dynamic cargo surcharge in integer pesewas', () => {
    // Free up to 3kg for small parcel
    assert.equal(calculateCargoSurcharge({weightG: 1000, parcelSize: 'small'}), 0);
    assert.equal(calculateCargoSurcharge({weightG: 3000, parcelSize: 'small'}), 0);

    // Medium parcel has GH₵4.00 base size fee (400 pesewas)
    assert.equal(calculateCargoSurcharge({weightG: 2000, parcelSize: 'medium'}), 400);

    // Large parcel (800 pesewas) + 2kg excess over 3kg (2 * 100 = 200 pesewas) = 1000 pesewas (GH₵10.00)
    assert.equal(calculateCargoSurcharge({weightG: 5000, parcelSize: 'large'}), 1000);
  });

  await t.test('3. Long-pickup courier deadhead allowance', () => {
    // Within 2.5km: 0 extra allowance
    assert.equal(calculateLongPickupAllowance({pickupDistanceMeters: 2000, vehicle: 'motorcycle'}), 0);
    assert.equal(calculateLongPickupAllowance({pickupDistanceMeters: 2500, vehicle: 'motorcycle'}), 0);

    // 3.5km pickup (1km extra): GH₵2.00 (200 pesewas) for motorcycle
    assert.equal(calculateLongPickupAllowance({pickupDistanceMeters: 3500, vehicle: 'motorcycle'}), 200);

    // 4.5km pickup (2km extra): GH₵4.00 (400 pesewas) for motorcycle
    assert.equal(calculateLongPickupAllowance({pickupDistanceMeters: 4500, vehicle: 'motorcycle'}), 400);

    // Car rate: GH₵3.00 (300 pesewas) per extra km
    assert.equal(calculateLongPickupAllowance({pickupDistanceMeters: 3500, vehicle: 'car'}), 300);
  });

  await t.test('4. Smooth continuous rush-hour multiplier without cliffs', () => {
    // Midday (12:00 PM GMT): baseline 1.0x (10,000 bps)
    const midday = new Date('2026-10-20T12:00:00Z');
    assert.equal(smoothRushHourMultiplier(midday), 10000);

    // Morning peak around 08:00 AM GMT: ~1.4x (~14,000 bps)
    const morningRush = new Date('2026-10-20T08:00:00Z');
    const morningMult = smoothRushHourMultiplier(morningRush);
    assert.ok(morningMult >= 13500 && morningMult <= 14000);

    // Evening peak around 17:45 GMT: ~1.4x (~14,000 bps)
    const eveningRush = new Date('2026-10-20T17:45:00Z');
    const eveningMult = smoothRushHourMultiplier(eveningRush);
    assert.ok(eveningMult >= 13500 && eveningMult <= 14000);
  });

  await t.test('5. Unbeatable dynamic delivery pricing with driver retention superiority', () => {
    const policy = {
      base_minor: 1200,      // GH₵12.00
      per_km_minor: 320,     // GH₵3.20/km
      per_minute_minor: 25,  // GH₵0.25/min
      minimum_minor: 2000,   // GH₵20.00
      commission_bps: 1300   // 13% platform delivery commission
    };

    const quote = calculateDynamicDeliveryQuote({
      policy,
      distanceMeters: 5000,    // 5.0 km
      durationSeconds: 900,    // 15 minutes
      vehicle: 'motorcycle',
      weightG: 2000,
      parcelSize: 'small',
      pickupDistanceMeters: 3500, // 1km long-pickup deadhead allowance (+200 pesewas)
      isRaining: true,            // Rain compensation (+500 pesewas)
      now: new Date('2026-10-20T12:00:00Z')
    });

    assert.ok(quote.amountMinor > 0);
    // Platform commission is exactly 13%
    assert.equal(quote.commissionRatePercent, 13.0);
    assert.equal(quote.commissionMinor, Math.round((quote.amountMinor * 1300) / 10000));
    assert.equal(quote.riderEarningsMinor, quote.amountMinor - quote.commissionMinor);

    // Driver retains 87% of fare vs Bolt (80%) and Yango (82%)
    const driverRetentionBps = Math.round((quote.riderEarningsMinor / quote.amountMinor) * 10000);
    assert.ok(driverRetentionBps >= 8650); // ~87%
  });

  await t.test('6. OSRM routing client handles disconnected road gracefully and fails closed', async () => {
    // Mock fetch that simulates unreachable road (e.g. islands or missing network)
    const unreachableFetch = async () => new Response(JSON.stringify({code: 'NoRoute', routes: []}), {
      status: 200,
      headers: {'Content-Type': 'application/json'}
    });

    const client = osrmRouting({
      endpoint: 'http://127.0.0.1:5000',
      profiles: {car: 'car', motorcycle: 'motorcycle'},
      fetchImpl: unreachableFetch
    });

    // Unconnected destination must throw status 422, never fabricate straight-line distance
    await assert.rejects(
      () => client.route({latitude: 5.55, longitude: -0.18}, {latitude: 5.60, longitude: -0.17}, {vehicle: 'motorcycle'}),
      {status: 422}
    );
  });
});
