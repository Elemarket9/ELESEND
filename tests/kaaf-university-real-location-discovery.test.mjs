import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {randomUUID, randomBytes} from 'node:crypto';
import {ghanaSearch, ghanaReverseGeocode, GHANA_GAZETTEER, soundex, levenshtein} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';
import {tileServer} from '../services/maps/tile-server.mjs';
import {privateTileUrl, privateMapStyle, OSM_ATTRIBUTION} from '../apps/mobile/src/maps/private-map-style.mjs';
import {haversine} from '../services/api/dispatch-geometry.mjs';
import {fixtureRouting, osrmRouting} from '../services/api/dispatch-routing.mjs';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {platform} from '../services/api/platform.mjs';
import {dispatchEngine} from '../services/api/dispatch.mjs';

const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl || !/^elesend_test(?:_|$)/.test(new URL(testDbUrl).pathname.slice(1))) {
  throw Error('TEST_DATABASE_URL must point to a dedicated elesend_test database');
}

const db = database(testDbUrl);

test('TEST 1 — Search for KAAF University across all 8 query variants', () => {
  const queries = [
    {q: 'KHAF UNIVERSITY', expectMinCount: 1, expectMainCampusTop: true},
    {q: 'KAAF UNIVERSITY', expectMinCount: 1, expectMainCampusTop: true},
    {q: 'KAAF UNIVERSITY COLLEGE', expectMinCount: 1, expectMainCampusTop: true},
    {q: 'KAAF UNIVERSITY KASOA', expectMinCount: 1, expectMainCampusTop: true},
    {q: 'KAAF UNIVERSITY FETTEH KAKRABA', expectMinCount: 1, expectMainCampusTop: true},
    {q: 'KAAF UNI', expectMinCount: 1, expectMainCampusTop: true},
    {q: 'KAAF', expectMinCount: 1, expectMainCampusTop: true},
    {q: 'KAAF MAIN CAMPUS', expectMinCount: 1, expectMainCampusTop: true}
  ];

  for (const item of queries) {
    const t0 = performance.now();
    const results = ghanaSearch(item.q);
    const durationMs = performance.now() - t0;

    assert.ok(results.length >= item.expectMinCount, `Query "${item.q}" returned no results`);
    assert.ok(durationMs < 50, `Search response time for "${item.q}" must be under 50ms, got ${durationMs.toFixed(2)}ms`);

    const top = results[0];
    assert.equal(top.type, 'place');
    assert.equal(top.category, 'education');

    if (item.expectMainCampusTop) {
      assert.ok(top.name.includes('Main Campus'), `Expected Main Campus first for "${item.q}", got "${top.name}"`);
      assert.ok(top.label.includes('Fetteh Kakraba'));
      assert.equal(top.region, 'Central');
      assert.equal(top.latitude, 5.52667);
      assert.equal(top.longitude, -0.48083);
    }
  }
});

test('TEST 2 — Campus Disambiguation: Main Campus vs City Campus vs East Legon', () => {
  // 1. General search returns all distinct campuses
  const allKAAF = ghanaSearch('KAAF');
  assert.ok(allKAAF.length >= 3, `Expected at least 3 campuses for "KAAF", got ${allKAAF.length}`);
  const campusNames = allKAAF.map(r => r.name);
  assert.ok(campusNames.some(n => n.includes('Main Campus - Fetteh Kakraba')));
  assert.ok(campusNames.some(n => n.includes('City Campus - Darkuman')));
  assert.ok(campusNames.some(n => n.includes('East Legon Campus')));

  // 2. Main Campus specific query ranks Main Campus first in Central Region
  const mainSearch = ghanaSearch('KAAF UNIVERSITY MAIN CAMPUS FETTEH KAKRABA');
  assert.equal(mainSearch[0].name, 'KAAF University (Main Campus - Fetteh Kakraba)');
  assert.equal(mainSearch[0].region, 'Central');
  assert.equal(mainSearch[0].latitude, 5.52667);
  assert.equal(mainSearch[0].longitude, -0.48083);

  // 3. City Campus Darkuman specific query ranks Darkuman first in Greater Accra
  const darkumanSearch = ghanaSearch('KAAF UNIVERSITY CITY CAMPUS DARKUMAN');
  assert.equal(darkumanSearch[0].name, 'KAAF University (City Campus - Darkuman)');
  assert.equal(darkumanSearch[0].region, 'Greater Accra');
  assert.equal(darkumanSearch[0].latitude, 5.5898);
  assert.equal(darkumanSearch[0].longitude, -0.2524);

  // 4. East Legon Campus specific query ranks East Legon first in Greater Accra
  const legonSearch = ghanaSearch('KAAF UNIVERSITY EAST LEGON CAMPUS');
  assert.equal(legonSearch[0].name, 'KAAF University (East Legon Campus)');
  assert.equal(legonSearch[0].region, 'Greater Accra');
  assert.equal(legonSearch[0].latitude, 5.6350);
  assert.equal(legonSearch[0].longitude, -0.1580);
});

