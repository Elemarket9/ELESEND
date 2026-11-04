import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectCustomerLocation, prepareDeviceLocation } from '../apps/mobile/src/customer-location.js';

const fix = (ageMs = 0) => ({ coords: { latitude: 5.6, longitude: -0.18, accuracy: 20 }, timestamp: Date.now() - ageMs });
const device = (over = {}) => {
  const calls = { current: 0, background: 0 };
  return { calls, api: {
    requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
    requestBackgroundPermissionsAsync: async () => { calls.background += 1; return { status: 'granted' }; },
    getCurrentPositionAsync: async () => { calls.current += 1; return fix(); },
    getLastKnownPositionAsync: async () => fix(60000),
    ...over
  } };
};

test('opening the app asks for foreground location only and wakes GPS', async () => {
  const { api, calls } = device();
  assert.equal(await prepareDeviceLocation(api), 'granted');
  assert.equal(calls.current, 1);
  assert.equal(calls.background, 0);
});

test('declining or a failure on launch is quiet and does not use GPS', async () => {
  const denied = device({ requestForegroundPermissionsAsync: async () => ({ status: 'denied' }) });
  assert.equal(await prepareDeviceLocation(denied.api), 'denied');
  assert.equal(denied.calls.current, 0);
  const broken = device({ requestForegroundPermissionsAsync: async () => { throw Error('no'); } });
  assert.equal(await prepareDeviceLocation(broken.api), 'unavailable');
  const noFix = device({ getCurrentPositionAsync: async () => { throw Error('no fix'); } });
  assert.equal(await prepareDeviceLocation(noFix.api), 'granted');
});

test('a recent device fix is used first and marked as not freshly measured', async () => {
  const { api, calls } = device();
  const result = await detectCustomerLocation({ locationApi: api, quickFirst: true });
  assert.equal(result.ok, true);
  assert.equal(result.isLastKnown, true);
  assert.equal(calls.current, 0);
});

test('an old or missing device fix falls through to a measured one', async () => {
  for (const held of [fix(600000), null]) {
    const { api, calls } = device({ getLastKnownPositionAsync: async () => held });
    const result = await detectCustomerLocation({ locationApi: api, quickFirst: true });
    assert.equal(result.ok, true);
    assert.equal(result.isLastKnown, false);
    assert.equal(calls.current, 1);
  }
});

test('the launch lookup never fills in a booking or opens a panel', () => {
  const source = readFileSync(new URL('../apps/mobile/src/customer/CustomerApp.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function requestLocation'), source.indexOf('openGpsConfirmation(detected);'));
  assert.match(body, /if \(silent\) return res;\s+\/\/ Never write a GPS fix/);
  assert.match(body, /if \(!res\.ok && silent\) return res;/);
});
