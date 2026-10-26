import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ghanaSearch, gazetteerAudit, interpretCoordinateQuery} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';
import {viewportMarkers} from '../services/api/infrastructure/maps/viewport-markers.mjs';
import {resolveManualAddress, saveAddressSubmission, composeManualAddress as serverCompose} from '../services/api/infrastructure/maps/address-intelligence.mjs';
import {privateMapStyle} from '../apps/mobile/src/maps/private-map-style.mjs';
import {
  assessManualAddress, composeManualAddress, isQuotableLocation, locationFromResolve,
  locationFromSearchResult, validateCoordinates
} from '../apps/mobile/src/customer-location.js';

test('gazetteer coordinates stay inside Ghana and duplicate ids are flagged, not overwritten', () => {
  const audit = gazetteerAudit();
  assert.equal(audit.outsideGhana, 0);
  assert.ok(audit.records > 30000);
  assert.ok(audit.duplicateIds.length >= 1);
  assert.ok(audit.distantNameCount > 0);
  assert.equal(audit.duplicateIds.includes(undefined), false);
});

test('search dedupes repeated places and does not rank a different city first for Kumasi', () => {
  const malls = ghanaSearch('Accra Mall', {limit: 8}).filter(item => item.name === 'Accra Mall');
  assert.equal(malls.length, 1);
  assert.ok(malls[0].duplicateIds.length >= 1);
  const kumasi = ghanaSearch('Kumasi', {limit: 5});
  assert.equal(kumasi[0].city, 'Kumasi');
  assert.ok(kumasi.slice(0, 3).every(item => item.city === 'Kumasi'));
  const typo = ghanaSearch('acra mal', {limit: 3});
  assert.equal(typo[0].name, 'Accra Mall');
  assert.ok(Number.isFinite(typo[0].latitude) && Number.isFinite(typo[0].longitude));
});

test('nearby search prefers the map area without inventing a coordinate', () => {
  const nearAccra = ghanaSearch('Central Market', {limit: 5, near: {latitude: 5.6037, longitude: -0.187}});
  const far = ghanaSearch('Central Market', {limit: 1, near: {latitude: 6.69, longitude: -1.62}});
  assert.ok(nearAccra[0].distanceMeters < 80000);
  assert.equal(far[0].latitude !== nearAccra[0].latitude || far[0].longitude !== nearAccra[0].longitude, true);
  assert.equal(nearAccra[0].coordinateSource, undefined);
});

test('reversed coordinate text is flagged and not treated as the typed order', () => {
  const reversed = interpretCoordinateQuery('-0.187, 5.6037');
  assert.equal(reversed.needsConfirmation, true);
  assert.equal(reversed.coordinateOrder, 'interpreted_longitude_latitude');
  assert.equal(reversed.latitude, 5.6037);
  assert.equal(reversed.longitude, -0.187);
  assert.equal(locationFromSearchResult(reversed), null);
  const ordered = interpretCoordinateQuery('5.6037, -0.187');
  assert.equal(ordered.needsConfirmation, false);
  assert.equal(ordered.coordinateOrder, 'latitude_longitude');
});

test('viewport loading is bounded, inside the box, and clustered without averaged coordinates', () => {
  const view = viewportMarkers({west: -0.25, south: 5.55, east: -0.1, north: 5.7, zoom: 14});
  assert.ok(view.features.length > 0);
  assert.ok(view.features.length <= view.limit);
  const ids = new Set();
  for (const feature of view.features) {
    assert.ok(feature.latitude >= 5.55 && feature.latitude <= 5.7);
    assert.ok(feature.longitude >= -0.25 && feature.longitude <= -0.1);
    assert.equal(ids.has(feature.id), false);
    ids.add(feature.id);
    assert.equal(feature.coordinateSource === 'gazetteer_record' || feature.coordinateSource === 'representative_member', true);
  }
  const wide = viewportMarkers({west: -3.2, south: 4.8, east: 1.2, north: 11.1, zoom: 8});
  assert.ok(wide.features.length <= 12);
  assert.ok(wide.features.some(feature => feature.kind === 'cluster'));
  assert.ok(wide.features.length < view.features.length || wide.zoom === 8);
});

test('manual addresses keep the customer wording and never invent a point', () => {
  const fields = {region: 'Greater Accra', city: 'Accra', community: 'East Legon', house: '12', landmark: 'blue gate', instructions: 'call on arrival'};
  assert.equal(assessManualAddress(fields).ok, true);
  assert.equal(assessManualAddress({region: 'Greater Accra', city: 'Accra'}).ok, false);
  assert.equal(serverCompose(fields), composeManualAddress(fields));
  const resolved = resolveManualAddress(fields);
  assert.equal(resolved.original.house, '12');
  assert.equal(resolved.original.instructions, 'call on arrival');
  assert.match(resolved.composedAddress, /East Legon/);
  assert.match(resolved.composedAddress, /blue gate/);
  if (resolved.suggestion) {
    assert.equal(resolved.suggestion.coordinateSource, 'gazetteer_record');
    assert.ok(resolved.detectedCommunities.some(item => item.name === resolved.suggestion.name) || resolved.candidates.some(item => item.id === resolved.suggestion.id));
    assert.equal(resolved.suggestion.positionKind === 'verified_record' || resolved.suggestion.positionKind === 'approximate', true);
  }
  const unresolved = resolveManualAddress({landmark: 'Central Market'});
  assert.equal(unresolved.resolution, 'unresolved');
  assert.equal(unresolved.suggestion, null);
  assert.equal(unresolved.requiresCustomerPin, true);
  const located = locationFromResolve(fields, {...resolved, suggestion: null});
  assert.equal(located.latitude, null);
  assert.equal(located.longitude, null);
  assert.equal(located.positionKind, 'none');
  assert.equal(isQuotableLocation(located), false);
});

