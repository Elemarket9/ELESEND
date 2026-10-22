import {database} from '../services/api/db.mjs';

const db = database(process.env.DATABASE_URL);

async function run() {
  const prefixes = await db.query(
    "SELECT split_part(id, '_', 1) as prefix, count(*) as count FROM spatial_landmarks GROUP BY prefix ORDER BY count DESC"
  );
  console.log('ID Prefixes:', prefixes.rows);

  // Check types of landmarks
  const types = await db.query(
    "SELECT category, count(*) FROM spatial_landmarks GROUP BY category ORDER BY count DESC"
  );
  console.log('Categories:', types.rows);

  await db.close();
}

run().catch(console.error);
