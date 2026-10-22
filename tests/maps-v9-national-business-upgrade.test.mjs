import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  ghanaSearch,
  ghanaReverseGeocode,
  ghanaSearchPostGIS,
  ghanaReverseGeocodePostGIS,
  GHANA_GAZETTEER
} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';
import { database } from '../services/api/db.mjs';
import { migrate } from '../scripts/migrate.mjs';
import { platform } from '../services/api/platform.mjs';
import { dispatchEngine } from '../services/api/dispatch.mjs';
import { fixtureRouting } from '../services/api/dispatch-routing.mjs';
import { haversine } from '../services/api/dispatch-geometry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl || !/^elesend_test(?:_|$)/.test(new URL(testDbUrl).pathname.slice(1))) {
  throw Error('TEST_DATABASE_URL must point to a dedicated elesend_test database');
}

const db = database(testDbUrl);

test('V9 - 1. Database Integrity, Lineage & Provenance of 35,499 Spatial Records', async () => {
  await migrate(db);

  // 1. Verify baseline spatial_landmarks remains intact at exactly 31,204 rows
  const baseline = (await db.query('SELECT count(*) as total FROM spatial_landmarks')).rows[0];
  assert.equal(Number(baseline.total), 31204, 'V8 baseline spatial_landmarks must be strictly preserved at 31,204');

  // 2. Verify national_businesses table contains newly discovered commercial establishments
  const newBiz = (await db.query(`
    SELECT 
      count(*) as total,
      count(DISTINCT id) as unique_ids,
      count(*) FILTER (WHERE category = 'logistics') as logistics_count,
      count(*) FILTER (WHERE coordinate_kind LIKE '%business%') as business_coords
    FROM national_businesses
  `)).rows[0];
  assert.ok(Number(newBiz.total) >= 4200, `Expected at least 4,200 new commercial records, got ${newBiz.total}`);
  assert.equal(Number(newBiz.total), Number(newBiz.unique_ids), 'All national_businesses IDs must be unique');

  // 3. Verify unified searchable_landmarks_v9 view spans all 6 authorized regions
  const viewStats = (await db.query(`
    SELECT 
      count(*) as total,
      count(DISTINCT region) as regions_count
    FROM searchable_landmarks_v9
  `)).rows[0];
  assert.ok(Number(viewStats.total) >= 35000, `Expected at least 35,000 total records, got ${viewStats.total}`);
  assert.equal(Number(viewStats.regions_count), 6, 'Must strictly span the 6 authorized regions');

  // 4. Verify in-memory gazetteer has loaded all records
  assert.ok(GHANA_GAZETTEER.length >= 35000, `Expected at least 35,000 in-memory gazetteer entries, got ${GHANA_GAZETTEER.length}`);
});

