import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../services/api/db.mjs';
import { platform } from '../services/api/platform.mjs';
import { migrate } from '../scripts/migrate.mjs';
import { dispatchEngine } from '../services/api/dispatch.mjs';
import { fixtureRouting } from '../services/api/dispatch-routing.mjs';
import { haversine } from '../services/api/dispatch-geometry.mjs';
import { resetDispatchFixtures } from './helpers/reset-dispatch-fixtures.mjs';
import { restaurantService } from '../services/api/restaurant.mjs';
import { restaurantOrderService } from '../services/api/restaurant-orders.mjs';
import { ghanaReverseGeocode, ghanaSearch } from '../services/api/infrastructure/maps/ghana-geocoder.mjs';
import {
  detectCustomerLocation,
  validateCoordinates,
  evaluateGpsQuality,
  formatAccuracyLabel,
  buildConfirmedLocation,
  GHANA_SERVICE_ENVELOPE,
  ACCURACY_TIERS
} from '../apps/mobile/src/customer-location.js';

const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl || !/^elesend_test(?:_|$)/.test(new URL(testDbUrl).pathname.slice(1))) {
  throw Error('TEST_DATABASE_URL must point to a dedicated elesend_test database');
}

const db = database(testDbUrl);
const otpKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const roadRouting = fixtureRouting(async (a, b) => {
  const dMeters = Math.ceil(haversine(a, b) * 1.35);
  const durSec = Math.max(1, Math.ceil(dMeters / 8.33));
  return {
    distanceMeters: dMeters,
    durationSeconds: durSec,
    geometry: {
      type: 'LineString',
      coordinates: [[a.longitude, a.latitude], [b.longitude, b.latitude]]
    }
  };
});

const smsMessages = [];
const sms = {
  send: async (to, body) => {
    smsMessages.push({ to, body });
    return { ok: true, messageId: randomUUID() };
  }
};

const dispatcher = dispatchEngine(db, { routing: roadRouting });
const app = platform(db, { otpKey, sms, dispatch: dispatcher, routing: roadRouting });
const restService = restaurantService(db);
const restOrders = restaurantOrderService(db, { platform: app, dispatcher, routing: roadRouting });

test('Customer Location 1 — Foreground GPS Permission, Timeout & Denial Handling', async () => {
  // A. Permission Denied by Customer
  const mockLocationDenied = {
    hasServicesEnabledAsync: async () => true,
    requestForegroundPermissionsAsync: async () => ({ status: 'denied', granted: false })
  };

  const deniedResult = await detectCustomerLocation({ locationApi: mockLocationDenied });
  assert.equal(deniedResult.ok, false);
  assert.equal(deniedResult.error, 'permission_denied');
  assert.match(deniedResult.message, /Location permission was denied/);

  // B. Location Services Disabled on Device
  const mockServicesDisabled = {
    hasServicesEnabledAsync: async () => false,
    requestForegroundPermissionsAsync: async () => ({ status: 'granted', granted: true })
  };

  const disabledResult = await detectCustomerLocation({ locationApi: mockServicesDisabled });
  assert.equal(disabledResult.ok, false);
  assert.equal(disabledResult.error, 'services_disabled');
  assert.match(disabledResult.message, /GPS location services are disabled/);

  // C. GPS Acquisition Timeout
  const mockTimeout = {
    hasServicesEnabledAsync: async () => true,
    requestForegroundPermissionsAsync: async () => ({ status: 'granted', granted: true }),
    getCurrentPositionAsync: () => new Promise(resolve => setTimeout(resolve, 500))
  };

  const timeoutResult = await detectCustomerLocation({ locationApi: mockTimeout, timeoutMs: 50 });
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.error, 'acquisition_failed');
  assert.match(timeoutResult.message, /Could not obtain GPS position in time/);

  // D. Permission Granted Successfully
  const mockSuccess = {
    hasServicesEnabledAsync: async () => true,
    requestForegroundPermissionsAsync: async () => ({ status: 'granted', granted: true }),
    getCurrentPositionAsync: async () => ({
      coords: { latitude: 5.6037, longitude: -0.1870, accuracy: 12 },
      timestamp: Date.now()
    })
  };

  const successResult = await detectCustomerLocation({ locationApi: mockSuccess });
  assert.equal(successResult.ok, true);
  assert.equal(successResult.coordinates.latitude, 5.6037);
  assert.equal(successResult.coordinates.longitude, -0.1870);
  assert.equal(successResult.accuracyMeters, 12);
  assert.equal(successResult.accuracyTier, ACCURACY_TIERS.HIGH);
});

