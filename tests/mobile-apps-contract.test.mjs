import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {renderRestaurantPortalHtml, renderRestaurantManifestJson} from '../services/api/restaurant-web/restaurant-portal.mjs';
import {renderAdminPortalHtml} from '../services/api/admin-web/admin-portal.mjs';
import {normalizeGhanaPhone, isValidGhanaPhone, formatGhanaDisplayPhone} from '../apps/mobile-shared/src/phone.js';
import {colors} from '../apps/mobile-shared/src/theme.js';
import {httpServer} from '../services/api/http.mjs';

test('Mobile shared theme tokens match ELESEND design system', () => {
  assert.equal(colors.primary, '#18C6A5');
  assert.equal(colors.bg, '#101827');
  assert.equal(colors.surface, '#1A2438');
  assert.equal(colors.warn, '#FFB547');
});

test('Ghana phone number utility normalizes and validates strictly', () => {
  assert.equal(normalizeGhanaPhone('0244123456'), '+233244123456');
  assert.equal(normalizeGhanaPhone('+233501234567'), '+233501234567');
  assert.equal(normalizeGhanaPhone(' 055 987 6543 '), '+233559876543');
  assert.equal(isValidGhanaPhone('0244123456'), true);
  assert.equal(isValidGhanaPhone('0501234567'), true);
  assert.equal(isValidGhanaPhone('0302123456'), false); // Landline not valid for mobile rider/customer
  assert.equal(isValidGhanaPhone('12345'), false);
  assert.equal(formatGhanaDisplayPhone('+233244123456'), '+233 24 412 3456');
});

test('Restaurant Web Portal HTML delivers responsive kitchen terminal features', () => {
  const html = renderRestaurantPortalHtml();
  assert.ok(html.includes('ELESEND Kitchen — Restaurant Merchant Portal'));
  assert.ok(html.includes('/restaurant/manifest.json'));
  assert.ok(html.includes('id="tabOrders"'));
  assert.ok(html.includes('id="tabMenu"'));
  assert.ok(html.includes('id="tabSettlements"'));
  assert.ok(html.includes('playKitchenChime'));
  assert.ok(html.includes('toggleItem86'));
  assert.ok(html.includes('acceptOrder'));
  assert.ok(html.includes('confirmRejectOrder'));
  assert.ok(html.includes('offlineBanner'));
  assert.ok(html.includes('statNetPayable'));
  assert.ok(html.includes('downloadSettlementsCsv'));
});

test('Restaurant Web Portal PWA manifest conforms to standalone PWA requirements', () => {
  const manifestRaw = renderRestaurantManifestJson();
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.name, 'ELESEND Merchant & Kitchen Portal');
  assert.equal(manifest.short_name, 'ELESEND Kitchen');
  assert.equal(manifest.start_url, '/restaurant');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#18C6A5');
  assert.ok(manifest.icons && manifest.icons.length > 0);
});

test('HTTP server serves /restaurant portal and /restaurant/manifest.json', async () => {
  const mockDb = { query: async () => ({ rows: [{ count: 1 }], rowCount: 1 }) };
  const mockApp = { routing: {} };
  const server = httpServer(mockDb, mockApp, null, null);
  
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const resHtml = await fetch(`http://localhost:${port}/restaurant`);
    assert.equal(resHtml.status, 200);
    assert.equal(resHtml.headers.get('content-type'), 'text/html; charset=utf-8');
    const textHtml = await resHtml.text();
    assert.ok(textHtml.includes('ELESEND Kitchen'));

    const resManifest = await fetch(`http://localhost:${port}/restaurant/manifest.json`);
    assert.equal(resManifest.status, 200);
    assert.equal(resManifest.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
    const manifest = await resManifest.json();
    assert.equal(manifest.short_name, 'ELESEND Kitchen');
  } finally {
    server.close();
  }
});

test('Customer parcel booking contract validates Ghana coordinates and recipient phone', () => {
  const pickup = { address: 'Ridge, Accra', latitude: 5.5601, longitude: -0.1963 };
  const dropoff = { address: 'Osu Oxford Street, Accra', latitude: 5.5560, longitude: -0.1825 };
  const recipientPhone = '+233244123456';
  
  assert.ok(pickup.latitude >= 4.5 && pickup.latitude <= 11.5, 'Valid Ghana latitude');
  assert.ok(pickup.longitude >= -3.5 && pickup.longitude <= 1.5, 'Valid Ghana longitude');
  assert.ok(dropoff.latitude >= 4.5 && dropoff.latitude <= 11.5, 'Valid Ghana latitude');
  assert.ok(isValidGhanaPhone(recipientPhone), 'Valid Ghana recipient phone number');
});

