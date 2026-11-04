import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { customerStatus, riderStatus, paymentLabel } from '../apps/mobile/src/status-labels.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('every style a mobile screen uses is defined', () => {
  for (const path of ['apps/mobile/src/customer/CustomerApp.js', 'apps/mobile/src/rider/RiderApp.js', 'apps/mobile/src/company/CompanyHome.js']) {
    const source = read(path);
    for (const [, name] of source.matchAll(/styles\.([A-Za-z0-9_]+)/g)) {
      assert.match(source, new RegExp(`^  ${name}:`, 'm'), `${path} uses undefined style ${name}`);
    }
  }
});

test('people never see raw order states', () => {
  for (const state of ['CREATED', 'AWAITING_PAYMENT', 'AWAITING_ASSIGNMENT', 'RIDER_ASSIGNED', 'PICKUP_VERIFIED', 'IN_TRANSIT', 'AWAITING_DELIVERY_OTP', 'COMPLETED', 'DELIVERED', 'FAILED', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED', 'SUBMITTED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'REJECTED']) {
    assert.doesNotMatch(customerStatus(state), /_|^[A-Z ]+$/, state);
    assert.doesNotMatch(riderStatus(state), /_|^[A-Z ]+$/, state);
  }
  assert.equal(customerStatus('NEW_STATE'), 'New state');
  assert.equal(customerStatus(undefined), '');
  assert.equal(paymentLabel('MOMO'), 'Mobile Money');
});

test('restaurant forms do not start with a made-up kitchen location', () => {
  const html = read('apps/restaurant-web/index.html');
  assert.doesNotMatch(html, /id="(reg|profile)L(atitude|ongitude)"[^>]*value="/);
});