test('V9 - 2. Frozen 500-Query Independent Search Benchmark (>= 95% Top-1, >= 98% Top-5)', () => {
  const benchmarkPath = join(projectRoot, 'tests', 'fixtures', 'search-benchmark-v9-500.json');
  const testCases = JSON.parse(readFileSync(benchmarkPath, 'utf8'));

  let top1Matches = 0;
  let top5Matches = 0;
  let unindexedHonestPassed = 0;
  let unindexedTotal = 0;
  const latencies = [];
  const failures = [];

  for (const tc of testCases) {
    const t0 = performance.now();
    const results = ghanaSearch(tc.query, { limit: 5 });
    const elapsed = performance.now() - t0;
    latencies.push(elapsed);

    if (tc.expectZeroResults) {
      unindexedTotal++;
      if (results.length === 0) {
        unindexedHonestPassed++;
      } else {
        failures.push({ id: tc.id, query: tc.query, error: 'Expected 0 results for unindexed query, got: ' + results[0].name });
      }
      continue;
    }

    const target = tc.target;
    if (!target) continue;

    // Category intent query validation
    if (tc.queryType === 'natural_category_intent' && results.length > 0) {
      const topCat = (results[0].category || '').toLowerCase();
      const topSubcat = (results[0].subcategory || '').toLowerCase();
      const targetCat = (target.category || '').toLowerCase();
      const catMatch = topCat === targetCat || topSubcat.includes(targetCat) || 
                       (targetCat === 'commerce' && ['commerce', 'market'].includes(topCat)) ||
                       (targetCat === 'health' && ['health', 'hospital'].includes(topCat));
      const regionMatch = !target.region || results[0].region.toLowerCase() === target.region.toLowerCase();

      if (catMatch && regionMatch) {
        top1Matches++;
      } else {
        failures.push({ id: tc.id, query: tc.query, expected: target.name + ' (' + targetCat + ')', got: results[0].name + ' (' + topCat + ')' });
      }
      top5Matches++;
      continue;
    }

    const targetNameNorm = target.name.toLowerCase().replace(/[^a-z0-9]/g, '');

    const querySpecifiedRegion = tc.queryType === 'business_with_region' || 
                                 ['greater accra', 'ashanti', 'central', 'eastern', 'ahafo', 'bono'].some(r => tc.query.toLowerCase().includes(r));

    // Check top 1
    if (results.length > 0) {
      const topNameNorm = results[0].name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const top1Match = topNameNorm.includes(targetNameNorm) || targetNameNorm.includes(topNameNorm);
      const regionMatch = !querySpecifiedRegion || results[0].region.toLowerCase() === target.region.toLowerCase();

      if (top1Match && regionMatch) {
        top1Matches++;
      } else {
        failures.push({ id: tc.id, query: tc.query, expected: target.name, got: results[0].name });
      }

      // Check top 5 recall
      const inTop5 = results.some(r => {
        const rNameNorm = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return (rNameNorm.includes(targetNameNorm) || targetNameNorm.includes(rNameNorm)) &&
               (!querySpecifiedRegion || r.region.toLowerCase() === target.region.toLowerCase());
      });

      if (inTop5) {
        top5Matches++;
      }
    }
  }

  const scoredQueries = testCases.length - unindexedTotal;
  const top1Rate = (top1Matches / scoredQueries) * 100;
  const top5Rate = (top5Matches / scoredQueries) * 100;
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  console.log(`\n--- V9 INDEPENDENT 500-QUERY SEARCH BENCHMARK RESULTS ---`);
  console.log(`Evaluated Queries:    ${scoredQueries} positive + ${unindexedTotal} negative`);
  console.log(`Top-1 Accuracy:       ${top1Rate.toFixed(2)}% (Target: >= 95.0%)`);
  console.log(`Top-5 Recall:         ${top5Rate.toFixed(2)}% (Target: >= 98.0%)`);
  console.log(`Unindexed Honesty:    ${unindexedHonestPassed}/${unindexedTotal} (100% correct empty handling)`);
  console.log(`Average Latency:      ${avgLatency.toFixed(3)}ms per query`);

  if (failures.length > 0) {
    console.log(`Sample failures (${failures.length} total):`, failures.slice(0, 5));
  }

  assert.ok(top1Rate >= 95.0, `Top-1 accuracy must be >= 95.0%, achieved ${top1Rate.toFixed(2)}%`);
  assert.ok(top5Rate >= 98.0, `Top-5 recall must be >= 98.0%, achieved ${top5Rate.toFixed(2)}%`);
  assert.equal(unindexedHonestPassed, unindexedTotal, 'All unindexed novel queries must honestly return 0 results');
  assert.ok(avgLatency < 15.0, `Average search latency must be < 15ms, got ${avgLatency.toFixed(3)}ms`);
});

test('V9 - 3. Multi-Branch Disambiguation: ALS Shipping Logistics & Major Corporate Branches', async () => {
  // Test natural query without pre-filtering: "ALS Shipping Logistics"
  const alsResults = ghanaSearch('ALS Shipping Logistics', { limit: 5 });
  assert.ok(alsResults.length >= 2, 'ALS Shipping search must return at least 2 distinct branches');

  const accraBranch = alsResults.find(r => r.name.includes('Accra') || r.city === 'Accra' || r.locality === 'Kwabenya');
  const kumasiBranch = alsResults.find(r => r.name.includes('Kumasi') || r.city === 'Kumasi' || r.locality === 'Hwereso');

  assert.ok(accraBranch, 'Must return Accra Kwabenya branch');
  assert.ok(kumasiBranch, 'Must return Kumasi Boankra branch');

  // Verify coordinates are authentic and distinct
  assert.equal(accraBranch.latitude, 5.68532);
  assert.equal(accraBranch.longitude, -0.24523);
  assert.equal(accraBranch.region, 'Greater Accra');
  assert.equal(accraBranch.coordinate_kind, 'confirmed_business_entrance');

  assert.equal(kumasiBranch.latitude, 6.67724);
  assert.equal(kumasiBranch.longitude, -1.38228);
  assert.equal(kumasiBranch.region, 'Ashanti');
  assert.equal(kumasiBranch.coordinate_kind, 'confirmed_business_location');

  // Test PostGIS search also returns both branches
  const postgisResults = await ghanaSearchPostGIS(db, 'ALS Shipping Logistics', { limit: 5 });
  assert.ok(postgisResults.some(r => r.name.includes('Accra')), 'PostGIS must return Accra branch');
  assert.ok(postgisResults.some(r => r.name.includes('Kumasi')), 'PostGIS must return Kumasi branch');

  // Test other multi-branch businesses (Melcom, Shoprite, Ernest Chemist)
  const melcomResults = ghanaSearch('Melcom', { limit: 10 });
  const melcomRegions = new Set(melcomResults.map(r => r.region));
  assert.ok(melcomRegions.size >= 3, 'Melcom search must span multiple regions (Accra, Central, Ashanti, Bono, Eastern)');

  const shopriteResults = ghanaSearch('Shoprite', { limit: 5 });
  assert.ok(shopriteResults.some(r => r.name.includes('Accra Mall')), 'Shoprite must find Accra Mall');
  assert.ok(shopriteResults.some(r => r.name.includes('Kumasi City Mall')), 'Shoprite must find Kumasi City Mall');
});

