import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {
  ghanaSearch,
  ghanaReverseGeocode,
  ghanaSearchPostGIS,
  ghanaReverseGeocodePostGIS,
  GHANA_GAZETTEER
} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';
import {database} from '../services/api/db.mjs';
import {migrate} from '../scripts/migrate.mjs';
import {platform} from '../services/api/platform.mjs';
import {dispatchEngine} from '../services/api/dispatch.mjs';
import {fixtureRouting} from '../services/api/dispatch-routing.mjs';
import {haversine} from '../services/api/dispatch-geometry.mjs';
import {httpServer} from '../services/api/http.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl || !/^elesend_test(?:_|$)/.test(new URL(testDbUrl).pathname.slice(1))) {
  throw Error('TEST_DATABASE_URL must point to a dedicated elesend_test database');
}

const db = database(testDbUrl);

test('V8 - 1. Database Integrity & Provenance of all 31,204 Spatial Records', async () => {
  await migrate(db);

  const stats = (await db.query(`
    SELECT 
      count(*) as total,
      count(DISTINCT id) as unique_ids,
      count(DISTINCT region) as regions_count,
      count(*) FILTER (WHERE category IN ('settlement', 'town', 'neighborhood')) as settlements,
      count(*) FILTER (WHERE category NOT IN ('settlement', 'town', 'neighborhood')) as named_pois,
      count(*) FILTER (WHERE entrance IS NOT NULL) as entrances,
      count(*) FILTER (WHERE jsonb_array_length(aliases) > 0) as with_aliases
    FROM spatial_landmarks
  `)).rows[0];

  assert.equal(Number(stats.total), 31204, 'Total records must be exactly 31,204');
  assert.equal(Number(stats.unique_ids), 31204, 'All 31,204 IDs must be strictly unique');
  assert.equal(Number(stats.regions_count), 6, 'Must strictly span the 6 authorized regions');
  assert.equal(Number(stats.settlements), 10491, 'Settlement reference points must equal 10,491');
  assert.equal(Number(stats.named_pois), 20713, 'Named genuine POIs must equal 20,713');
  assert.equal(Number(stats.entrances), 3, 'Delivery entrances count must equal 3');
  assert.ok(Number(stats.with_aliases) >= 2000, 'Over 2,000 landmarks must have alternative aliases');
});

test('V8 - 2. Frozen 2,000-Query Benchmark: >= 95% Top-1 Accuracy and >= 98% Top-5 Recall', () => {
  const benchmarkPath = join(projectRoot, 'tests', 'fixtures', 'search-benchmark-2000.json');
  const testCases = JSON.parse(readFileSync(benchmarkPath, 'utf8'));

  assert.equal(testCases.length, 2000, 'Must contain exactly 2,000 frozen test cases');

  let top1Hits = 0;
  let top5Hits = 0;
  let totalDurationMs = 0;

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const t0 = performance.now();
    const results = ghanaSearch(tc.query, {limit: 5});
    totalDurationMs += (performance.now() - t0);

    const isMatch = (res) => {
      if (!res) return false;
      if (res.name.toLowerCase() === tc.target.name.toLowerCase()) return true;
      if (Math.abs(res.latitude - tc.target.latitude) < 0.001 && Math.abs(res.longitude - tc.target.longitude) < 0.001) return true;
      return false;
    };

    if (isMatch(results[0])) top1Hits++;
    if (results.some(isMatch)) top5Hits++;
  }

  const top1Acc = (top1Hits / testCases.length) * 100;
  const top5Rec = (top5Hits / testCases.length) * 100;
  const avgLatency = totalDurationMs / testCases.length;

  console.log(`\n--- V8 SEARCH ACCURACY VERIFICATION (2,000 FROZEN QUERIES) ---`);
  console.log(`Top-1 Accuracy: ${top1Acc.toFixed(2)}% (Target: >= 95.0%)`);
  console.log(`Top-5 Recall:   ${top5Rec.toFixed(2)}% (Target: >= 98.0%)`);
  console.log(`Average Latency: ${avgLatency.toFixed(3)}ms per query`);

  assert.ok(top1Acc >= 95.0, `Top-1 accuracy must be >= 95.0%, measured ${top1Acc.toFixed(2)}%`);
  assert.ok(top5Rec >= 98.0, `Top-5 recall must be >= 98.0%, measured ${top5Rec.toFixed(2)}%`);
  assert.ok(avgLatency < 20.0, `Average search latency must be < 20ms, measured ${avgLatency.toFixed(3)}ms`);
});

