// Turns an Overture Maps Places GeoJSON (or GeoJSONSeq) extract into unverified search rows.
// Only Greater Accra, Kumasi metro and the Central Region are kept. Curated names within 150 m are skipped.
// Usage: node scripts/import-overture-places.mjs <places.geojson> <out.json> [release-id]
// Download a bbox yourself (this does not call a paid API). Example with the Overture CLI:
//   overturemaps download --bbox=-1.55,5.00,0.25,6.85 -f geojson --type=place -o places.geojson
import {readFileSync, writeFileSync} from 'node:fs';
import {overturePlace, placeGrid} from './place-import.mjs';

const [,, input, output, release = ''] = process.argv;
if (!input || !output) { console.error('Usage: node scripts/import-overture-places.mjs <places.geojson> <out.json> [release-id]'); process.exit(2); }
const raw = readFileSync(input, 'utf8');
const features = raw.trim().startsWith('{')
  ? (JSON.parse(raw).features || [JSON.parse(raw)])
  : raw.split(/\n/).filter(Boolean).map(line => JSON.parse(line.replace(/^\x1e/, '')));
let curated = [];
try { curated = JSON.parse(readFileSync(new URL('../services/api/infrastructure/maps/ghana-gazetteer-data.json', import.meta.url), 'utf8')); } catch { curated = []; }
const grid = placeGrid(curated);
const kept = [];
const droppedByReason = {};
const byArea = {greater_accra: 0, kumasi: 0, central: 0, other: 0};
for (const feature of features) {
  const decision = overturePlace(feature, {release, grid});
  if (decision.drop) { droppedByReason[decision.drop] = (droppedByReason[decision.drop] || 0) + 1; continue; }
  kept.push(decision.place);
  byArea[decision.place.area] += 1;
}
writeFileSync(output, JSON.stringify(kept));
console.log(JSON.stringify({release, read: features.length, added: kept.length, droppedByReason, byArea, license: 'CDLA-Permissive-2.0', verification_status: 'unverified'}));