test('Customer Location 2 — Coordinate Bounds & Ghana Service Area Validation', () => {
  // A. Valid Ghana Coordinates (Accra, Kasoa, Kumasi, Sunyani)
  assert.equal(validateCoordinates({ latitude: 5.6037, longitude: -0.1870 }).valid, true);
  assert.equal(validateCoordinates({ latitude: 5.5398, longitude: -0.4485 }).valid, true);
  assert.equal(validateCoordinates({ latitude: 6.6961, longitude: -1.6244 }).valid, true);
  assert.equal(validateCoordinates({ latitude: 7.3412, longitude: -2.3312 }).valid, true);

  // B. Coordinates Outside Ghana Service Envelope
  const london = validateCoordinates({ latitude: 51.5074, longitude: -0.1278 });
  assert.equal(london.valid, false);
  assert.equal(london.outsideCoverage, true);

  const oceanNullIsland = validateCoordinates({ latitude: 0.0, longitude: 0.0 });
  assert.equal(oceanNullIsland.valid, false);
  assert.equal(oceanNullIsland.outsideCoverage, true);

  // C. Malformed / Non-numeric Coordinates
  assert.equal(validateCoordinates(null).valid, false);
  assert.equal(validateCoordinates({ latitude: 'invalid', longitude: -0.18 }).valid, false);
  assert.equal(validateCoordinates({ latitude: NaN, longitude: -0.18 }).valid, false);
  assert.equal(validateCoordinates({ latitude: 95.0, longitude: -0.18 }).valid, false);
});

test('Customer Location 3 — GPS Accuracy Tiering & Quality Evaluation', () => {
  // High Accuracy (<= 25m)
  const high = evaluateGpsQuality({ accuracy: 8, timestamp: Date.now() });
  assert.equal(high.tier, ACCURACY_TIERS.HIGH);
  assert.equal(high.accuracyMeters, 8);
  assert.equal(high.isFresh, true);
  assert.equal(formatAccuracyLabel(8), '±8m (High accuracy)');

  // Moderate Accuracy (25m - 100m)
  const mod = evaluateGpsQuality({ accuracy: 45, timestamp: Date.now() });
  assert.equal(mod.tier, ACCURACY_TIERS.MODERATE);
  assert.equal(formatAccuracyLabel(45), '±45m (Street level)');

  // Approximate (> 100m)
  const approx = evaluateGpsQuality({ accuracy: 180, timestamp: Date.now() });
  assert.equal(approx.tier, ACCURACY_TIERS.APPROXIMATE);
  assert.match(approx.advisory, /drag the pin to your exact building/);
  assert.equal(formatAccuracyLabel(180), '±180m (Approximate)');

  // Stale Location Detection
  const stale = evaluateGpsQuality({ accuracy: 15, timestamp: Date.now() - 300000 });
  assert.equal(stale.isFresh, false);
});

test('Customer Location 4 — Private Reverse Geocoding & Community Identification', async () => {
  // 1. Detect location near Kasoa New Market
  const mockGpsKasoa = {
    hasServicesEnabledAsync: async () => true,
    requestForegroundPermissionsAsync: async () => ({ status: 'granted', granted: true }),
    getCurrentPositionAsync: async () => ({
      coords: { latitude: 5.5367, longitude: -0.4215, accuracy: 14 },
      timestamp: Date.now()
    })
  };

  const result = await detectCustomerLocation({
    locationApi: mockGpsKasoa,
    reverseGeocodeApi: async (lat, lon) => ghanaReverseGeocode(lat, lon)
  });

  assert.equal(result.ok, true);
  assert.equal(result.recognizedNearby, 'Kasoa Toll Booth / New Market');
  assert.equal(result.region, 'Central');
  assert.match(result.displayAddress, /Kasoa/);
  assert.equal(result.accuracyLabel, '±14m (High accuracy)');

  // 2. Reverse geocoder outage / failure resilience (does NOT crash or block flow)
  const resultWithFailingGeocoder = await detectCustomerLocation({
    locationApi: mockGpsKasoa,
    reverseGeocodeApi: async () => { throw new Error('Private geocoder timeout'); }
  });

  assert.equal(resultWithFailingGeocoder.ok, true);
  assert.match(resultWithFailingGeocoder.displayAddress, /Pin: 5.5367, -0.4215/);
});

