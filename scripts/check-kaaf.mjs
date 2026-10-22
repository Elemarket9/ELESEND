import {database} from '../services/api/db.mjs';

const db = database(process.env.DATABASE_URL);

async function run() {
  const res = await db.query(
    "SELECT id, name, category, locality, city, region, latitude, longitude, popularity, entrance FROM spatial_landmarks WHERE name ILIKE '%kaaf%' ORDER BY id"
  );
  console.log('KAAF in DB:', res.rows);
  await db.close();
}

run().catch(console.error);
