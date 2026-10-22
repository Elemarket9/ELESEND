import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  ghanaSearch,
  ghanaReverseGeocode,
  ghanaSearchPostGIS,
  ghanaReverseGeocodePostGIS,
  GHANA_GAZETTEER,
  soundex,
  levenshtein
} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {platform} from '../services/api/platform.mjs';
import {dispatchEngine} from '../services/api/dispatch.mjs';
import {fixtureRouting} from '../services/api/dispatch-routing.mjs';
import {haversine} from '../services/api/dispatch-geometry.mjs';

const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl || !/^elesend_test(?:_|$)/.test(new URL(testDbUrl).pathname.slice(1))) {
  throw Error('TEST_DATABASE_URL must point to a dedicated elesend_test database');
}

process.env.OTP_KEY = process.env.OTP_KEY || '83fb3c4d42810572ccf60ba85d593eb72aaecf2d1f95572997a3c197e910355e';

const db = database(testDbUrl);

test('1. Database-backed PostGIS spatial search across 6 authorized regions', async () => {
  await migrate(db);

  // Verify total imported count in PostgreSQL PostGIS
  const countRes = await db.query('SELECT count(*) AS total, count(DISTINCT region) AS regions FROM spatial_landmarks');
  const total = Number(countRes.rows[0].total);
  const regionsCount = Number(countRes.rows[0].regions);

  assert.ok(total >= 30000, `Expected at least 30,000 landmarks, got ${total}`);
  assert.equal(regionsCount, 6, `Expected exactly 6 regions, got ${regionsCount}`);

  // Test PostGIS search across all 6 regions
  const targets = [
    {q: 'Makola Market', region: 'Greater Accra'},
    {q: 'KAAF University', region: 'Central'},
    {q: 'Fetteh Kakraba Central Mosque', region: 'Central'},
    {q: 'Komfo Anokye Teaching Hospital', region: 'Ashanti'},
    {q: 'Koforidua Central Market', region: 'Eastern'},
    {q: 'Goaso Central Market', region: 'Ahafo'},
    {q: 'Sunyani Airport', region: 'Bono'}
  ];

  // Warm up PostGIS buffer cache
  await ghanaSearchPostGIS(db, 'Makola Market', {limit: 1});
  await ghanaSearchPostGIS(db, 'KAAF University', {limit: 1});

  for (const t of targets) {
    const t0 = performance.now();
    const results = await ghanaSearchPostGIS(db, t.q, {limit: 5});
    const durMs = performance.now() - t0;

    assert.ok(results.length >= 1, `PostGIS search for "${t.q}" returned no results`);
    assert.equal(results[0].region, t.region, `Expected region ${t.region} for "${t.q}", got ${results[0].region}`);
    assert.ok(durMs < 500, `PostGIS search latency must be under 500ms, measured ${durMs.toFixed(2)}ms`);
  }

  // Test PostGIS KNN reverse geocoding
  const rev = await ghanaReverseGeocodePostGIS(db, 5.52667, -0.48083);
  assert.equal(rev.region, 'Central');
  assert.ok(rev.distanceMeters <= 50);
});

test('2. 1,000-query large-scale search quality, typo tolerance & performance benchmark', () => {
  assert.ok(GHANA_GAZETTEER.length >= 30000, `Gazetteer must have >= 30k records, got ${GHANA_GAZETTEER.length}`);

  // Sample 1,000 diverse places across the dataset
  const step = Math.floor(GHANA_GAZETTEER.length / 1000);
  const sample = [];
  for (let i = 0; i < GHANA_GAZETTEER.length && sample.length < 1000; i += step) {
    sample.push(GHANA_GAZETTEER[i]);
  }

  assert.equal(sample.length, 1000, 'Must sample exactly 1,000 places');

  let top1Hits = 0;
  let top5Hits = 0;
  let totalDurationMs = 0;

  for (let i = 0; i < sample.length; i++) {
    const target = sample[i];
    let queryText = target.name;

    // Apply minor typo to 1 in 4 queries (e.g. double a letter or swap) to test typo tolerance
    if (i % 4 === 1 && target.name.length > 5) {
      const idx = 3;
      queryText = target.name.slice(0, idx) + target.name[idx] + target.name.slice(idx);
    }

    const t0 = performance.now();
    const res = ghanaSearch(queryText, {limit: 5});
    const ms = performance.now() - t0;
    totalDurationMs += ms;

    if (res.length > 0) {
      if (res[0].name === target.name || (res[0].latitude === target.latitude && res[0].longitude === target.longitude)) {
        top1Hits++;
        top5Hits++;
      } else if (res.some(r => r.name === target.name || (r.latitude === target.latitude && r.longitude === target.longitude))) {
        top5Hits++;
      }
    }
  }

  const avgMs = totalDurationMs / sample.length;
  const top1Rate = (top1Hits / sample.length) * 100;
  const top5Rate = (top5Hits / sample.length) * 100;

  console.log(`\n--- 1,000-LOCATION AUDIT BENCHMARK ---`);
  console.log(`Evaluated: ${sample.length} real location queries`);
  console.log(`Top-1 Accuracy: ${top1Rate.toFixed(2)}% (${top1Hits}/${sample.length})`);
  console.log(`Top-5 Recall: ${top5Rate.toFixed(2)}% (${top5Hits}/${sample.length})`);
  console.log(`Average Latency: ${avgMs.toFixed(3)}ms per query`);

  assert.ok(avgMs < 10.0, `Average search latency must be < 10.0ms, measured ${avgMs.toFixed(3)}ms`);
  assert.ok(top5Rate >= 85.0, `Top-5 recall must be >= 85%, measured ${top5Rate.toFixed(2)}%`);
});