test('Customer Location 5 — Exact Manual Pin Adjustment Takes Precedence over GPS', () => {
  // Initial GPS estimate: center of street
  const gpsEstimate = { latitude: 5.5367, longitude: -0.4215 };
  
  // Customer adjusts pin 35 meters south to their specific compound entrance
  const userAdjustedPin = { latitude: 5.5364, longitude: -0.4215 };
  const customInstructions = 'Blue gate opposite the cold store, ring bell';

  const confirmedLocation = buildConfirmedLocation({
    coordinates: userAdjustedPin,
    displayAddress: 'Near Kasoa New Market, Central Region',
    reverseGeocode: { locality: 'Kasoa', city: 'Kasoa', region: 'Central', nearestPlace: 'Kasoa New Market' },
    manualInstructions: customInstructions,
    isAdjusted: true
  });

  assert.equal(confirmedLocation.latitude, 5.5364, 'Confirmed latitude must equal customer-adjusted pin, not GPS centroid');
  assert.equal(confirmedLocation.longitude, -0.4215);
  assert.equal(confirmedLocation.manuallyAdjusted, true);
  assert.equal(confirmedLocation.instructions, customInstructions);
  assert.match(confirmedLocation.address, /Blue gate opposite the cold store/);
});

test('Customer Location 6 — End-to-End Parcel Delivery Booking with GPS Detected Coordinates & OSRM Routing', async () => {
  await migrate(db);
  await db.query('TRUNCATE users,pricing_policies,shipments,quotes,cash_collections RESTART IDENTITY CASCADE');
  await resetDispatchFixtures(db);

  // Active motorcycle policy: 13% commission
  await db.query(`
    INSERT INTO pricing_policies (id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor, commission_bps, active)
    VALUES (gen_random_uuid(), 'motorcycle', 1200, 320, 25, 2000, 1300, true)
    ON CONFLICT (vehicle) WHERE active AND vehicle IS NOT NULL DO UPDATE SET base_minor=1200, per_km_minor=320, per_minute_minor=25, minimum_minor=2000, commission_bps=1300
  `);

  const pw = 'Customer-Pass-2026!';
  const customer = await app.register({ phone: '0245000101', password: pw, kind: 'customer' });
  await db.query("UPDATE users SET phone_verified_at=now() WHERE id=$1", [customer.id]);

  // Customer uses GPS to detect pickup at Kasoa New Market
  const pickupLocation = buildConfirmedLocation({
    coordinates: { latitude: 5.5367, longitude: -0.4215 },
    displayAddress: 'Kasoa New Market, Central Region',
    reverseGeocode: { locality: 'Kasoa', city: 'Kasoa', region: 'Central' }
  });

  // Customer selects destination at Budumburam Camp Liberia
  const dropoffLocation = {
    latitude: 5.5385,
    longitude: -0.4725,
    address: 'Budumburam Camp Liberia, Central Region'
  };

  // Quote shipment using confirmed coordinates
  const quote = await app.quote(customer, {
    pickup: {
      latitude: pickupLocation.latitude,
      longitude: pickupLocation.longitude,
      address: pickupLocation.address
    },
    destination: {
      latitude: dropoffLocation.latitude,
      longitude: dropoffLocation.longitude,
      address: dropoffLocation.address
    },
    vehicle: 'motorcycle',
    recipientPhone: '0245000102',
    weightG: 2000,
    description: 'Electrical supplies',
    parcelCategory: 'general',
    parcelSize: 'small',
    paymentMethod: 'CASH',
    cashPayer: 'recipient'
  });

  assert.ok(quote.id);
  assert.ok(quote.amount_minor >= 2000);
  assert.equal(quote.commission_minor, Math.round(quote.amount_minor * 0.13));

  // Book shipment with idempotency key
  const shipment = await app.book(customer, { quoteId: quote.id }, 'booking-cust-gps-1');
  assert.equal(shipment.state, 'AWAITING_ASSIGNMENT');

  const quoteRow = (await db.query('SELECT request FROM quotes WHERE id=$1', [quote.id])).rows[0];
  assert.equal(quoteRow.request.pickup.latitude, 5.5367);
  assert.equal(quoteRow.request.destination.latitude, 5.5385);
});

