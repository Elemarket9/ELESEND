// Builds services/api/infrastructure/maps/ghana-osm-places.json from an OpenStreetMap GeoJSONSeq export of Ghana.
// Use scripts/build-ghana-places.sh, which makes the export. Usage: node scripts/build-ghana-places.mjs <export> <out>
// Keeps named businesses and landmarks a customer would send to or from, drops places the built-in list already has
// (same name within 150 m), and fills in town and region from the nearest known settlement.
import {createReadStream, readFileSync, writeFileSync} from 'node:fs';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const [,, input, output] = process.argv;
if (!input || !output) { console.error('Usage: node scripts/build-ghana-places.mjs <ghana-named.geojsonseq> <out.json>'); process.exit(2); }
const mapsDir = join(dirname(fileURLToPath(import.meta.url)), '../services/api/infrastructure/maps');
const curated = [...JSON.parse(readFileSync(join(mapsDir, 'ghana-gazetteer-data.json'), 'utf8')),
  ...JSON.parse(readFileSync(join(mapsDir, 'ghana-places-overlay.json'), 'utf8'))];

// OpenStreetMap tag -> ELESEND category. Anything not listed is not a delivery destination.
const CATEGORY = [
  ['aeroway', {terminal: 'airport', aerodrome: 'airport'}],
  ['amenity', {bank: 'bank', atm: null, hospital: 'health', clinic: 'health', doctors: 'health', pharmacy: 'health', dentist: 'health',
    school: 'education', college: 'education', university: 'education', kindergarten: 'education', restaurant: 'commerce', fast_food: 'commerce',
    cafe: 'commerce', bar: 'commerce', pub: 'commerce', fuel: 'transport', bus_station: 'transport', marketplace: 'market', police: 'public_service',
    post_office: 'logistics', courthouse: 'public_service', townhall: 'public_service', place_of_worship: 'religion', hotel: 'commerce',
    community_centre: 'landmark', events_venue: 'landmark', cinema: 'leisure', theatre: 'leisure', library: 'education', car_rental: 'commerce'}],
  ['shop', '*commerce'], ['office', '*commerce'], ['craft', '*commerce'],
  ['tourism', {hotel: 'commerce', guest_house: 'commerce', motel: 'commerce', hostel: 'commerce', attraction: 'landmark', museum: 'landmark'}],
  ['healthcare', '*health'], ['public_transport', {station: 'transport'}], ['railway', {station: 'transport'}],
  ['leisure', {stadium: 'leisure', park: 'leisure', sports_centre: 'leisure'}],
  ['building', {commercial: 'commerce', retail: 'commerce', hospital: 'health', school: 'education', university: 'education', hotel: 'commerce'}],
];
function categoryOf(tags) {
  for (const [key, map] of CATEGORY) {
    const value = tags[key];
    if (!value) continue;
    if (typeof map === 'string') return {category: map.slice(1), subcategory: key === 'shop' || key === 'office' || key === 'craft' ? value : key};
    if (value in map) return map[value] ? {category: map[value], subcategory: value} : null;
  }
  return null;
}
const centre = geometry => {
  const points = [];
  (function walk(a) { if (typeof a[0] === 'number') points.push(a); else a.forEach(walk); })(geometry.coordinates);
  return {longitude: points.reduce((s, p) => s + p[0], 0) / points.length, latitude: points.reduce((s, p) => s + p[1], 0) / points.length};
};
const metres = (a, b) => Math.hypot((a.latitude - b.latitude) * 111320, (a.longitude - b.longitude) * 111320 * Math.cos(a.latitude * Math.PI / 180));
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Grid of known places for "same place already listed" and "nearest town" lookups (about 1.1 km cells).
const cell = p => `${Math.floor(p.latitude * 100)}:${Math.floor(p.longitude * 100)}`;
const grid = new Map(), towns = new Map();
const add = (map, p) => { const k = cell(p); if (!map.has(k)) map.set(k, []); map.get(k).push(p); };
for (const p of curated) { add(grid, p); if (p.category === 'settlement' || p.category === 'town') add(towns, p); }
function nearby(map, p, rings) {
  const out = [], la = Math.floor(p.latitude * 100), lo = Math.floor(p.longitude * 100);
  for (let i = -rings; i <= rings; i++) for (let j = -rings; j <= rings; j++) out.push(...(map.get(`${la + i}:${lo + j}`) || []));
  return out;
}
const nearestTown = p => { for (const rings of [1, 3, 6]) { const c = nearby(towns, p, rings); if (c.length) return c.reduce((b, t) => metres(p, t) < metres(p, b) ? t : b); } return null; };

const kept = [];
let read = 0, skipped = 0;
for await (const raw of readline.createInterface({input: createReadStream(input)})) {
  const line = raw.replace(/^\x1e/, '');
  if (!line) continue;
  let feature;
  try { feature = JSON.parse(line); } catch { continue; }
  read++;
  const tags = feature.properties || {}, name = String(tags.name || tags['name:en'] || '').trim();
  const kind = name.length >= 3 && name.length <= 120 && categoryOf(tags);
  if (!kind || tags.disused || tags.abandoned) { skipped++; continue; }
  const at = centre(feature.geometry);
  if (!(at.latitude >= 4.5 && at.latitude <= 11.4 && at.longitude >= -3.4 && at.longitude <= 1.4)) { skipped++; continue; }
  const key = norm(name);
  if (nearby(grid, at, 1).some(p => norm(p.name) === key && metres(p, at) < 150)) { skipped++; continue; }
  const town = nearestTown(at);
  const place = {
    id: 'OSM_' + String(feature.id ?? tags['@id'] ?? kept.length).replace(/[^a-z0-9]/gi, ''),
    name, category: kind.category, subcategory: kind.subcategory,
    locality: tags['addr:suburb'] || tags['addr:place'] || town?.locality || town?.name || '',
    city: tags['addr:city'] || town?.city || '', region: town?.region || '',
    latitude: Number(at.latitude.toFixed(6)), longitude: Number(at.longitude.toFixed(6)),
    popularity: tags.brand || tags.wikidata ? 40 : 25,
    coordinate_kind: feature.geometry.type === 'Point' ? 'mapped_point' : 'mapped_business_feature',
    aliases: [tags.brand, tags.alt_name, tags.short_name, tags.official_name].filter(a => a && a !== name),
  };
  if (tags['addr:street']) place.street = tags['addr:street'];
  kept.push(place);
  add(grid, place);
}
writeFileSync(output, JSON.stringify(kept));
const byCategory = kept.reduce((m, p) => (m[p.category] = (m[p.category] || 0) + 1, m), {});
console.log(JSON.stringify({read, added: kept.length, skipped, bytes: Buffer.byteLength(JSON.stringify(kept)), byCategory}));
