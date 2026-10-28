import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import {pathToFileURL} from 'node:url';

const { Pool } = pg;

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        if (ch === '\r') i++;
        row.push(field);
        if (row.length > 1 || row[0] !== '') {
          rows.push(row);
        }
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] ?? '';
    });
    return obj;
  });
}

function deterministicUuid(seed) {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    'a' + hash.slice(17, 20),
    hash.slice(20, 32)
  ].join('-');
}

export async function importToDb(connectionString, dbName) {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    console.log(`\nImporting audited mapped restaurants into ${dbName}...`);

    // Ensure migration 044 columns & partial index exist
    const mig044 = fs.readFileSync('database/migrations/044_restaurant_quality_and_spatial_index_hardening.sql', 'utf-8');
    await client.query(mig044);

    // Clean idempotent import
    await client.query('TRUNCATE TABLE mapped_restaurants;');

    const csvText = fs.readFileSync('data/restaurants/ghana_restaurants_all.csv', 'utf-8');
    const records = parseCsv(csvText);

    // Check if an approved Asanka Palace merchant exists in restaurants table
    const regRes = await client.query("SELECT id, name FROM restaurants WHERE status = 'active' AND name ILIKE '%asanka%' LIMIT 1");
    const asankaMerchantId = regRes.rows[0]?.id || null;

    const batch = [];
    let totalImported = 0;
    const egiaCandidates = [];

    for (const r of records) {
      let isReg = false;
      let merchantId = null;

      if (
        asankaMerchantId &&
        r.name &&
        r.name.toLowerCase().includes('asanka') &&
        (r.street?.toLowerCase().includes('ring road') || r.community?.toLowerCase().includes('accra') || r.region === 'Greater Accra') &&
        !batch.some(b => b[20] === true) &&
        totalImported === 0
      ) {
        // Link at most the single canonical Asanka Local branch if present
        if (r.name.toLowerCase().includes('asanka local')) {
          isReg = true;
          merchantId = asankaMerchantId;
        }
      }

      const confNorm = Math.min(0.999, Math.max(0.100, parseFloat(r.confidence_score || '70') / 100.0));

      batch.push([
        r.restaurant_id,
        r.name,
        r.normalized_name ? [r.normalized_name] : [],
        r.category,
        r.category_group || 'restaurants_and_chop_bars',
        r.cuisine || null,
        parseFloat(r.latitude),
        parseFloat(r.longitude),
        'Ghana',
        r.region,
        r.district || null,
        r.community || null,
        r.street || null,
        r.phone || null,
        r.opening_hours || null, // Strictly null when unknown - no synthetic defaults!
        r.source,
        r.license,
        r.source_id || null,
        confNorm.toFixed(3),
        isReg,
        merchantId,
        r.category_group || 'restaurants_and_chop_bars',
        r.coordinate_kind || 'mapped_point',
        r.verification_status || 'source_coordinates_not_field_verified',
        r.corroborated_sources || r.source
      ]);

      if (r.verification_status === 'needs_verification') {
        egiaCandidates.push({
          id: deterministicUuid(`egia-rest-audit:${r.restaurant_id}`),
          name: r.name,
          search_name: (r.normalized_name || r.name).toLowerCase(),
          category: 'restaurant_verification',
          subcategory: r.category,
          region: r.region,
          locality: r.community || r.region,
          city: r.district || r.region,
          lat: parseFloat(r.latitude),
          lon: parseFloat(r.longitude),
          confidence: parseInt(r.confidence_score || '60', 10),
          source: r.source,
          source_id: r.restaurant_id,
          license: r.license,
          evidence: {
            queue_reason: r.coordinate_kind === 'building_centroid'
              ? 'building_polygon_centroid_needs_entrance_pin'
              : 'coordinate_road_proximity_review',
            coordinate_kind: r.coordinate_kind,
            category_group: r.category_group
          }
        });
      }

      if (batch.length >= 250) {
        await insertBatch(client, batch);
        totalImported += batch.length;
        batch.length = 0;
      }
    }

    if (batch.length > 0) {
      await insertBatch(client, batch);
      totalImported += batch.length;
      batch.length = 0;
    }

    // Also load held-out near-duplicates into EGIA candidate_landmarks verification queue
    if (fs.existsSync('data/restaurants/restaurants_possible_duplicates.csv')) {
      const nearDups = parseCsv(fs.readFileSync('data/restaurants/restaurants_possible_duplicates.csv', 'utf-8'));
      for (const nd of nearDups) {
        egiaCandidates.push({
          id: deterministicUuid(`egia-neardup:${nd.candidate_source_id}:${nd.near_restaurant_id}`),
          name: nd.candidate_name,
          search_name: nd.candidate_name.toLowerCase(),
          category: 'restaurant_verification',
          subcategory: nd.candidate_category || 'restaurant',
          region: nd.region || 'Greater Accra',
          locality: nd.community || nd.region || 'Accra',
          city: nd.district || nd.region || 'Accra',
          lat: parseFloat(nd.candidate_lat),
          lon: parseFloat(nd.candidate_lon),
          confidence: 50,
          source: nd.candidate_source,
          source_id: nd.candidate_source_id,
          license: 'ODbL-1.0 / CDLA-Permissive-2.0',
          evidence: {
            queue_reason: 'unreviewed_near_duplicate',
            near_restaurant_id: nd.near_restaurant_id,
            near_name: nd.near_name,
            distance_m: parseFloat(nd.distance_m || '0'),
            name_similarity: parseFloat(nd.name_similarity || '0')
          }
        });
      }
    }

    // Upsert EGIA verification queue items into candidate_landmarks
    await client.query("DELETE FROM candidate_landmarks WHERE category = 'restaurant_verification'");
    for (const c of egiaCandidates) {
      await client.query(
        `INSERT INTO candidate_landmarks (
           id, name, search_name, category, subcategory, region, locality, city,
           location, confidence, source, source_id, license, verification_status, evidence
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           ST_SetSRID(ST_MakePoint($9, $10), 4326)::geography,
           $11, $12, $13, $14, 'REVIEW_REQUIRED', $15::jsonb
         ) ON CONFLICT (id) DO UPDATE SET
           verification_status = 'REVIEW_REQUIRED',
           evidence = EXCLUDED.evidence,
           updated_at = now()`,
        [
          c.id, c.name, c.search_name, c.category, c.subcategory,
          c.region, c.locality, c.city, c.lon, c.lat,
          c.confidence, c.source, c.source_id, c.license, JSON.stringify(c.evidence)
        ]
      );
    }

    await client.query('ANALYZE mapped_restaurants;');
    await client.query('ANALYZE candidate_landmarks;');

    console.log(`Successfully imported ${totalImported} unique restaurants into ${dbName}.`);
    console.log(`Queued ${egiaCandidates.length} uncertain/near-duplicate locations into candidate_landmarks (REVIEW_REQUIRED).`);
  } finally {
    client.release();
    await pool.end();
  }
}

