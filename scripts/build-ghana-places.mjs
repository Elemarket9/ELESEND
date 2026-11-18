// Builds ghana-osm-places.json from an OpenStreetMap GeoJSONSeq export.
// Usage: node scripts/build-ghana-places.mjs <ghana-named.geojsonseq> <out.json>
// Prints how many features were kept and why the rest were dropped. Roads are a separate file.
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {classifyOsmTags, emptyAreaCounts, geometryCentre, inGhana, nearbyNamed, placeFromFeature, placeGrid, readGeoJsonSeq} from './place-import.mjs';

const [,, input, output] = process.argv;
if (!input || !output) { console.error('Usage: node scripts/build-ghana-places.mjs <ghana-named.geojsonseq> <out.json>'); process.exit(2); }
const mapsDir = join(dirname(fileURLToPath(import.meta.url)), '../services/api/modules/maps');
const curated = [...JSON.parse(readFileSync(join(mapsDir, 'ghana-gazetteer-data.json'), 'utf8')),
  ...JSON.parse(readFileSync(join(mapsDir, 'ghana-places-overlay.json'), 'utf8'))].filter(place => place.category === 'settlement' || place.category === 'town' || place.latitude);
const towns = curated.filter(place => place.category === 'settlement' || place.category === 'town');
const grid = placeGrid(curated);
const townGrid = placeGrid(towns);

function nearestTown(point) {
  let best = null, bestDistance = Infinity;
  const lat = Math.floor(point.latitude * 100), lon = Math.floor(point.longitude * 100);
  for (const rings of [2, 6, 12]) {
    for (let i = -rings; i <= rings; i++) for (let j = -rings; j <= rings; j++) {
      for (const town of townGrid.get(`${lat + i}:${lon + j}`) || []) {
        const distance = Math.hypot((point.latitude - town.latitude) * 111320, (point.longitude - town.longitude) * 111320);
        if (distance < bestDistance) { best = town; bestDistance = distance; }
      }
    }
    if (best) return best;
  }
  return null;
}

const kept = [];
const byArea = emptyAreaCounts();
const {read, droppedByReason} = await readGeoJsonSeq(input, (feature, drop) => {
  const classified = classifyOsmTags(feature.properties || {});
  if (classified.drop) { drop(classified.drop); return; }
  if (classified.kind === 'road') { drop('road_indexed_separately'); return; }
  const at = geometryCentre(feature.geometry);
  if (!at) { drop('no_geometry'); return; }
  if (!inGhana(at)) { drop('outside_ghana'); return; }
  if (nearbyNamed(grid, at, classified.name)) { drop('duplicate_curated'); return; }
  const built = placeFromFeature(feature, classified);
  if (built.drop) { drop(built.drop); return; }
  const town = nearestTown(at);
  const place = built.place;
  place.locality = feature.properties?.['addr:suburb'] || feature.properties?.['addr:place'] || town?.locality || town?.name || '';
  place.city = feature.properties?.['addr:city'] || town?.city || '';
  place.region = town?.region || '';
  place.popularity = feature.properties?.brand || feature.properties?.wikidata ? 40 : 25;
  kept.push(place);
  byArea[place.area] = (byArea[place.area] || 0) + 1;
  if (!grid.has(`${Math.floor(place.latitude * 100)}:${Math.floor(place.longitude * 100)}`)) grid.set(`${Math.floor(place.latitude * 100)}:${Math.floor(place.longitude * 100)}`, []);
  grid.get(`${Math.floor(place.latitude * 100)}:${Math.floor(place.longitude * 100)}`).push(place);
});
writeFileSync(output, JSON.stringify(kept));
const byCategory = kept.reduce((counts, place) => (counts[place.category] = (counts[place.category] || 0) + 1, counts), {});
console.log(JSON.stringify({read, added: kept.length, skipped: read - kept.length, droppedByReason, byCategory, byArea, bytes: Buffer.byteLength(JSON.stringify(kept))}));