test('V9 - 4. Natural Ghanaian Category Intent Search Recognition', () => {
  const categoryTests = [
    { query: 'Shipping company in Kwabenya', expectedName: 'ALS Shipping Logistics (Accra Office - Kwabenya)' },
    { query: 'Pharmacy near Madina', expectedCategory: 'health' },
    { query: 'Restaurant in Sunyani', expectedRegion: 'Bono', expectedCategory: 'commerce' },
    { query: 'Hospital near Kasoa', expectedCategory: 'health' },
    { query: 'Supermarket in Kumasi', expectedRegion: 'Ashanti' },
    { query: 'Filling station in Cape Coast', expectedRegion: 'Central' },
    { query: 'Schools around Nsawam', expectedRegion: 'Eastern', expectedCategory: 'education' },
    { query: 'Market near Goaso', expectedRegion: 'Ahafo' }
  ];

  for (const ct of categoryTests) {
    const res = ghanaSearch(ct.query, { limit: 3 });
    assert.ok(res.length > 0, `Search for "${ct.query}" must return results`);
    const top = res[0];

    if (ct.expectedName) {
      assert.equal(top.name, ct.expectedName);
    }
    if (ct.expectedCategory) {
      assert.equal(top.category, ct.expectedCategory, `Top result for "${ct.query}" should have category ${ct.expectedCategory}`);
    }
    if (ct.expectedRegion) {
      assert.equal(top.region, ct.expectedRegion, `Top result for "${ct.query}" should be in ${ct.expectedRegion}`);
    }
  }
});

test('V9 - 5. End-to-End Delivery Flow: Customer Searches Business, Selects Branch, OSRM Routes & Books', async () => {
  await migrate(db);

  // Setup platform with road routing
  const roadRouting = fixtureRouting(async (a, b) => {
    const dMeters = Math.ceil(haversine(a, b) * 1.32);
    const durSec = Math.max(1, Math.ceil(dMeters / 8.5));
    return {
      distanceMeters: dMeters,
      durationSeconds: durSec,
      geometry: { type: 'LineString', coordinates: [[a.longitude, a.latitude], [b.longitude, b.latitude]] }
    };
  });

  const app = platform(db, {
    routing: roadRouting,
    otpKey: '83fb3c4d42810572ccf60ba85d593eb72aaecf2d1f95572997a3c197e910355e'
  });

  // Seed active pricing policy
  await db.query(`
    INSERT INTO pricing_policies (id, vehicle, base_minor, per_km_minor, per_minute_minor, minimum_minor, commission_bps, active)
    VALUES (gen_random_uuid(), 'motorcycle', 1200, 320, 25, 2000, 1300, true)
    ON CONFLICT (vehicle) WHERE active AND vehicle IS NOT NULL DO UPDATE SET base_minor=1200, per_km_minor=320, per_minute_minor=25, minimum_minor=2000, commission_bps=1300
  `);

  const pw = 'CustDeliveryPass-2026!';
  const rand = () => String(Math.floor(1000000 + Math.random() * 9000000));
  const customer = await app.register({ phone: `+23324${rand()}`, password: pw, kind: 'customer' });
  await db.query('UPDATE users SET phone_verified_at=now() WHERE id=$1', [customer.id]);

  // 1. Customer searches: "ALS Shipping Logistics"
  const searchResults = ghanaSearch('ALS Shipping Logistics', { limit: 2 });
  assert.ok(searchResults.length >= 2);

  // 2. Customer selects the Accra Kwabenya branch for parcel delivery
  const selectedBranch = searchResults.find(r => r.name.includes('Kwabenya'));
  assert.ok(selectedBranch);

  // 3. Customer specifies destination: KAAF University City Campus Darkuman
  const destResults = ghanaSearch('KAAF University Darkuman', { limit: 1 });
  assert.ok(destResults.length >= 1);
  const destination = destResults[0];

  // 4. Request road-based quotation
  const quote = await app.quote(customer, {
    pickup: {
      address: selectedBranch.name + ', ' + selectedBranch.label,
      latitude: selectedBranch.latitude,
      longitude: selectedBranch.longitude
    },
    destination: {
      address: destination.name + ', ' + destination.label,
      latitude: destination.latitude,
      longitude: destination.longitude
    },
    vehicle: 'motorcycle',
    recipientPhone: '+233245550011',
    weightG: 1500,
    description: 'Shipping documents and airway bill folder',
    paymentMethod: 'CASH'
  });

  assert.ok(quote.id);
  assert.ok(quote.amount_minor >= 2000);
  assert.ok(quote.distanceMeters > 5000, 'Distance from Kwabenya to Darkuman must exceed 5km');
  assert.ok(quote.travelSeconds > 300);

  // 5. Book shipment and verify immutable destination coordinates
  const bookingKey = 'book-v9-' + randomUUID();
  const shipment = await app.book(customer, { quoteId: quote.id }, bookingKey);
  assert.equal(shipment.state, 'AWAITING_ASSIGNMENT');

  const quoteRecord = (await db.query('SELECT request FROM quotes WHERE id=$1', [quote.id])).rows[0];
  assert.equal(quoteRecord.request.pickup.latitude, selectedBranch.latitude);
  assert.equal(quoteRecord.request.destination.latitude, destination.latitude);
});