async function insertBatch(client, batch) {
  const values = [];
  const params = [];
  let pIdx = 1;

  for (const row of batch) {
    const placeholders = [];
    for (let i = 0; i < row.length; i++) {
      placeholders.push(`$${pIdx++}`);
      params.push(row[i]);
    }
    values.push(`(${placeholders.join(', ')})`);
  }

  const sql = `
    INSERT INTO mapped_restaurants (
      restaurant_id, name, alternative_names, category, subcategory, cuisine,
      latitude, longitude, country, region, district, community, street_address,
      phone_number, opening_hours, source_name, source_license, source_record_id,
      confidence_score, is_registered_merchant, registered_merchant_id,
      category_group, coordinate_kind, verification_status, corroborated_sources
    ) VALUES ${values.join(', ')}
    ON CONFLICT (restaurant_id) DO UPDATE SET
      name = EXCLUDED.name,
      category = EXCLUDED.category,
      subcategory = EXCLUDED.subcategory,
      category_group = EXCLUDED.category_group,
      coordinate_kind = EXCLUDED.coordinate_kind,
      verification_status = EXCLUDED.verification_status,
      corroborated_sources = EXCLUDED.corroborated_sources,
      region = EXCLUDED.region,
      district = EXCLUDED.district,
      community = EXCLUDED.community,
      opening_hours = EXCLUDED.opening_hours,
      confidence_score = EXCLUDED.confidence_score,
      updated_at = now();
  `;
  await client.query(sql, params);
}

async function main() {
  const devUrl = process.env.DATABASE_URL || 'postgres://elesend@127.0.0.1:5433/elesend';
  const testUrl = process.env.TEST_DATABASE_URL || 'postgres://elesend@127.0.0.1:5433/elesend_test';
  await importToDb(devUrl, 'elesend (dev)');
  await importToDb(testUrl, 'elesend_test (test)');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(err => {
  console.error(err);
  process.exit(1);
});
