import {writeFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {database} from '../services/api/db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const db = database(process.env.DATABASE_URL);

async function run() {
  console.log('Syncing ghana-gazetteer-data.json directly from PostgreSQL `spatial_landmarks`...');
  
  const res = await db.query(`
    SELECT 
      name,
      category,
      locality,
      city,
      region,
      latitude,
      longitude,
      popularity,
      aliases,
      street,
      entrance
    FROM spatial_landmarks
    ORDER BY popularity DESC, id ASC
  `);

  const records = res.rows.map(r => ({
    name: r.name,
    category: r.category,
    locality: r.locality,
    city: r.city,
    region: r.region,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    popularity: Number(r.popularity),
    aliases: r.aliases || [],
    street: r.street || null,
    entrance: r.entrance || null
  }));

  const jsonPath = join(projectRoot, 'services', 'api', 'infrastructure', 'maps', 'ghana-gazetteer-data.json');
  writeFileSync(jsonPath, JSON.stringify(records), 'utf8');

  console.log(`Successfully synced ${records.length} records to ${jsonPath}`);
  await db.close();
}

run().catch(console.error);
