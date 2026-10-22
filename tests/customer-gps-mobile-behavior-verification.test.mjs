import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

// Deterministic road routing simulating real Ghana road geometry & winding factor
const roadRouting = fixtureRouting(async (a, b) => {
  const dMeters = Math.ceil(haversine(a, b) * 1.32);
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
  send: async (input) => {
    smsMessages.push(input);
    return { ok: true, messageId: randomUUID() };
  }
};

const dispatcher = dispatchEngine(db, { routing: roadRouting });
const app = platform(db, { otpKey, sms, dispatch: dispatcher, routing: roadRouting });
const restService = restaurantService(db);
const restOrders = restaurantOrderService(db, { platform: app, dispatcher, routing: roadRouting });

test('Mobile GPS 1 — Native Dependencies & Android Permission Configuration Audit', () => {
  const projectRoot = process.cwd();

  // 1. Check package.json dependencies
  const pkgPath = path.join(projectRoot, 'apps', 'mobile', 'package.json');
  assert.ok(fs.existsSync(pkgPath), 'apps/mobile/package.json must exist');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.ok(pkg.dependencies['expo-location'], 'expo-location must be declared in package.json');
  assert.ok(pkg.dependencies['@maplibre/maplibre-react-native'], '@maplibre/maplibre-react-native must be declared');

  // 2. Check AndroidManifest.xml permissions
  const manifestPath = path.join(projectRoot, 'apps', 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  assert.ok(fs.existsSync(manifestPath), 'AndroidManifest.xml must exist');
  const manifestXml = fs.readFileSync(manifestPath, 'utf8');

  assert.match(manifestXml, /android\.permission\.ACCESS_FINE_LOCATION/, 'AndroidManifest must declare ACCESS_FINE_LOCATION');
  assert.match(manifestXml, /android\.permission\.ACCESS_COARSE_LOCATION/, 'AndroidManifest must declare ACCESS_COARSE_LOCATION');
  assert.match(manifestXml, /android\.permission\.INTERNET/, 'AndroidManifest must declare INTERNET');

  // 3. Verify Customer Location code does NOT request background location
  const custLocCode = fs.readFileSync(path.join(projectRoot, 'apps', 'mobile', 'src', 'customer-location.js'), 'utf8');
  assert.doesNotMatch(custLocCode, /requestBackgroundPermissionsAsync/, 'Customer location detection must NEVER request background location');
  assert.match(custLocCode, /requestForegroundPermissionsAsync/, 'Customer location detection must explicitly request foreground permission');
});

test('Mobile GPS 2 — Foreground Permission States, Denial & Device Service Inactive', async () => {
  // A. Permission Denied by Customer
  const mockDenied = {
    hasServicesEnabledAsync: async () => true,
    requestForegroundPermissionsAsync: async () => ({ status: 'denied', granted: false })
  };
  const deniedRes = await detectCustomerLocation({ locationApi: mockDenied });
  assert.equal(deniedRes.ok, false);
  assert.equal(deniedRes.error, 'permission_denied');
  assert.match(deniedRes.message, /Location permission was denied/);

  // B. Location Services (GPS chip / Master switch) Disabled on Device
  const mockServicesOff = {
    hasServicesEnabledAsync: async () => false,
    requestForegroundPermissionsAsync: async () => ({ status: 'granted', granted: true })
  };
  const offRes = await detectCustomerLocation({ locationApi: mockServicesOff });
  assert.equal(offRes.ok, false);
  assert.equal(offRes.error, 'services_disabled');
  assert.match(offRes.message, /GPS location services are disabled on your device/);

  // C. GPS Acquisition Timeout
  const mockTimeout = {
    hasServicesEnabledAsync: async () => true,
    requestForegroundPermissionsAsync: async () => ({ status: 'granted', granted: true }),
    getCurrentPositionAsync: () => new Promise(res => setTimeout(res, 200))
  };
  const timeoutRes = await detectCustomerLocation({ locationApi: mockTimeout, timeoutMs: 30 });
  assert.equal(timeoutRes.ok, false);
  assert.equal(timeoutRes.error, 'acquisition_failed');
  assert.match(timeoutRes.message, /Could not obtain GPS position in time/);
});

test('Mobile GPS 3 — GPS Accuracy Evaluation & Out-of-Service Bounds Handling', () => {
  // High Accuracy (<= 25m)
  const qHigh = evaluateGpsQuality({ accuracy: 12, timestamp: Date.now() });
  assert.equal(qHigh.tier, ACCURACY_TIERS.HIGH);
  assert.equal(qHigh.accuracyMeters, 12);
  assert.equal(qHigh.isFresh, true);
  assert.equal(formatAccuracyLabel(12), '±12m (High accuracy)');

  // Moderate Accuracy (25m - 100m)
  const qMod = evaluateGpsQuality({ accuracy: 65, timestamp: Date.now() });
  assert.equal(qMod.tier, ACCURACY_TIERS.MODERATE);
  assert.equal(formatAccuracyLabel(65), '±65m (Street level)');

  // Approximate (> 100m)
  const qApprox = evaluateGpsQuality({ accuracy: 250, timestamp: Date.now() });
  assert.equal(qApprox.tier, ACCURACY_TIERS.APPROXIMATE);
  assert.match(qApprox.advisory, /drag the pin to your exact building or entrance/);
  assert.equal(formatAccuracyLabel(250), '±250m (Approximate)');

  // Stale Location Detection (> 120s)
  const qStale = evaluateGpsQuality({ accuracy: 10, timestamp: Date.now() - 180000 });
  assert.equal(qStale.isFresh, false);

  // Out of Ghana Service Area
  const london = validateCoordinates({ latitude: 51.5074, longitude: -0.1278 });
  assert.equal(london.valid, false);
  assert.equal(london.outsideCoverage, true);

  const atlanticOcean = validateCoordinates({ latitude: 0.0, longitude: 0.0 });
  assert.equal(atlanticOcean.valid, false);
  assert.equal(atlanticOcean.outsideCoverage, true);

  // Within Ghana Operational Service Area
  assert.equal(validateCoordinates({ latitude: 5.6037, longitude: -0.1870 }).valid, true); // Accra
  assert.equal(validateCoordinates({ latitude: 5.5398, longitude: -0.4485 }).valid, true); // Kasoa
  assert.equal(validateCoordinates({ latitude: 6.6961, longitude: -1.6244 }).valid, true); // Kumasi
});

test('Mobile GPS 4 — MapLibre Blue Current-Location Marker & Accuracy Halo Code Verification', () => {
  const projectRoot = process.cwd();
  const mapAdapterPath = path.join(projectRoot, 'apps', 'mobile', 'src', 'maps', 'map-adapter.js');
  assert.ok(fs.existsSync(mapAdapterPath), 'map-adapter.js must exist');
  const code = fs.readFileSync(mapAdapterPath, 'utf8');

  // 1. Verify CurrentLocationMarker definition and exports
  assert.match(code, /export function CurrentLocationMarker/, 'CurrentLocationMarker must be exported');
  assert.match(code, /MarkerView id=\{id\} coordinate=\{coordinate\(point\)\} anchor=\{\{x:0\.5,y:0\.5\}\}/, 'Marker must center on coordinate with anchor [0.5, 0.5]');

  // 2. Verify blue current-location dot and white border styling
  assert.match(code, /#0284C7/, 'Marker must use vibrant Sky Blue #0284C7 for the current location pin');
  assert.match(code, /borderColor:'#FFFFFF'/, 'Marker must have contrasting white border');

  // 3. Verify accuracy halo computation and styling
  assert.match(code, /Math\.min\(90,Math\.max\(32,Math\.round\(accuracy\*1\.4\)\)\)/, 'Halo size must scale with GPS accuracy between 32px and 90px');
  assert.match(code, /rgba\(56,189,248,0\.22\)/, 'Accuracy indicator must render translucent accuracy halo');
});

test('Mobile GPS 5 — Private Reverse Geocoding & Network Resilience', async () => {
  // A. Successful reverse geocoding via private ELESEND geocoder
  const mockGps = {
    hasServicesEnabledAsync: async () => true,
    requestForegroundPermissionsAsync: async () => ({ status: 'granted', granted: true }),
    getCurrentPositionAsync: async () => ({
      coords: { latitude: 5.5562, longitude: -0.1825, accuracy: 10 },
      timestamp: Date.now()
    })
  };

  const detected = await detectCustomerLocation({
    locationApi: mockGps,
    reverseGeocodeApi: async (lat, lon) => ghanaReverseGeocode(lat, lon)
  });

  assert.equal(detected.ok, true);
  assert.equal(detected.region, 'Greater Accra');
  assert.match(detected.displayAddress, /Osu/);
  assert.equal(detected.accuracyLabel, '±10m (High accuracy)');

  // B. Network Interruption / Backend Outage Resilience
  const offlineDetected = await detectCustomerLocation({
    locationApi: mockGps,
    reverseGeocodeApi: async () => { throw new Error('Network request failed'); }
  });

  assert.equal(offlineDetected.ok, true, 'GPS detection must succeed even when reverse geocode network fails');
  assert.match(offlineDetected.displayAddress, /Pin: 5\.5562, -0\.1825/, 'Must fall back gracefully to coordinate pin');
});

test('Mobile GPS 6 — Manual Pin Adjustment Precedence & Authoritative Quoting', async () => {
  await migrate(db);
  await resetDispatchFixtures(db);

  // Setup active motorcycle tariff
  await db.query(`
    INSERT INTO pricing_policies (id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor, commission_bps, active)
    VALUES (gen_random_uuid(), 'motorcycle', 1200, 320, 25, 2000, 1300, true)
    ON CONFLICT (vehicle) WHERE active AND vehicle IS NOT NULL DO UPDATE SET base_minor=1200, per_km_minor=320, per_minute_minor=25, minimum_minor=2000, commission_bps=1300
  `);

  const custPhone = '024' + Math.floor(1000000 + Math.random() * 8999999);
  const recipPhone = '024' + Math.floor(1000000 + Math.random() * 8999999);
  const customer = await app.register({ phone: custPhone, password: 'Pass-2026-Test!', kind: 'customer' });
  await db.query("UPDATE users SET phone_verified_at=now() WHERE id=$1", [customer.id]);

  // Initial GPS detection placed pin at centroid
  const rawGps = { latitude: 5.6037, longitude: -0.1870 };

  // Customer manually moves destination pin 1.2km east to specific office gate
  const adjustedDropoffPin = { latitude: 5.6045, longitude: -0.1760 };

  const confirmedDropoff = buildConfirmedLocation({
    coordinates: adjustedDropoffPin,
    displayAddress: 'Tetteh Quarshie Interchange / Accra Mall Gate 2',
    manualInstructions: 'Security gate near pedestrian footbridge',
    isAdjusted: true
  });

  assert.equal(confirmedDropoff.latitude, 5.6045);
  assert.equal(confirmedDropoff.longitude, -0.1760);
  assert.equal(confirmedDropoff.manuallyAdjusted, true);
  assert.match(confirmedDropoff.address, /Security gate near pedestrian footbridge/);

  // Request quote with customer's manually adjusted pin
  const pickup = { latitude: 5.5562, longitude: -0.1825, address: 'Osu Oxford Street' };
  const quote = await app.quote(customer, {
    pickup,
    destination: {
      latitude: confirmedDropoff.latitude,
      longitude: confirmedDropoff.longitude,
      address: confirmedDropoff.address
    },
    vehicle: 'motorcycle',
    recipientPhone: recipPhone,
    weightG: 1200,
    description: 'Corporate Documents',
    parcelCategory: 'documents',
    parcelSize: 'small',
    paymentMethod: 'CASH'
  });

  // Verify distance and quote are based strictly on adjustedDropoffPin
  assert.ok(quote.id);
  const quoteRow = (await db.query('SELECT request FROM quotes WHERE id=$1', [quote.id])).rows[0];
  assert.equal(quoteRow.request.destination.latitude, adjustedDropoffPin.latitude);
  assert.equal(quoteRow.request.destination.longitude, adjustedDropoffPin.longitude);
  assert.match(quoteRow.request.destination.address, /Accra Mall Gate 2/);

  // Book shipment and verify persistence
  const shipment = await app.book(customer, { quoteId: quote.id }, 'booking-cust-adj-pin-1');
  assert.equal(shipment.state, 'AWAITING_ASSIGNMENT');
  assert.equal(shipment.amount_minor, quote.amount_minor);
});

test('Mobile GPS 7 — Restaurant Food Delivery Flow with Detected GPS & Manual Pin', async () => {
  await migrate(db);
  await resetDispatchFixtures(db);

  const ownerPhone = '024' + Math.floor(1000000 + Math.random() * 8999999);
  const custPhone = '024' + Math.floor(1000000 + Math.random() * 8999999);
  const owner = await app.register({ phone: ownerPhone, password: 'Pass-2026-Test!', kind: 'business' });
  const customer = await app.register({ phone: custPhone, password: 'Pass-2026-Test!', kind: 'customer' });

  // Create restaurant in Airport Residential
  const rest = await restService.createRestaurant(owner, {
    name: 'Accra Gourmet Kitchen',
    phone: ownerPhone,
    address: 'Airport Residential Area, Accra',
    latitude: 5.6050,
    longitude: -0.1800,
    cuisine: 'Continental'
  });

  const cat = await restService.createCategory(owner, rest.id, { name: 'Pastas' });
  const item = await restService.createMenuItem(owner, rest.id, {
    categoryId: cat.id,
    name: 'Seafood Fettuccine',
    priceMinor: 6500
  });

  // Customer uses GPS detection + manual pin adjustment for food drop-off
  const detectedCoords = { latitude: 5.5890, longitude: -0.1720 };
  const confirmedAddress = 'Villa 8, Roman Ridge [Instructions: Leave with reception]';

  // Calculate food delivery quote
  const foodQuote = await restOrders.quoteFoodOrder(customer, {
    restaurantId: rest.id,
    items: [{ itemId: item.id, quantity: 2, options: [] }],
    deliveryAddress: confirmedAddress,
    deliveryLatitude: detectedCoords.latitude,
    deliveryLongitude: detectedCoords.longitude,
    customerPhone: custPhone
  });

  assert.equal(foodQuote.subtotalMinor, 13000);
  assert.ok(foodQuote.deliveryFeeMinor > 0);
  assert.equal(foodQuote.totalMinor, foodQuote.subtotalMinor + foodQuote.deliveryFeeMinor);

  // Place food order
  const foodOrder = await restOrders.createFoodOrder(customer, foodQuote, {
    paymentMethod: 'CASH',
    specialInstructions: 'Please include extra parmesan'
  });

  assert.equal(foodOrder.state, 'SUBMITTED');
  assert.equal(foodOrder.delivery_address, confirmedAddress);
  assert.equal(foodOrder.delivery_latitude, 5.5890);
  assert.equal(foodOrder.delivery_longitude, -0.1720);
});

test('Mobile GPS 8 — Paid-Order Immutability & Delivery OTP Security Guarantee', async () => {
  await migrate(db);
  await resetDispatchFixtures(db);

  const custPhone = '024' + Math.floor(1000000 + Math.random() * 8999999);
  const recipPhone = '024' + Math.floor(1000000 + Math.random() * 8999999);
  const riderPhone = '024' + Math.floor(1000000 + Math.random() * 8999999);

  const customer = await app.register({ phone: custPhone, password: 'Pass-2026-Test!', kind: 'customer' });
  await db.query("UPDATE users SET phone_verified_at=now() WHERE id=$1", [customer.id]);

  await db.query(`
    INSERT INTO pricing_policies (id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor, commission_bps, active)
    VALUES (gen_random_uuid(), 'motorcycle', 1200, 320, 25, 2000, 1300, true)
    ON CONFLICT (vehicle) WHERE active AND vehicle IS NOT NULL DO NOTHING
  `);

  const quote = await app.quote(customer, {
    pickup: { latitude: 5.5562, longitude: -0.1825, address: 'Sender Compound, Osu' },
    destination: { latitude: 5.6037, longitude: -0.1870, address: 'Recipient House, Airport' },
    vehicle: 'motorcycle',
    recipientPhone: recipPhone,
    weightG: 800,
    description: 'Confidential Deed',
    paymentMethod: 'CASH'
  });

  const shipment = await app.book(customer, { quoteId: quote.id }, 'booking-cust-otp-sec-1');
  const expectedNormalizedPhone = '+233' + recipPhone.slice(1);
  assert.equal(shipment.recipient_phone, expectedNormalizedPhone);

  // 1. Database trigger prevents mutating recipient phone or quote_id on shipments table
  await assert.rejects(
    () => db.query("UPDATE shipments SET recipient_phone='+233249999999' WHERE id=$1", [shipment.id]),
    /Shipment terms immutable/
  );

  // 2. Database trigger prevents mutating quote terms or destination address
  await assert.rejects(
    () => db.query("UPDATE quotes SET request = jsonb_set(request, '{destination,latitude}', '6.0000'::jsonb) WHERE id=$1", [quote.id]),
    /Quote terms and evidence are immutable/
  );

  // 3. Verify OTP verification security
  // Register and approve rider
  const riderUser = await app.register({ phone: riderPhone, password: 'Pass-2026-Test!', kind: 'rider' });
  await db.query("UPDATE riders SET status='approved', online=true WHERE id=$1", [riderUser.id]);

  // Position rider near pickup location
  await dispatcher.riderPosition(riderUser, {
    latitude: 5.5562,
    longitude: -0.1825,
    accuracyMeters: 10,
    observedAt: new Date().toISOString()
  });

  // Dispatch and accept shipment through production dispatch engine
  const offer = await dispatcher.dispatchShipment(shipment.id);
  assert.equal(offer.status, 'offered');
  await app.accept(riderUser, shipment.id, offer.offerId);

  // Request pickup challenge & verify code from SMS
  const pickupChallenge = await app.challenge(riderUser, shipment.id, 'pickup');
  assert.ok(pickupChallenge.challengeId);
  assert.equal(pickupChallenge.code, undefined, 'Pickup challenge must never leak code to rider');
  const pickupSms = smsMessages.at(-1);
  assert.ok(pickupSms?.code, 'SMS must contain pickup challenge code');

  await app.verify(riderUser, shipment.id, {
    challengeId: pickupChallenge.challengeId,
    code: pickupSms.code
  });

  // Rider starts delivery journey, transitioning from PICKUP_VERIFIED to IN_TRANSIT
  await app.transition(riderUser, shipment.id, { action: 'start' });

  // Request delivery OTP challenge
  const chall = await app.challenge(riderUser, shipment.id, 'delivery');
  assert.ok(chall.challengeId);

  // SMS is sent to recipient only, NOT returned in challenge response
  assert.equal(chall.code, undefined, 'Challenge response must NEVER leak the OTP code to rider');
  const lastSms = smsMessages.at(-1);
  assert.equal(lastSms.phone, expectedNormalizedPhone, 'Delivery OTP must be sent to recipient phone only');
  assert.match(lastSms.code, /^\d{6}$/, 'SMS code must be 6 digits');
});