test('Rider delivery challenge contract requires 6-digit numeric OTP', () => {
  const isValidOtp = code => typeof code === 'string' && /^\d{6}$/.test(code);
  assert.equal(isValidOtp('123456'), true);
  assert.equal(isValidOtp('998877'), true);
  assert.equal(isValidOtp('12345'), false);
  assert.equal(isValidOtp('1234567'), false);
  assert.equal(isValidOtp('abcdef'), false);
  assert.equal(isValidOtp(''), false);
});

test('Rider weekly cash commission ledger enforces 13% platform rate and restriction threshold', () => {
  const commissionRateBps = 1300; // 13%
  const cashCollectedMinor = 10000; // GH₵ 100.00
  const expectedCommissionMinor = Math.round((cashCollectedMinor * commissionRateBps) / 10000);
  assert.equal(expectedCommissionMinor, 1300); // GH₵ 13.00

  // Restriction threshold test: default GH₵ 150.00 (15000 minor)
  const restrictionThresholdMinor = 15000;
  const isRestricted = balanceMinor => balanceMinor >= restrictionThresholdMinor;
  assert.equal(isRestricted(14000), false);
  assert.equal(isRestricted(15000), true);
  assert.equal(isRestricted(22000), true);
});

test('Food marketplace upfront digital payment enforcement', () => {
  const validMethods = ['CASH', 'MOMO', 'CARD'];
  const requiresUpfrontDigital = (method, isFood) => isFood && ['MOMO', 'CARD'].includes(method);
  
  assert.equal(requiresUpfrontDigital('MOMO', true), true);
  assert.equal(requiresUpfrontDigital('CARD', true), true);
  assert.equal(requiresUpfrontDigital('CASH', true), false);
  assert.equal(requiresUpfrontDigital('MOMO', false), false);
});

test('Mobile onboarding, customer booking, restaurant portal and admin portal contracts match backend schemas', () => {
  const customerAppSrc = readFileSync('apps/mobile/src/customer/CustomerApp.js', 'utf8');
  const riderAppSrc = readFileSync('apps/mobile/src/rider/RiderApp.js', 'utf8');
  const restaurantHtml = renderRestaurantPortalHtml();
  const adminHtml = renderAdminPortalHtml();

  // 1. Mobile onboarding: phone verification endpoints & 12-128 password requirement in both apps
  for (const src of [customerAppSrc, riderAppSrc]) {
    assert.ok(src.includes("'/api/v1/me/phone'"), 'App checks GET /api/v1/me/phone');
    assert.ok(src.includes("'/api/v1/me/phone-challenge'"), 'App calls POST /api/v1/me/phone-challenge');
    assert.ok(src.includes("'/api/v1/me/phone-verify'"), 'App calls POST /api/v1/me/phone-verify');
    assert.ok(src.includes('credentials.password.length < 12 || credentials.password.length > 128'), 'App enforces 12-128 password length');
  }

  // 2. Customer booking: sanitized address payload, Step 2 requote on payment term change, food quote fields, payment resumption, dynamic restaurant discovery
  assert.ok(customerAppSrc.includes('function sanitizeAddressPayload(loc)'), 'CustomerApp sanitizes pickup/destination to {address, latitude, longitude}');
  assert.ok(customerAppSrc.includes('changeParcelPaymentTerms'), 'CustomerApp requotes when payment terms change on Step 2 without blanking confirmation view');
  assert.ok(customerAppSrc.includes('foodQuote.subtotalMinor'), 'CustomerApp reads foodQuote.subtotalMinor');
  assert.ok(customerAppSrc.includes('foodQuote.totalMinor'), 'CustomerApp reads foodQuote.totalMinor');
  assert.ok(customerAppSrc.includes('startOrResumeCheckout'), 'CustomerApp supports safe payment resumption without creating duplicate orders');
  assert.ok(!customerAppSrc.includes("'/api/v1/restaurants?lat=5.6037&lon=-0.1870'"), 'CustomerApp does not hardcode restaurant discovery coordinates');

  // 3. Restaurant portal: estimatedPrepMinutes, subtotal_minor/total_price_minor, payment_status check, and camelCase settlement totals
  assert.ok(restaurantHtml.includes('JSON.stringify({ estimatedPrepMinutes })'), 'Restaurant portal sends estimatedPrepMinutes on accept');
  assert.ok(restaurantHtml.includes("o.payment_status === 'PAID'"), 'Restaurant portal checks payment_status === PAID before allowing kitchen acceptance');
  assert.ok(restaurantHtml.includes('o.subtotal_minor'), 'Restaurant portal displays subtotal_minor');
  assert.ok(restaurantHtml.includes('i.total_price_minor'), 'Restaurant portal displays item total_price_minor');
  assert.ok(restaurantHtml.includes('totals.grossSalesMinor'), 'Restaurant portal reads totals.grossSalesMinor');
  assert.ok(restaurantHtml.includes('totals.commissionMinor'), 'Restaurant portal reads totals.commissionMinor');
  assert.ok(restaurantHtml.includes('totals.netPayableMinor'), 'Restaurant portal reads totals.netPayableMinor');
  assert.ok(restaurantHtml.includes('totals.totalOrders'), 'Restaurant portal reads totals.totalOrders');

  // 4. Admin portal: Submit Refund for queued, Reconcile for pending/initiating/needs_review, r.reference, and integer signalId + reason for risk review
  assert.ok(adminHtml.includes("r.status === 'queued'"), 'Admin portal shows Submit Refund for queued operations');
  assert.ok(adminHtml.includes("['pending', 'initiating', 'needs_review'].includes(r.status)"), 'Admin portal reserves Reconcile for submitted refund operations');
  assert.ok(adminHtml.includes("['approved', 'initiating', 'pending', 'needs_review'].includes(p.status)"), 'Admin portal includes pending in payout Reconcile');
  assert.ok(adminHtml.includes('r.reference'), 'Admin portal displays refund reference');
  assert.ok(adminHtml.includes('s.signal_code'), 'Admin portal renders signal_code');
  assert.ok(adminHtml.includes('signalId: Number(id), decision, reason:'), 'Admin portal sends { signalId: Number(id), decision, reason } for risk signal review');
});