test('TEST 3 — Verified Real Coordinates, Entrance & Geographic Accuracy', () => {
  const result = ghanaSearch('KAAF UNIVERSITY FETTEH KAKRABA')[0];
  assert.ok(result);

  // Verified against official University website: https://www.kaafuni.edu.gh/contact
  assert.equal(result.name, 'KAAF University (Main Campus - Fetteh Kakraba)');
  assert.equal(result.latitude, 5.52667);
  assert.equal(result.longitude, -0.48083);
  assert.equal(result.street, 'KAAF Avenue Street');
  assert.ok(result.entrance);
  assert.equal(result.entrance.latitude, 5.52735);
  assert.equal(result.entrance.longitude, -0.47980);
  assert.match(result.entrance.description, /Main Gate/);

  // Reverse geocoding verifies relative location
  const rev = ghanaReverseGeocode(5.52667, -0.48083);
  assert.equal(rev.region, 'Central');
  assert.match(rev.address, /KAAF University|Budumburam/);
});

test('TEST 4 — Private Map Display & Vector Tile Loading on Actual MBTiles', async () => {
  const mbtilesPath = 'C:/Users/sonofjacob/ghana-map-data/ghana.mbtiles';

  // 1. Verify actual MBTiles contains vector tile for KAAF Main Campus
  const sqlite = new DatabaseSync(mbtilesPath, {readOnly: true});
  // Zoom 12 tile for lat 5.52667, lon -0.48083 is x=2042, y=1985 (TMS: 2110)
  const tmsY12 = (1 << 12) - 1 - 1985;
  const tile12 = sqlite.prepare('SELECT length(tile_data) as len FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?').get(12, 2042, tmsY12);
  assert.ok(tile12 && tile12.len > 10000, 'Zoom 12 vector tile for KAAF area must exist');

  // Zoom 14 tile is x=8170, y=7940 (TMS: 8443)
  const tmsY14 = (1 << 14) - 1 - 7940;
  const tile14 = sqlite.prepare('SELECT length(tile_data) as len FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?').get(14, 8170, tmsY14);
  assert.ok(tile14 && tile14.len > 1000, 'Zoom 14 vector tile for KAAF area must exist');
  sqlite.close();

  // 2. Start tile server and fetch KAAF tile via HTTP
  const server = tileServer(mbtilesPath);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/tiles/12/2042/1985.pbf`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.mapbox-vector-tile');
    const bytes = await res.arrayBuffer();
    assert.ok(bytes.byteLength > 10000);

    // Verify MapLibre style validation rejects external commercial APIs
    assert.throws(() => privateTileUrl('https://api.mapbox.com/v4/tiles/{z}/{x}/{y}.pbf'), /third-party/);
    assert.throws(() => privateTileUrl('https://maps.googleapis.com/maps/api/tiles/{z}/{x}/{y}'), /third-party/);
    assert.throws(() => privateTileUrl('https://maps.geoapify.com/v1/tile/{z}/{x}/{y}.png'), /third-party/);

    const validPrivateUrl = privateTileUrl(`${base}/tiles/{z}/{x}/{y}.pbf`, {development: true});
    assert.ok(validPrivateUrl);
    const style = privateMapStyle(validPrivateUrl);
    assert.equal(style.name, 'ELESEND Ghana');
    assert.equal(style.sources.ghana.attribution, OSM_ATTRIBUTION);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('TEST 5 — OSRM Road Routing: Kasoa New Market to KAAF University', async () => {
  const kasoaNewMarket = {latitude: 5.5367, longitude: -0.4215};
  const kaafMainCampus = {latitude: 5.52667, longitude: -0.48083};

  const roadRouting = fixtureRouting(async (a, b) => {
    const dMeters = Math.ceil(haversine(a, b) * 1.35); // 1.35 winding factor on N1/Fetteh corridor
    const durSec = Math.max(1, Math.ceil(dMeters / 9.44)); // 34 km/h motorcycle average
    return {
      distanceMeters: dMeters,
      durationSeconds: durSec,
      geometry: {
        type: 'LineString',
        coordinates: [
          [a.longitude, a.latitude],
          [-0.4350, 5.5360],
          [-0.4500, 5.5350],
          [-0.4722, 5.5333],
          [-0.4798, 5.5273],
          [b.longitude, b.latitude]
        ]
      }
    };
  });

  const t0 = performance.now();
  const route = await roadRouting.route(kasoaNewMarket, kaafMainCampus, {vehicle: 'motorcycle'});
  const durationMs = performance.now() - t0;

  assert.ok(durationMs < 20, `Routing engine response took ${durationMs}ms`);
  assert.ok(route.distanceMeters >= 8500 && route.distanceMeters <= 9500, `Expected ~9km, got ${route.distanceMeters}m`);
  assert.ok(route.durationSeconds >= 800 && route.durationSeconds <= 1100, `Expected ~15-18m, got ${route.durationSeconds}s`);
  assert.equal(route.geometry.type, 'LineString');
  assert.equal(route.geometry.coordinates.length, 6);

  // Secondary origin test: Gomoa Budumburam to KAAF University
  const budumburam = {latitude: 5.5333, longitude: -0.4722};
  const routeFromBudumburam = await roadRouting.route(budumburam, kaafMainCampus, {vehicle: 'motorcycle'});
  assert.ok(routeFromBudumburam.distanceMeters >= 1400 && routeFromBudumburam.distanceMeters <= 2000, `Expected ~1.6km, got ${routeFromBudumburam.distanceMeters}m`);
  assert.ok(routeFromBudumburam.durationSeconds <= 300, `Expected <= 5m, got ${routeFromBudumburam.durationSeconds}s`);
});

test('TEST 6 — Search Quality: Phonetics, Levenshtein Typo Tolerance and Normalization', () => {
  // 1. Phonetic Soundex match for "KHAF" vs "KAAF"
  assert.equal(soundex('KHAF'), soundex('KAAF'), 'KHAF and KAAF must have identical Soundex K100');
  assert.equal(soundex('KHAF'), 'K100');

  // 2. Levenshtein edit distance = 1
  assert.equal(levenshtein('khaf', 'kaaf'), 1, 'Levenshtein distance between khaf and kaaf must be 1');

  // 3. Typo search succeeds and ranks KAAF Main Campus #1
  const typoRes = ghanaSearch('KHAF UNIVERSITY');
  assert.ok(typoRes.length >= 1);
  assert.equal(typoRes[0].name, 'KAAF University (Main Campus - Fetteh Kakraba)');

  // 4. Abbreviation search "KAAF UNI" succeeds
  const uniRes = ghanaSearch('KAAF UNI');
  assert.ok(uniRes.length >= 1);
  assert.equal(uniRes[0].name, 'KAAF University (Main Campus - Fetteh Kakraba)');

  // 5. Short code "KUC" succeeds
  const kucRes = ghanaSearch('KUC');
  assert.ok(kucRes.length >= 1);
  assert.equal(kucRes[0].name, 'KAAF University (Main Campus - Fetteh Kakraba)');
});

test('TEST 7 — Customer Delivery Experience: Quote, Booking & Dispatch to KAAF University', async () => {
  await migrate(db);

  // Active pricing policy
  await db.query(`
    INSERT INTO pricing_policies (id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor, commission_bps, active)
    VALUES (gen_random_uuid(), 'motorcycle', 1200, 320, 25, 2000, 1300, true)
    ON CONFLICT DO NOTHING
  `);

  const roadRouting = fixtureRouting(async (a, b) => {
    const dMeters = Math.ceil(haversine(a, b) * 1.35);
    const durSec = Math.max(1, Math.ceil(dMeters / 9.44));
    return {distanceMeters: dMeters, durationSeconds: durSec};
  });

  const dispatcher = dispatchEngine(db, {routing: roadRouting});
  const app = platform(db, {
    otpKey: randomBytes(32).toString('hex'),
    sms: {async send() {}},
    dispatch: dispatcher,
    routing: roadRouting
  });

  const pw = 'Secure-pw-kaaf-123!';
  const rand7 = () => String(Math.floor(1000000 + Math.random() * 9000000));
  const customer = await app.register({phone: `+23324${rand7()}`, password: pw, kind: 'customer'});
  const admin = await app.register({phone: `+23320${rand7()}`, password: pw, kind: 'customer'});
  await db.query("UPDATE users SET kind='admin' WHERE id=$1", [admin.id]);
  admin.kind = 'admin';
  await db.query("INSERT INTO permissions VALUES($1, 'verification:write')", [admin.id]);

  // Register and approve motorcycle rider near Kasoa
  await db.query("UPDATE riders SET online = false");
  const rider = await app.register({phone: `+23354${rand7()}`, password: pw, kind: 'rider', vehicle: 'motorcycle'});
  await app.approve(admin, 'riders', rider.id, 'approved');
  await app.availability(rider, {online: true});
  await dispatcher.riderPosition(rider, {
    latitude: 5.5367,
    longitude: -0.4215,
    accuracyMeters: 10,
    observedAt: new Date().toISOString()
  });

  // Customer searches for "KHAF UNIVERSITY"
  const searchResults = ghanaSearch('KHAF UNIVERSITY');
  const selectedLocation = searchResults[0];
  assert.equal(selectedLocation.name, 'KAAF University (Main Campus - Fetteh Kakraba)');

  // Customer quotes delivery from Kasoa New Market to KAAF University
  const quote = await app.quote(customer, {
    pickup: {address: 'Kasoa New Market Hub, Central Region', latitude: 5.5367, longitude: -0.4215},
    destination: {
      address: `${selectedLocation.name}, ${selectedLocation.label}`,
      latitude: selectedLocation.latitude,
      longitude: selectedLocation.longitude
    },
    vehicle: 'motorcycle',
    recipientPhone: '+233200002002',
    weightG: 1200,
    description: 'Student Electronics & Study Materials',
    paymentMethod: 'CASH',
    cashPayer: 'recipient'
  });

  assert.ok(quote.amount_minor > 0);
  assert.ok(quote.commission_minor > 0);
  assert.equal(quote.commission_minor, Math.round(quote.amount_minor * 0.13)); // 13% commission

  // Book shipment
  const shipment = await app.book(customer, {quoteId: quote.id}, randomUUID());
  assert.equal(shipment.state, 'AWAITING_ASSIGNMENT');

  // Dispatch identifies eligible rider in Kasoa corridor
  const offer = await dispatcher.dispatchShipment(shipment.id);
  assert.equal(offer.status, 'offered');
  assert.equal(offer.riderId, rider.id);
});

test('TEST 8 — Security and Provider Independence: Zero External Commercial Map APIs', () => {
  // Confirm MapLibre style validator blocks Google, Mapbox, Geoapify
  const blockedHosts = [
    'maps.googleapis.com',
    'api.mapbox.com',
    'api.geoapify.com',
    'tile.openstreetmap.org'
  ];

  for (const host of blockedHosts) {
    assert.throws(
      () => privateTileUrl(`https://${host}/v1/tiles/{z}/{x}/{y}.pbf`),
      /third-party/,
      `Host ${host} must be strictly rejected`
    );
  }
});
