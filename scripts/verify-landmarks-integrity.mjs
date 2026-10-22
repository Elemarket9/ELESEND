import {database} from '../services/api/db.mjs';

const db = database(process.env.DATABASE_URL);

async function run() {
  console.log('=== DATA INTEGRITY AUDIT OF SPATIAL_LANDMARKS ===');

  // 1. Total and uniqueness
  const countRow = (await db.query(`
    SELECT 
      count(*) as total,
      count(DISTINCT id) as unique_ids,
      count(DISTINCT (round(latitude::numeric, 6) || ',' || round(longitude::numeric, 6) || ',' || lower(name))) as unique_name_coords,
      count(DISTINCT region) as regions
    FROM spatial_landmarks
  `)).rows[0];
  console.log('Counts:', countRow);

  // 2. Breakdown by coordinate_kind
  const coordKinds = (await db.query(`
    SELECT coordinate_kind, count(*) as count
    FROM spatial_landmarks
    GROUP BY coordinate_kind
    ORDER BY count DESC
  `)).rows;
  console.log('\nCoordinate Kinds:', coordKinds);

  // 3. Breakdown by category & subcategory
  const categories = (await db.query(`
    SELECT category, count(*) as count
    FROM spatial_landmarks
    GROUP BY category
    ORDER BY count DESC
  `)).rows;
  console.log('\nCategories:', categories);

  // 4. Breakdown by source and source_id traceability
  const sources = (await db.query(`
    SELECT source, count(*) as count, count(source_id) as with_source_id
    FROM spatial_landmarks
    GROUP BY source
    ORDER BY count DESC
  `)).rows;
  console.log('\nSources:', sources);

  // 5. Verification status
  const statuses = (await db.query(`
    SELECT verification_status, count(*) as count
    FROM spatial_landmarks
    GROUP BY verification_status
    ORDER BY count DESC
  `)).rows;
  console.log('\nVerification Statuses:', statuses);

  // 6. Delivery entrances and aliases
  const details = (await db.query(`
    SELECT 
      count(*) FILTER (WHERE entrance IS NOT NULL) as with_entrance,
      count(*) FILTER (WHERE jsonb_array_length(aliases) > 0) as with_aliases,
      count(*) FILTER (WHERE popularity > 70) as high_popularity
    FROM spatial_landmarks
  `)).rows[0];
  console.log('\nEntrances, Aliases, Popularity:', details);

  // 7. Check by region
  const byRegion = (await db.query(`
    SELECT region, count(*) as count
    FROM spatial_landmarks
    GROUP BY region
    ORDER BY count DESC
  `)).rows;
  console.log('\nBy Region:', byRegion);

  await db.close();
}

run().catch(console.error);