test('V8 - 3. Mobile Location-Selection HTTP Flow (/api/v1/maps/search & /api/v1/maps/reverse)', async () => {
  await migrate(db);
  const pw = 'ElesendTest1234!';
  const rand = () => String(Math.floor(1000000 + Math.random() * 9000000));

  const routingInstance = fixtureRouting(async (a, b) => {
    const dMeters = Math.ceil(haversine(a, b) * 1.25);
    return {distanceMeters: dMeters, durationSeconds: Math.ceil(dMeters / 9.0), geometry: []};
  });

  const app = platform(db, {
    routing: routingInstance,
    otpKey: '83fb3c4d42810572ccf60ba85d593eb72aaecf2d1f95572997a3c197e910355e'
  });
  const dispatcher = dispatchEngine(db, {routing: routingInstance});

  const server = httpServer(db, app, dispatcher);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const customer = await app.register({phone: `+23324${rand()}`, password: pw, kind: 'customer'});
    const login = await app.login({phone: customer.phone, password: pw});

    // 1. Mobile query search via HTTP GET /api/v1/maps/search?q=...
    const res1 = await fetch(`${base}/api/v1/maps/search?q=Makola%20Market`, {
      headers: {Authorization: `Bearer ${login.token}`}
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.ok(body1.length >= 1);
    assert.equal(body1[0].name, 'Makola Market');
    assert.equal(body1[0].region, 'Greater Accra');

    // 2. Mobile map pin drop / reverse geocode via HTTP GET /api/v1/maps/reverse?lat=...&lon=...
    const res2 = await fetch(`${base}/api/v1/maps/reverse?lat=5.5428&lon=-0.2064`, {
      headers: {Authorization: `Bearer ${login.token}`}
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.ok(body2.address && body2.address.length > 5);
    assert.equal(body2.region, 'Greater Accra');
    assert.ok(body2.distanceMeters <= 50);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('V8 - 4. Small Communities & Corridors Coverage across all 6 Authorized Regions', async () => {
  // Test representative ordinary settlements and small towns
  const testCommunities = [
    {query: 'Prampram', expectedRegion: 'Greater Accra'},
    {query: 'Danfa', expectedRegion: 'Greater Accra'},
    {query: 'Amasaman', expectedRegion: 'Greater Accra'},
    {query: 'Gomoa Potsin', expectedRegion: 'Central'},
    {query: 'Awutu Bawjiase', expectedRegion: 'Central'},
    {query: 'Enyan Denkyira', expectedRegion: 'Central'},
    {query: 'Barekese', expectedRegion: 'Ashanti'},
    {query: 'Agona Ashanti', expectedRegion: 'Ashanti'},
    {query: 'Tepa', expectedRegion: 'Ashanti'},
    {query: 'Begoro', expectedRegion: 'Eastern'},
    {query: 'Kwabeng', expectedRegion: 'Eastern'},
    {query: 'Asamankese', expectedRegion: 'Eastern'},
    {query: 'Mim', expectedRegion: 'Ahafo'},
    {query: 'Hwidiem', expectedRegion: 'Ahafo'},
    {query: 'Bechem', expectedRegion: 'Ahafo'},
    {query: 'Fiapre', expectedRegion: 'Bono'},
    {query: 'Abesim', expectedRegion: 'Bono'},
    {query: 'Odumase', expectedRegion: 'Bono'}
  ];

  for (const {query, expectedRegion} of testCommunities) {
    const res = ghanaSearch(query);
    assert.ok(res.length > 0, `Search returned no results for community: ${query}`);
    assert.equal(res[0].region, expectedRegion, `Expected region ${expectedRegion} for ${query}, got ${res[0].region}`);
    assert.ok(res[0].latitude >= 4.5 && res[0].latitude <= 11.4);
    assert.ok(res[0].longitude >= -3.4 && res[0].longitude <= 1.4);
  }
});

test('V8 - 5. Coordinate Selection, Manual Pin Drop, OSRM Road Routing & Dispatch Integration', async () => {
  await migrate(db);
  await db.query('UPDATE riders SET online = false');

  const routingInstance = fixtureRouting(async (a, b) => {
    const dMeters = Math.ceil(haversine(a, b) * 1.28);
    const durSec = Math.max(1, Math.ceil(dMeters / 9.0));
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

  // Rider position near Begoro, Eastern Region
  await dispatcher.riderPosition(rider, {
    latitude: 6.3880,
    longitude: -0.3800,
    accuracyMeters: 6,
    observedAt: new Date().toISOString()
  });

  // Customer selects custom pin drop in Begoro: "6.3885, -0.3810"
  const pinResults = ghanaSearch('6.3885, -0.3810');
  assert.equal(pinResults.length, 1);
  assert.equal(pinResults[0].type, 'coordinate');

  // Customer reverse geocodes the manual pin
  const rev = ghanaReverseGeocode(6.3885, -0.3810);
  assert.equal(rev.region, 'Eastern');

  // Request road-routed delivery quote
  const quote = await app.quote(customer, {
    pickup: {address: 'Begoro Town Center', latitude: 6.3881, longitude: -0.3808},
    destination: {address: rev.address, latitude: pinResults[0].latitude, longitude: pinResults[0].longitude},
    vehicle: 'motorcycle',
    recipientPhone: '+233240001122',
    weightG: 500,
    description: 'Agricultural produce sample',
    paymentMethod: 'CASH'
  });

  assert.ok(quote.amount_minor > 0);
  assert.ok(quote.distanceMeters > 0);
  assert.ok(quote.travelSeconds > 0);

  // Book and dispatch
  const shipment = await app.book(customer, {quoteId: quote.id}, randomUUID());
  assert.equal(shipment.state, 'AWAITING_ASSIGNMENT');

  const offer = await dispatcher.dispatchShipment(shipment.id);
  assert.equal(offer.status, 'offered');
  assert.equal(offer.riderId, rider.id);
});