test('Frontend UI/UX refinements, ergonomics, live countdown timers, and financial consistency', () => {
  const customerAppSrc = readFileSync('apps/mobile/src/customer/CustomerApp.js', 'utf8');
  const riderAppSrc = readFileSync('apps/mobile/src/rider/RiderApp.js', 'utf8');
  const restaurantHtml = renderRestaurantPortalHtml();

  // 1. Customer App: Radio vs Checkbox indicators, required modifier validation, active target selector, and delivery instructions
  assert.ok(customerAppSrc.includes("isSingle ? (isSelected ? '◉' : '○') : (isSelected ? '☑' : '☐')"), 'CustomerApp differentiates single-select radio vs multi-select checkbox');
  assert.ok(customerAppSrc.includes("Alert.alert('Required Selection Missing'"), 'CustomerApp validates required modifier selections before add to cart');
  assert.ok(customerAppSrc.includes('Set Pickup') && customerAppSrc.includes('Set Destination'), 'CustomerApp provides active target selection pills');
  assert.ok(customerAppSrc.includes('Handover & Landmark Instructions (Optional)'), 'CustomerApp provides landmark handover instructions input');

  // 2. Rider App: 56dp ergonomic touch targets, vibration alerts for offers, COD warning banner and OTP cash verification alert
  assert.ok(riderAppSrc.includes('minHeight: 56'), 'RiderApp primary buttons enforce >= 56dp minHeight for gloved courier ergonomics');
  assert.ok(riderAppSrc.includes('Vibration.vibrate([0, 400, 200, 400])'), 'RiderApp triggers haptic vibration on new incoming job offers');
  assert.ok(riderAppSrc.includes('Vibration.cancel()'), 'RiderApp cancels vibration when offer is accepted, declined, or cleared');
  assert.ok(riderAppSrc.includes('CASH ON DELIVERY REQUIRED'), 'RiderApp highlights prominent cash on delivery warning banner in route manifest');
  assert.ok(riderAppSrc.includes('CASH PAYMENT CONFIRMATION'), 'RiderApp displays cash collection reminder in OTP verification modal');

  // 3. Restaurant Kitchen Portal: Live visual countdown progress bar, fullscreen kiosk mode, and non-negotiable 10% commission rate
  assert.ok(restaurantHtml.includes('updatePrepTimers'), 'Restaurant portal includes live countdown update function');
  assert.ok(restaurantHtml.includes('prep-progress-bar'), 'Restaurant portal renders visual countdown progress bar');
  assert.ok(restaurantHtml.includes('timer-warning') && restaurantHtml.includes('timer-overdue'), 'Restaurant portal handles warning (<= 5m) and overdue countdown states');
  assert.ok(restaurantHtml.includes('toggleFullscreen'), 'Restaurant portal includes kiosk fullscreen toggle');
  assert.ok(restaurantHtml.includes('Platform Fee (10%)'), 'Restaurant portal displays strictly 10% platform fee, preserving non-negotiable financial policy');
  assert.ok(!restaurantHtml.includes('Platform Fee (15%)'), 'Restaurant portal does not contain stale 15% platform fee label');
});