test('Customer Location 7 — Restaurant Food Order Checkout Integration with Detected Location', async () => {
  await migrate(db);
  await resetDispatchFixtures(db);

  const pw = 'RestOwner-Pass-2026!';
  const owner = await app.register({ phone: '0245000201', password: pw, kind: 'business' });
  const cust = await app.register({ phone: '0245000202', password: pw, kind: 'customer' });

  // Restaurant in Kasoa
  const rest = await restService.createRestaurant(owner, {
    name: 'Kasoa Fast Chop',
    phone: '0245000201',
    address: 'Near Kasoa New Market, Central Region',
    latitude: 5.5370,
    longitude: -0.4220,
    cuisine: 'Ghanaian'
  });

  const cat = await restService.createCategory(owner, rest.id, { name: 'Main Dishes' });
  const item = await restService.createMenuItem(owner, rest.id, {
    categoryId: cat.id,
    name: 'Jollof with Fried Fish',
    priceMinor: 4500
  });

  // Customer detects their current GPS location for food delivery
  const detectedCustGps = { latitude: 5.5395, longitude: -0.4350 };
  const confirmedCustAddress = 'House 4, CP Junction, Kasoa [Instructions: Call at gate]';

  // Calculate food delivery quote
  const foodQuote = await restOrders.quoteFoodOrder(cust, {
    restaurantId: rest.id,
    items: [{ itemId: item.id, quantity: 1, options: [] }],
    deliveryAddress: confirmedCustAddress,
    deliveryLatitude: detectedCustGps.latitude,
    deliveryLongitude: detectedCustGps.longitude,
    customerPhone: '0245000202'
  });

  assert.ok(foodQuote.totalMinor > 4500);
  assert.ok(foodQuote.deliveryFeeMinor > 0);
  assert.ok(foodQuote.estimatedPrepMinutes <= 30);

  // Place food order
  const foodOrder = await restOrders.createFoodOrder(cust, foodQuote, {
    paymentMethod: 'CASH',
    specialInstructions: 'Extra shito please'
  });

  assert.equal(foodOrder.state, 'SUBMITTED');
  assert.equal(foodOrder.delivery_address, confirmedCustAddress);
  assert.equal(foodOrder.delivery_latitude, 5.5395);
  assert.equal(foodOrder.delivery_longitude, -0.4350);
});

test('Customer Location 8 — Paid-Order Address Immutability & Customer Privacy Constraints', async () => {
  await migrate(db);
  const pw = 'TestSecure-2026!';
  const customer = await app.register({ phone: '0245000301', password: pw, kind: 'customer' });
  await db.query("UPDATE users SET phone_verified_at=now() WHERE id=$1", [customer.id]);

  // Ensure active motorcycle pricing policy
  await db.query(`
    INSERT INTO pricing_policies (id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor, commission_bps, active)
    VALUES (gen_random_uuid(), 'motorcycle', 1200, 320, 25, 2000, 1300, true)
    ON CONFLICT (vehicle) WHERE active AND vehicle IS NOT NULL DO NOTHING
  `);

  const quote = await app.quote(customer, {
    pickup: { latitude: 5.5367, longitude: -0.4215, address: 'Initial Pickup Address' },
    destination: { latitude: 5.5385, longitude: -0.4725, address: 'Initial Delivery Address' },
    vehicle: 'motorcycle',
    recipientPhone: '0245000302',
    weightG: 1000,
    description: 'Document folder',
    paymentMethod: 'CASH'
  });

  const shipment = await app.book(customer, { quoteId: quote.id }, 'booking-cust-gps-2');
  assert.equal(shipment.state, 'AWAITING_ASSIGNMENT');

  // Verify quotes table trigger prevents modifying terms/destination on accepted quotes
  await assert.rejects(
    () => db.query(
      `UPDATE quotes SET request = jsonb_set(request, '{destination,address}', '"Hacked Destination Address"') WHERE id=$1`,
      [quote.id]
    ),
    /Quote terms and evidence are immutable/
  );

  // Customer dispute process must be used for exceptional address correction
  const dispute = await app.dispute(customer, shipment.id, {
    category: 'address',
    detail: 'Customer entered wrong compound name; please verify with customer'
  });
  assert.ok(dispute.id);
  const disputeRow = (await db.query('SELECT * FROM disputes WHERE id=$1', [dispute.id])).rows[0];
  assert.equal(disputeRow.category, 'address');
  assert.equal(disputeRow.shipment_id, shipment.id);
});