test('informal and landmark addresses can resolve to an existing record only', () => {
  const missingStreet = resolveManualAddress({community: 'Osu', city: 'Accra', house: 'blue gate near Oxford Street'});
  assert.equal(missingStreet.original.street, '');
  assert.match(missingStreet.composedAddress, /blue gate near Oxford Street/);
  const kejetia = resolveManualAddress({landmark: 'Kejetia', city: 'Kumasi'});
  assert.ok(kejetia.suggestion);
  assert.equal(kejetia.suggestion.city, 'Kumasi');
  assert.equal(validateCoordinates(kejetia.suggestion).valid, true);
  const client = locationFromResolve({landmark: 'Kejetia', city: 'Kumasi'}, kejetia);
  assert.equal(client.latitude, kejetia.suggestion.latitude);
  assert.equal(client.longitude, kejetia.suggestion.longitude);
  assert.equal(isQuotableLocation(client), true);
});

test('address submissions preserve text, accept a customer pin, and reject invented verified coordinates', async () => {
  const calls = [];
  const db = {query: async (sql, params) => { calls.push({sql, params}); return {rows: [], rowCount: 1}; }};
  const actor = {id: '11111111-1111-4111-8111-111111111111', kind: 'customer'};
  await assert.rejects(() => saveAddressSubmission(db, actor, {
    role: 'pickup',
    positionKind: 'verified_record',
    latitude: 5.6037,
    longitude: -0.187,
    original: {community: 'East Legon', city: 'Accra', house: '12', landmark: 'blue gate'}
  }), /not an EGIE record|not a high-confidence/);
  const pin = await saveAddressSubmission(db, actor, {
    role: 'pickup',
    positionKind: 'customer_pin',
    latitude: 5.6354,
    longitude: -0.1601,
    original: {community: 'East Legon', city: 'Accra', house: '12', landmark: 'blue gate', instructions: 'call on arrival'}
  });
  assert.equal(pin.positionKind, 'customer_pin');
  assert.equal(pin.latitude, 5.6354);
  assert.equal(pin.longitude, -0.1601);
  assert.equal(pin.original.instructions, 'call on arrival');
  const insert = calls.find(item => item.sql.includes('INSERT INTO customer_address_submissions'));
  assert.ok(insert);
  assert.equal(JSON.parse(insert.params[3]).house, '12');
  assert.doesNotMatch(insert.sql, /spatial_landmarks|national_businesses/);
  await assert.rejects(() => saveAddressSubmission(db, actor, {
    role: 'destination',
    positionKind: 'none',
    latitude: 5.6,
    longitude: -0.18,
    original: {city: 'Accra', region: 'Greater Accra'}
  }), /cannot include coordinates|not enough/);
});

test('map style hides the place-dot layer until street zoom and keeps longitude, latitude order', () => {
  const style = privateMapStyle('https://maps.example.com/tiles/{z}/{x}/{y}.pbf', {glyphsUrl: 'https://maps.example.com/fonts/{fontstack}/{range}.pbf'});
  const places = style.layers.find(layer => layer.id === 'places');
  assert.equal(places.minzoom, 16);
  const adapter = readFileSync('apps/mobile/src/maps/map-adapter.js', 'utf8');
  assert.match(adapter, /const coordinate=p=>\[p\.longitude,p\.latitude\]/);
  assert.match(adapter, /LandmarkLayer/);
  assert.match(adapter, /overflow:'hidden'/);
});

test('customer booking UI keeps quote sanitization and adds manual confirmation', () => {
  const src = readFileSync('apps/mobile/src/customer/CustomerApp.js', 'utf8');
  const sheet = readFileSync('apps/mobile/src/customer/LocationExperience.js', 'utf8');
  assert.match(src, /function sanitizeAddressPayload\(loc\)/);
  assert.match(src, /Set Pickup/);
  assert.match(src, /Set Destination/);
  assert.match(src, /Handover & Landmark Instructions \(Optional\)/);
  assert.match(src, /isQuotableLocation/);
  assert.match(src, /No distance or fee is estimated without a real position/);
  assert.match(sheet, /Enter address/);
  assert.match(sheet, /Confirm address/);
  assert.match(sheet, /\/api\/v1\/maps\/viewport/);
  assert.match(sheet, /\/api\/v1\/maps\/resolve-address/);
  assert.match(sheet, /\/api\/v1\/maps\/address-submissions/);
  assert.match(sheet, /Drop a pin|drop a pin/);
});
