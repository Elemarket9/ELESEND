// Loads OpenStreetMap places, named roads and Overture places into spatial_landmarks.
// Unverified rows never replace a curated (non-unverified) place with the same name within 150 m.
// Usage: DATABASE_URL=... node scripts/load-search-places.mjs <places.json> [roads.json] [overture.json]
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {INSERT_LANDMARKS_SQL, landmarkRecord} from './place-import.mjs';

const files = process.argv.slice(2);
if (!files.length) { console.error('Usage: node scripts/load-search-places.mjs <json> [more.json]'); process.exit(2); }
const records = [];
for (const file of files) {
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(rows)) throw Error(`${file} must be a JSON array`);
  for (const place of rows) {
    if (place.housenumber) throw Error(`${place.name} carries a house number. Road import must not invent one.`);
    records.push(landmarkRecord(place));
  }
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
let loaded = 0;
for (let start = 0; start < records.length; start += 500) {
  const slice = records.slice(start, start + 500);
  const result = await pool.query(INSERT_LANDMARKS_SQL, [JSON.stringify(slice)]);
  loaded += result.rowCount;
}
await pool.end();
console.log(JSON.stringify({offered: records.length, written: loaded}));