test('3. End-to-end quotation, road routing & rider dispatch using newly discovered landmark', async () => {
  await migrate(db);
  await db.query('UPDATE riders SET online = false');

  // Ensure active motorcycle pricing policy exists
  await db.query(`
    INSERT INTO pricing_policies (id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor, commission_bps, active)
    VALUES (gen_random_uuid(), 'motorcycle', 1200, 320, 25, 2000, 1300, true)
    ON CONFLICT DO NOTHING
  `);

  const routingInstance = fixtureRouting(async (a, b) => {
    const dMeters = Math.ceil(haversine(a, b) * 1.32);
    const durSec = Math.max(1, Math.ceil(dMeters / 9.5));
    return {distanceMeters: dMeters, durationSeconds: durSec, geometry: [[a.longitude, a.latitude], [b.longitude, b.latitude]]};
  });

  const app = platform(db, {
    routing: routingInstance,
    otpKey: '83fb3c4d42810572ccf60ba85d593eb72aaecf2d1f95572997a3c197e910355e'
  });
  const dispatcher = dispatchEngine(db, {
    routing: routingInstance
  });

  const pw = 'ElesendTest1234!';
  const rand = () => String(Math.floor(1000000 + Math.random() * 9000000));
  const customer = await app.register({phone: `+23324${rand()}`, password: pw, kind: 'customer'});
  const admin = await app.register({phone: `+23320${rand()}`, password: pw, kind: 'customer'});
  await db.query("UPDATE users SET kind='admin' WHERE id=$1", [admin.id]);
  admin.kind = 'admin';
  await db.query("INSERT INTO permissions VALUES($1, 'verification:write')", [admin.id]);

  const rider = await app.register({phone: `+23354${rand()}`, password: pw, kind: 'rider', vehicle: 'motorcycle'});
  await app.approve(admin, 'riders', rider.id, 'approved');
  await app.availability(rider, {online: true});

  // Rider located at Sunyani Regional Hospital
  await dispatcher.riderPosition(rider, {
    latitude: 7.3380,
    longitude: -2.3250,
    accuracyMeters: 8,
    observedAt: new Date().toISOString()
  });

  // 1. Customer searches for "Sunyani Airport"
  const searchResults = ghanaSearch('Sunyani Airport');
  assert.ok(searchResults.length >= 1);
  const park = searchResults[0];
  assert.equal(park.region, 'Bono');

  // 2. Customer quotes delivery from Sunyani Market to Sunyani Airport
  const quote = await app.quote(customer, {
    pickup: {address: 'Sunyani Main Market, Sunyani', latitude: 7.3398, longitude: -2.3267},
    destination: {address: `${park.name}, Sunyani`, latitude: park.latitude, longitude: park.longitude},
    vehicle: 'motorcycle',
    recipientPhone: '+233200003003',
    weightG: 1000,
    description: 'Medical laboratory supplies',
    paymentMethod: 'CASH'
  });

  assert.ok(quote.amount_minor > 0);
  assert.ok(quote.distanceMeters > 0);
  assert.ok(quote.travelSeconds > 0);

  // 3. Book shipment & dispatch
  const shipment = await app.book(customer, {quoteId: quote.id}, randomUUID());
  assert.equal(shipment.state, 'AWAITING_ASSIGNMENT');

  const offer = await dispatcher.dispatchShipment(shipment.id);
  assert.equal(offer.status, 'offered');
  assert.equal(offer.riderId, rider.id);
});

test('4. Geographic boundary enforcement (Strict 6 regions, zero contamination)', async () => {
  const queryOut = await db.query(`
    SELECT DISTINCT region FROM spatial_landmarks ORDER BY region;
  `);

  const authorizedRegions = new Set([
    'Ahafo',
    'Ashanti',
    'Bono',
    'Central',
    'Eastern',
    'Greater Accra'
  ]);

  const foundRegions = queryOut.rows.map(r => r.region);
  assert.equal(foundRegions.length, 6, `Expected exactly 6 regions in DB, got ${foundRegions.length}`);

  for (const reg of foundRegions) {
    assert.ok(authorizedRegions.has(reg), `Unauthorized region found in DB: ${reg}`);
  }

  // Confirm ordinary status of Kasoa, Budumburam, and Fetteh Kakraba (no single-community dominance)
  const kasoaStats = await db.query(`
    SELECT locality, count(*) AS count
    FROM spatial_landmarks
    WHERE locality IN ('Kasoa', 'Budumburam', 'Fetteh Kakraba')
    GROUP BY locality;
  `);

  for (const row of kasoaStats.rows) {
    assert.ok(Number(row.count) < 2000, `Community "${row.locality}" has disproportionate dominance: ${row.count}`);
  }
});
