import { database } from '../services/api/db.mjs';

const db = database(process.env.TEST_DATABASE_URL);

async function run() {
  try {
    const nbCount = (await db.query('SELECT count(*) FROM national_businesses')).rows[0].count;
    console.log('national_businesses count:', nbCount);
    
    const totalView = (await db.query('SELECT count(*) FROM searchable_landmarks_v9')).rows[0].count;
    console.log('searchable_landmarks_v9 count:', totalView);
    
    const slCount = (await db.query('SELECT count(*) FROM spatial_landmarks')).rows[0].count;
    console.log('spatial_landmarks count (preserved baseline):', slCount);
    
    const alsRows = (await db.query("SELECT name, locality, city, region, latitude, longitude, coordinate_kind FROM national_businesses WHERE name ILIKE '%ALS Shipping%'")).rows;
    console.log('\nALS Shipping records in PostgreSQL:');
    alsRows.forEach(r => console.log('  -', r.name, `(${r.locality}, ${r.region})`, `[${r.latitude}, ${r.longitude}]`, r.coordinate_kind));

    const regions = (await db.query("SELECT region, count(*) FROM searchable_landmarks_v9 GROUP BY region ORDER BY count DESC")).rows;
    console.log('\nRegion breakdown in searchable_landmarks_v9:');
    regions.forEach(r => console.log('  -', r.region + ':', r.count));
  } finally {
    await db.close();
  }
}

run().catch(console.error);
