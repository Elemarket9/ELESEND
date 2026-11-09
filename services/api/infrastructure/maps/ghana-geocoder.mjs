import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {haversine} from '../../dispatch-geometry.mjs';
import {check} from '../../security.mjs';
import {looksLikeStreetQuery, photonSearch} from './photon-search.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const GHANA_BOUNDS = {minLatitude: 4.5, maxLatitude: 11.4, minLongitude: -3.4, maxLongitude: 1.4};

// Load full dataset from JSON gazetteer (31,200+ authentic records for 6 focus regions)
let rawGazetteer = [];
try {
  const jsonPath = join(__dirname, 'ghana-gazetteer-data.json');
  rawGazetteer = JSON.parse(readFileSync(jsonPath, 'utf8'));
} catch (e) {
  rawGazetteer = [];
}

// Foundational national regional anchors for remaining 10 administrative regions
const NATIONAL_ANCHORS = [
  {name:'Takoradi Market Circle',category:'market',locality:'Market Circle',city:'Takoradi',region:'Western',latitude:4.8872,longitude:-1.7584,popularity:88},
  {name:'Sekondi Commercial Area',category:'town',locality:'Sekondi Central',city:'Sekondi',region:'Western',latitude:4.9392,longitude:-1.7136,popularity:80},
  {name:'Tarkwa Market Circle',category:'market',locality:'Central',city:'Tarkwa',region:'Western',latitude:5.3012,longitude:-1.9961,popularity:79},
  {name:'Axim Town Center',category:'town',locality:'Central',city:'Axim',region:'Western',latitude:4.8699,longitude:-2.2405,popularity:75},
  {name:'Tamale Central',category:'market',locality:'Central',city:'Tamale',region:'Northern',latitude:9.4072,longitude:-0.8392,popularity:88},
  {name:'Tamale Central Market',category:'market',locality:'Central',city:'Tamale',region:'Northern',latitude:9.4072,longitude:-0.8392,popularity:86},
  {name:'Savelugu Main Station',category:'transit',locality:'Central',city:'Savelugu',region:'Northern',latitude:9.6253,longitude:-0.8267,popularity:75},
  {name:'Ho Central Market',category:'market',locality:'Central',city:'Ho',region:'Volta',latitude:6.6112,longitude:0.4715,popularity:76},
  {name:'Hohoe',category:'town',locality:'Central',city:'Hohoe',region:'Volta',latitude:7.1519,longitude:0.4736,popularity:85},
  {name:'Hohoe Central Market',category:'market',locality:'Central',city:'Hohoe',region:'Volta',latitude:7.1519,longitude:0.4736,popularity:74},
  {name:'Keta Central Market',category:'market',locality:'Central',city:'Keta',region:'Volta',latitude:5.9179,longitude:0.9879,popularity:73},
  {name:'Techiman',category:'town',locality:'Central',city:'Techiman',region:'Bono East',latitude:7.5855,longitude:-1.9395,popularity:88},
  {name:'Techiman Central Market',category:'market',locality:'Central',city:'Techiman',region:'Bono East',latitude:7.5855,longitude:-1.9395,popularity:84},
  {name:'Kintampo Waterfalls / Town',category:'landmark',locality:'Central',city:'Kintampo',region:'Bono East',latitude:8.0563,longitude:-1.7306,popularity:76},
  {name:'Atebubu Market',category:'market',locality:'Central',city:'Atebubu',region:'Bono East',latitude:7.7561,longitude:-0.9934,popularity:73},
  {name:'Sefwi Wiawso',category:'town',locality:'Central',city:'Sefwi Wiawso',region:'Western North',latitude:6.2162,longitude:-2.4847,popularity:85},
  {name:'Sefwi Wiawso Central',category:'town',locality:'Central',city:'Sefwi Wiawso',region:'Western North',latitude:6.2162,longitude:-2.4847,popularity:75},
  {name:'Bibiani Commercial Area',category:'town',locality:'Central',city:'Bibiani',region:'Western North',latitude:6.4635,longitude:-2.3321,popularity:74},
  {name:'Dambai',category:'town',locality:'Central',city:'Dambai',region:'Oti',latitude:8.0683,longitude:0.1794,popularity:85},
  {name:'Dambai Central / Lakeside',category:'market',locality:'Central',city:'Dambai',region:'Oti',latitude:8.0683,longitude:0.1794,popularity:75},
  {name:'Nkwanta Market',category:'market',locality:'Central',city:'Nkwanta',region:'Oti',latitude:8.2589,longitude:0.5204,popularity:72},
  {name:'Jasikan Town Center',category:'town',locality:'Central',city:'Jasikan',region:'Oti',latitude:7.4089,longitude:0.4686,popularity:71},
  {name:'Damongo',category:'town',locality:'Central',city:'Damongo',region:'Savannah',latitude:9.0833,longitude:-1.8167,popularity:85},
  {name:'Damongo Central',category:'town',locality:'Central',city:'Damongo',region:'Savannah',latitude:9.0833,longitude:-1.8167,popularity:75},
  {name:'Bole Main Station',category:'transit',locality:'Central',city:'Bole',region:'Savannah',latitude:9.0342,longitude:-2.4831,popularity:73},
  {name:'Salaga Market',category:'market',locality:'Central',city:'Salaga',region:'Savannah',latitude:8.5508,longitude:-0.5186,popularity:72},
  {name:'Nalerigu',category:'town',locality:'Central',city:'Nalerigu',region:'North East',latitude:10.5312,longitude:-0.3708,popularity:85},
  {name:'Nalerigu Town Center',category:'town',locality:'Central',city:'Nalerigu',region:'North East',latitude:10.5312,longitude:-0.3708,popularity:75},
  {name:'Walewale Market',category:'market',locality:'Central',city:'Walewale',region:'North East',latitude:10.3524,longitude:-0.8003,popularity:74},
  {name:'Gambaga Old Town',category:'landmark',locality:'Central',city:'Gambaga',region:'North East',latitude:10.5318,longitude:-0.4439,popularity:71},
  {name:'Bolgatanga',category:'town',locality:'Central',city:'Bolgatanga',region:'Upper East',latitude:10.7874,longitude:-0.8580,popularity:90},
  {name:'Bolgatanga Central Market',category:'market',locality:'Central',city:'Bolgatanga',region:'Upper East',latitude:10.7874,longitude:-0.8580,popularity:80},
  {name:'Navrongo',category:'town',locality:'Central',city:'Navrongo',region:'Upper East',latitude:10.8956,longitude:-1.0921,popularity:85},
  {name:'Navrongo Central Market',category:'market',locality:'Central',city:'Navrongo',region:'Upper East',latitude:10.8956,longitude:-1.0921,popularity:77},
  {name:'Bawku Central Market',category:'market',locality:'Central',city:'Bawku',region:'Upper East',latitude:11.0558,longitude:-0.2417,popularity:76},
  {name:'Wa',category:'town',locality:'Central',city:'Wa',region:'Upper West',latitude:10.0607,longitude:-2.5099,popularity:90},
  {name:'Wa Central Market',category:'market',locality:'Central',city:'Wa',region:'Upper West',latitude:10.0607,longitude:-2.5099,popularity:80},
  {name:'Lawra Town Center',category:'town',locality:'Central',city:'Lawra',region:'Upper West',latitude:10.6433,longitude:-2.8242,popularity:72}
];

/** An optional data file next to this module. A missing or broken file leaves search running on the rest. */
function optionalPlaces(file) {
  try { const rows = JSON.parse(readFileSync(file.startsWith('/') ? file : join(__dirname, file), 'utf8')); return Array.isArray(rows) ? rows : []; }
  catch { return []; }
}
// Places added by hand, each with where its position came from (see docs/maps.md).
export const PLACE_OVERLAY = optionalPlaces('ghana-places-overlay.json');
// Businesses and landmarks from OpenStreetMap. On servers the daily map refresh rebuilds them into the map data folder
// (GHANA_OSM_PLACES_FILE); otherwise a copy next to this module is used if one exists.
const OSM_PLACES = optionalPlaces(process.env.GHANA_OSM_PLACES_FILE || 'ghana-osm-places.json');

// Some imported map entries carry only a generic word as their name ("Market", "Junction", "Village"). Shown as a
// search result they tell the customer nothing about where they are, so they are left out.
const NAMELESS = new Set(['village','church','mosque','clinic','hospital','market','shop','store','junction','house','bar','hotel','pharmacy','bank','station','filling station','police','school','building','office','yes','unnamed']);

// Alias rows copy an existing point. They never become a new coordinate.
function metresBetween(a, b) {
  const from = {latitude: Number(a.latitude), longitude: Number(a.longitude)};
  const to = {latitude: Number(b.latitude), longitude: Number(b.longitude)};
  if (!Number.isFinite(from.latitude) || !Number.isFinite(to.latitude)) return Infinity;
  return haversine(from, to);
}
function applyAliasOverlays(places, overlay) {
  for (const row of overlay) {
    if (!row || row.attachAliases !== true) continue;
    const target = String(row.aliasOf || row.name || '').trim().toLowerCase();
    if (!target) continue;
    let best = null, bestDistance = Infinity;
    for (const place of places) {
      if (String(place.name || '').trim().toLowerCase() !== target) continue;
      const distance = metresBetween(place, row);
      if (distance <= 50 && distance < bestDistance) { best = place; bestDistance = distance; }
    }
    if (!best) continue;
    best.aliases = [...new Set([...(best.aliases || []), ...(row.aliases || [])].map(alias => String(alias)))];
    if (row.locality && String(best.locality || '').trim().toLowerCase() === String(best.region || '').trim().toLowerCase()) best.locality = row.locality;
    if (row.city && String(best.city || '').trim().toLowerCase() === String(best.region || '').trim().toLowerCase()) best.city = row.city;
  }
}
const curatedPlaces = [...rawGazetteer, ...OSM_PLACES].filter(p => !NAMELESS.has(String(p.name || '').trim().toLowerCase()));
applyAliasOverlays(curatedPlaces, PLACE_OVERLAY);
export const GHANA_GAZETTEER = curatedPlaces.concat(NATIONAL_ANCHORS, PLACE_OVERLAY.filter(row => !row.attachAliases));

const ABBREVIATIONS = {
  uni: 'university',
  coll: 'college',
  kuc: 'kaaf university college',
  ug: 'university of ghana',
  knust: 'kwame nkrumah university of science and technology',
  tech: 'kwame nkrumah university of science and technology',
  ucc: 'university of cape coast',
  upsa: 'university of professional studies accra',
  atu: 'accra technical university',
  gimpa: 'ghana institute of management and public administration',
  mkt: 'market',
  junc: 'junction',
  jn: 'junction',
  rd: 'road',
  st: 'street',
  ave: 'avenue',
  hosp: 'hospital',
  poly: 'polyclinic',
  shs: 'senior high school',
  sec: 'senior high school',
  jhs: 'junior high school',
  clnk: 'clinic',
  pharm: 'pharmacy',
  stn: 'station',
  snr: 'senior',
  kia: 'kotoka international airport',
  kath: 'komfo anokye teaching hospital',
  kbth: 'korle bu teaching hospital',
  akyem: 'akim',
  coomassie: 'kumasi',
  oguaa: 'cape coast',
  khaf: 'kaaf',
  bolga: 'bolgatanga',
};

const STOP_WORDS = new Set([
  'in', 'at', 'near', 'around', 'close', 'to', 'from', 'of', 'and', 'the',
  'district', 'metropolitan', 'municipal', 'ghana', 'me'
]);

const ALL_REGIONS = [
  'greater accra', 'ashanti', 'central', 'eastern', 'ahafo', 'bono',
  'western', 'western north', 'volta', 'oti', 'bono east', 'northern',
  'savannah', 'north east', 'upper east', 'upper west'
];

export function soundex(s) {
  const map = { b:1, f:1, p:1, v:1, c:2, g:2, j:2, k:2, q:2, s:2, x:2, z:2, d:3, t:3, l:4, m:5, n:5, r:6 };
  const str = (s || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!str) return '';
  const first = str[0].toUpperCase();
  let code = first;
  let prev = map[str[0]] || 0;
  for (let i = 1; i < str.length && code.length < 4; i++) {
    const c = map[str[i]] || 0;
    if (c !== 0 && c !== prev) code += c;
    prev = c;
  }
  return (code + '000').slice(0, 4);
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1], prev, row[j]) + 1;
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

// Build Inverted Index, Initial Bucket Index, Soundex Index and Spatial Grid
const INVERTED_INDEX = new Map();
const INITIAL_BUCKET = new Map(); // letter -> Set<words>
const SOUNDEX_INDEX = new Map();
const SPATIAL_GRID = new Map();
const GRID_CELL_SIZE = 0.05; // ~5.5 km cells

function getGridKey(lat, lon) {
  const gLat = Math.floor(lat / GRID_CELL_SIZE);
  const gLon = Math.floor(lon / GRID_CELL_SIZE);
  return `${gLat}:${gLon}`;
}

for (let i = 0; i < GHANA_GAZETTEER.length; i++) {
  const place = GHANA_GAZETTEER[i];
  place._nameLower = (place.name || '').toLowerCase();
  place._localityLower = (place.locality || '').toLowerCase();
  place._cityLower = (place.city || '').toLowerCase();
  place._regionLower = (place.region || '').toLowerCase();
  place._aliasTexts = (place.aliases || []).map(a => a.toLowerCase());
  place._searchable = `${place._nameLower} ${place._localityLower} ${place._cityLower} ${place._regionLower} ${place._aliasTexts.join(' ')}`;
  
  const tokens = new Set([
    ...place._nameLower.split(/[^a-z0-9]+/).filter(Boolean),
    ...place._localityLower.split(/[^a-z0-9]+/).filter(Boolean),
    ...place._cityLower.split(/[^a-z0-9]+/).filter(Boolean),
    ...place._aliasTexts.flatMap(a => a.split(/[^a-z0-9]+/).filter(Boolean))
  ]);

  for (const [abbr, expansion] of Object.entries(ABBREVIATIONS)) {
    if (place._nameLower.includes(expansion) || place._aliasTexts.some(a => a.includes(expansion))) {
      tokens.add(abbr);
    }
  }
  
  place._tokens = tokens;
  
  for (const token of tokens) {
    let list = INVERTED_INDEX.get(token);
    if (!list) {
      list = [];
      INVERTED_INDEX.set(token, list);
    }
    list.push(i);

    const firstChar = token[0];
    let bucket = INITIAL_BUCKET.get(firstChar);
    if (!bucket) {
      bucket = new Set();
      INITIAL_BUCKET.set(firstChar, bucket);
    }
    bucket.add(token);

    // Phonetic soundex indexing for tokens >= 3 chars
    if (token.length >= 3) {
      const snd = soundex(token);
      let sndList = SOUNDEX_INDEX.get(snd);
      if (!sndList) {
        sndList = [];
        SOUNDEX_INDEX.set(snd, sndList);
      }
      sndList.push(i);
    }
  }

  // Populate Spatial Grid for Reverse Geocoding
  const gKey = getGridKey(place.latitude, place.longitude);
  let gList = SPATIAL_GRID.get(gKey);
  if (!gList) {
    gList = [];
    SPATIAL_GRID.set(gKey, gList);
  }
  gList.push(i);
}

// Generic category stop words that frequently occur in landmark descriptions
const GENERIC_CATEGORY_WORDS = new Set([
  'government', 'hospital', 'clinic', 'polyclinic', 'school', 'station', 'market', 
  'hotel', 'church', 'bank', 'centre', 'center', 'park', 'house', 'road', 'street', 
  'junction', 'complex', 'service', 'services', 'police', 'post', 'office', 'shs', 
  'jhs', 'presby', 'methodist', 'catholic', 'international', 'general', 'district', 'municipal'
]);

const DUPLICATE_METERS = 250, REVERSE_MAX_METERS = 10000;

// Bounded LRU Cache for geocoding queries (1,000 queries)
const QUERY_CACHE = new Map();
const MAX_CACHE_SIZE = 1000;

// Bounded LRU Cache for reverse geocoding (~10m precision, 2,000 points)
const REVERSE_CACHE = new Map();
const MAX_REVERSE_CACHE_SIZE = 2000;

const STOP_CATEGORIES = new Set(['transport', 'transit']);
const DESTINATION_CATEGORIES = new Set(['health', 'hospital', 'education', 'religion', 'market', 'mall', 'commerce', 'landmark', 'neighborhood', 'food', 'public_service', 'airport']);
const compactText = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// AA-000-0000 (GhanaPost's usual 7-digit form) and AA-0000-0000. No coordinate is invented here.
export function interpretDigitalAddress(query) {
  const compact = String(query || '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (/^[A-Z]{2}\d{7}$/.test(compact)) return {formatted: `${compact.slice(0, 2)}-${compact.slice(2, 5)}-${compact.slice(5)}`};
  if (/^[A-Z]{2}\d{8}$/.test(compact)) return {formatted: `${compact.slice(0, 2)}-${compact.slice(2, 6)}-${compact.slice(6)}`};
  return null;
}
export function digitalAddressUnavailable(parsed) {
  return [{
    name: 'Digital address lookup is not available yet',
    label: parsed.formatted,
    type: 'digital_address',
    digitalAddress: parsed.formatted,
    available: false,
    latitude: null,
    longitude: null,
    uncertainty: 'GhanaPostGPS lookup is turned off. No coordinate was guessed.'
  }];
}

const CATEGORY_INTENTS = [
  {phrases: ['filling station', 'fuel station', 'petrol station', 'gas station', 'fuel'], id: 'fuel'},
  {phrases: ['chop bar', 'chopbar'], id: 'chop_bar'},
  {phrases: ['supermarket'], id: 'supermarket'},
  {phrases: ['pharmacy', 'chemist', 'drugstore'], id: 'pharmacy'},
  {phrases: ['hospital'], id: 'hospital'},
  {phrases: ['church'], id: 'church'},
  {phrases: ['mosque'], id: 'mosque'},
  {phrases: ['school'], id: 'school'},
  {phrases: ['bank'], id: 'bank'},
  {phrases: ['restaurant'], id: 'restaurant'},
  {phrases: ['market'], id: 'market'}
];
function categoryIntent(text) {
  const wanted = String(text || '').trim();
  return CATEGORY_INTENTS.find(intent => intent.phrases.includes(wanted)) || null;
}
function matchesCategory(place, id) {
  const sub = String(place.subcategory || '').toLowerCase();
  // Filling stations are destinations. An older import stored amenity=fuel as transport, the same category as a bus stop.
  if (id === 'fuel' && (sub === 'fuel' || sub === 'fuel_station')) return true;
  if (STOP_CATEGORIES.has(place.category)) return false;
  const name = place._nameLower || '';
  const category = String(place.category || '').toLowerCase();
  switch (id) {
    case 'pharmacy': return sub === 'pharmacy' || /\b(pharmacy|chemist|drugstore)\b/.test(name);
    case 'hospital': return category === 'hospital' || sub === 'hospital' || /\bhospital\b/.test(name);
    case 'church': return !/\bmosque\b/.test(name) && (/\bchurch\b/.test(name) || (category === 'religion' && /\bchapel\b/.test(name)));
    case 'mosque': return sub === 'mosque' || /\bmosque\b/.test(name);
    case 'school': return category === 'education' || sub === 'school' || /\b(school|shs|jhs)\b/.test(name);
    case 'bank': return sub === 'bank' || /\bbank\b/.test(name);
    case 'supermarket': return sub === 'supermarket' || /\bsupermarket\b/.test(name);
    case 'fuel': return sub === 'fuel' || sub === 'fuel_station' || /\b(filling station|fuel station|petrol|goil|shell)\b/.test(name);
    case 'market': return category === 'market' || sub === 'market' || /\bmarket\b/.test(name);
    case 'restaurant': return sub === 'restaurant' || sub === 'fast_food' || /\brestaurant\b/.test(name);
    case 'chop_bar': return sub === 'chop_bar' || /\bchop ?bar\b/.test(name);
    default: return false;
  }
}
function placeResult(place, score, distanceMeters) {
  return {
    id: place.id,
    name: place.name,
    label: `${place.locality || place.region}, ${place.city || place.region}`,
    locality: place.locality || place.region,
    city: place.city || place.locality || place.region,
    region: place.region,
    category: place.category || 'landmark',
    subcategory: place.subcategory || 'general',
    latitude: place.latitude,
    longitude: place.longitude,
    coordinate_kind: place.coordinate_kind || 'mapped_point',
    type: 'place',
    aliases: place.aliases || [],
    entrance: place.entrance || null,
    street: place.street || null,
    score: Number(score.toFixed(1)),
    distanceMeters: Number.isFinite(distanceMeters) ? distanceMeters : null
  };
}

// Fast In-Memory Geocoding Search (< 1ms across 31,000+ records)
export function ghanaSearch(query, {limit = 10, near = null} = {}) {
  check(typeof query === 'string', 400, 'Search query must be text');
  const clean = query.trim();
  if (!clean) return [];
  check(clean.length <= 150, 400, 'Search query too long');
  const digital = interpretDigitalAddress(clean);
  if (digital) return digitalAddressUnavailable(digital);
  const nearOk = near && Number(near.latitude) >= GHANA_BOUNDS.minLatitude && Number(near.latitude) <= GHANA_BOUNDS.maxLatitude && Number(near.longitude) >= GHANA_BOUNDS.minLongitude && Number(near.longitude) <= GHANA_BOUNDS.maxLongitude
    ? {latitude: Number(near.latitude), longitude: Number(near.longitude)} : null;

  const typed = clean.toLowerCase();
  const wantsProximity = /\b(near me|nearby|around me|close to me)\b/.test(typed);
  const cleanLower = typed.replace(/\b(near me|nearby|around me|close to me)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleanLower) return [];
  const nearKey = nearOk ? `${nearOk.latitude.toFixed(2)},${nearOk.longitude.toFixed(2)}` : '';

  // Check LRU cache
  const cacheKey = `${cleanLower}:${limit}:${nearKey}:${wantsProximity ? 1 : 0}`;
  if (QUERY_CACHE.has(cacheKey)) {
    return QUERY_CACHE.get(cacheKey);
  }

  const intent = categoryIntent(cleanLower);
  if (intent) {
    const ranked = [];
    for (const place of GHANA_GAZETTEER) {
      if (!matchesCategory(place, intent.id)) continue;
      const distanceMeters = nearOk ? Math.round(haversine(nearOk, place)) : null;
      const proximity = distanceMeters == null ? 0 : Math.max(0, 400 - distanceMeters / 100);
      ranked.push({place, score: (place.popularity || 0) + proximity + (wantsProximity && distanceMeters != null ? 20 : 0), distanceMeters});
    }
    const preferReligion = intent.id === 'church' || intent.id === 'mosque';
    ranked.sort((a, b) => {
      if (preferReligion && !nearOk) {
        const religion = place => place.category === 'religion' ? 1 : 0;
        const byKind = religion(b.place) - religion(a.place);
        if (byKind) return byKind;
      }
      return (nearOk ? a.distanceMeters - b.distanceMeters : b.score - a.score) || b.place.popularity - a.place.popularity || a.place.name.localeCompare(b.place.name);
    });
    const categoryResults = ranked.slice(0, Math.max(1, Math.min(limit, 30))).map(row => placeResult(row.place, row.score, row.distanceMeters));
    if (QUERY_CACHE.size >= MAX_CACHE_SIZE) QUERY_CACHE.delete(QUERY_CACHE.keys().next().value);
    QUERY_CACHE.set(cacheKey, categoryResults);
    return categoryResults;
  }

  // 1. Coordinate parsing (e.g. "5.6212, -0.1748")
  const coordMatch = /^(-?\d{1,2}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)$/.exec(clean);
  if (coordMatch) {
    const lat = Number(coordMatch[1]), lon = Number(coordMatch[2]);
    if (lat >= GHANA_BOUNDS.minLatitude && lat <= GHANA_BOUNDS.maxLatitude && lon >= GHANA_BOUNDS.minLongitude && lon <= GHANA_BOUNDS.maxLongitude) {
      const coordRes = [{
        name: `Location (${lat.toFixed(5)}, ${lon.toFixed(5)})`,
        label: 'Custom pin in Ghana',
        latitude: lat,
        longitude: lon,
        type: 'coordinate'
      }];
      return coordRes;
    }
  }

  // 2. Tokenize, expand abbreviations and normalize. "near me" was already removed above.
  const expandedQuery = ABBREVIATIONS[cleanLower] || cleanLower;

  // Extract detected region mentions in the query
  const queryRegions = [];
  for (const r of ALL_REGIONS) {
    if (cleanLower.includes(r)) queryRegions.push(r);
  }

  // Detect clean query name without region qualifier
  let cleanNameOnly = cleanLower;
  for (const r of queryRegions) {
    cleanNameOnly = cleanNameOnly.replace(r, '');
  }
  cleanNameOnly = cleanNameOnly.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

  const rawWords = cleanLower.split(/[^a-z0-9]+/).filter(w => w.length > 0 && !STOP_WORDS.has(w));
  if (!rawWords.length) return [];

  // Use normalized terms without multi-word explosion so phrase length stays true
  const terms = Array.from(new Set(rawWords.map(w => {
    const exp = ABBREVIATIONS[w];
    return (exp && !exp.includes(' ')) ? exp : w;
  }))).filter(w => !STOP_WORDS.has(w));
  const candidateScores = new Map(); // placeIdx -> {matchedTerms: Set, score: number, exactMatches: number}

  for (let ti = 0; ti < terms.length; ti++) {
    const term = terms[ti];
    const rawWord = rawWords[ti];
    const termMatches = new Map(); // placeIdx -> bestScoreForThisTerm

    // 1. Exact matches
    const exactList = INVERTED_INDEX.get(term) || (rawWord !== term ? INVERTED_INDEX.get(rawWord) : null);
    if (exactList) {
      for (const idx of exactList) {
        termMatches.set(idx, Math.max(termMatches.get(idx) || 0, 50));
      }
    }

    // Dz/J is one Ghanaian spelling difference (Jorwulu / Dzorwulu). Only an exact indexed word is accepted,
    // and only this pair, so Kotoka is not pulled toward Kotoko.
    if (!exactList && term.length >= 5) {
      const alt = term.startsWith('dz') ? 'j' + term.slice(2) : term.startsWith('j') ? 'dz' + term.slice(1) : null;
      const altList = alt ? INVERTED_INDEX.get(alt) : null;
      if (altList) {
        for (const idx of altList) termMatches.set(idx, Math.max(termMatches.get(idx) || 0, 46));
      }
    }

    // 1b. Names people type as one word, like "GTBank" or "Stanbic Bank" written "StanbicBank": try every split into
    // two indexed words and keep the places that have both. The reverse ("Shop Rite" for "Shoprite") is handled after
    // this loop by joining neighbouring query words.
    if (term.length >= 5) {
      for (let cut = 2; cut <= term.length - 2; cut++) {
        const left = INVERTED_INDEX.get(term.slice(0, cut)), right = INVERTED_INDEX.get(term.slice(cut));
        if (!left || !right) continue;
        const rightSet = new Set(right);
        for (const idx of left) if (rightSet.has(idx)) termMatches.set(idx, Math.max(termMatches.get(idx) || 0, 48));
      }
    }

    // 2. Prefix matches (for terms >= 3 chars, skip if exact term already matches 8+ places)
    const firstChar = term[0];
    const bucket = INITIAL_BUCKET.get(firstChar);
    if (bucket && term.length >= 3 && (!exactList || exactList.length < 8)) {
      for (const indexedWord of bucket) {
        if (indexedWord === term) continue; // already handled
        if (indexedWord.startsWith(term) || (rawWord !== term && indexedWord.startsWith(rawWord))) {
          const list = INVERTED_INDEX.get(indexedWord) || [];
          for (const idx of list) {
            termMatches.set(idx, Math.max(termMatches.get(idx) || 0, 30));
          }
        }
      }
    }

    // 3. Typo tolerance via Levenshtein on bucket (if exact match not ubiquitous)
    if (bucket && (!exactList || exactList.length < 5) && term.length >= 4) {
      for (const indexedWord of bucket) {
        if (indexedWord === term) continue;
        const lenDiff = Math.abs(indexedWord.length - term.length);
        if (lenDiff <= 2) {
          const maxDist = term.length >= 6 ? 2 : 1;
          const dist = levenshtein(term, indexedWord);
          if (dist <= maxDist) {
            const list = INVERTED_INDEX.get(indexedWord) || [];
            const typoBonus = dist === 1 ? 40 : 25;
            for (const idx of list) {
              termMatches.set(idx, Math.max(termMatches.get(idx) || 0, typoBonus));
            }
          }
        }
      }
    }

    // 4. Phonetic Soundex (for terms >= 4 chars, fallback if few candidates)
    if (termMatches.size < 30 && term.length >= 4) {
      const snd = soundex(term);
      const sndList = SOUNDEX_INDEX.get(snd) || [];
      for (const idx of sndList) {
        termMatches.set(idx, Math.max(termMatches.get(idx) || 0, 20));
      }
    }

    // Merge termMatches into candidateScores
    for (const [idx, termScore] of termMatches) {
      let entry = candidateScores.get(idx);
      if (!entry) {
        entry = {matchedTerms: new Set(), score: 0};
        candidateScores.set(idx, entry);
      }
      entry.matchedTerms.add(ti);
      entry.score += termScore;
    }
  }

  // Two neighbouring query words that form one indexed word ("shop rite" -> "shoprite") count as both words matched.
  for (let ti = 0; ti + 1 < terms.length; ti++) {
    const joined = INVERTED_INDEX.get(terms[ti] + terms[ti + 1]);
    if (!joined) continue;
    for (const idx of joined) {
      let entry = candidateScores.get(idx);
      if (!entry) { entry = {matchedTerms: new Set(), score: 0}; candidateScores.set(idx, entry); }
      if (!entry.matchedTerms.has(ti)) { entry.matchedTerms.add(ti); entry.score += 48; }
      if (!entry.matchedTerms.has(ti + 1)) { entry.matchedTerms.add(ti + 1); entry.score += 48; }
    }
  }

  // 3. Score and Rank Matches
  const scored = [];
  const queryIsKnownWord = terms.length === 1 && INVERTED_INDEX.has(terms[0]);
  const compactQuery = cleanLower.replace(/[^a-z0-9]/g, '');
  const minMatches = terms.length <= 2 ? 1 : Math.max(2, Math.ceil(terms.length * 0.65));
  const nonGenericTerms = terms.filter(t => !GENERIC_CATEGORY_WORDS.has(t));

  for (const [idx, data] of candidateScores) {
    const place = GHANA_GAZETTEER[idx];
    const matchCount = data.matchedTerms.size;

    // Preserve candidates whose full canonical name is in query and any extra words are purely generic qualifiers/locality
    let fullNameInQuery = false;
    if (place._nameLower.length >= 4 && cleanLower.includes(place._nameLower)) {
      const extraWords = cleanLower.replace(place._nameLower, '').trim().split(/\s+/).filter(Boolean);
      const allExtraAreQualifiers = extraWords.every(w => 
        GENERIC_CATEGORY_WORDS.has(w) || 
        place._regionLower.includes(w) || 
        place._cityLower.includes(w) || 
        place._localityLower.includes(w) ||
        ['main', 'branch', 'campus', 'gate', 'junction', 'road', 'street', 'area', 'shopping', 'new'].includes(w)
      );
      if (allExtraAreQualifiers) {
        fullNameInQuery = true;
      }
    } else if (place._aliasTexts.some(a => a.length >= 4 && cleanLower === a)) {
      fullNameInQuery = true;
    }

    if (matchCount < minMatches && !fullNameInQuery) continue;

    let score = data.score;

    // A. EXACT FULL NAME OR CANONICAL ALIAS MATCH (Highest possible priority)
    const baseNameWithoutBranch = place._nameLower.replace(/\s*\([^)]*\)/g, '').trim();
    const isCommercialOrAmenity = ['commerce', 'logistics', 'health', 'education', 'food', 'amenity', 'transport'].includes(place.category);
    if (place._nameLower === cleanLower || place._nameLower === expandedQuery || place._aliasTexts.includes(cleanLower) || place._aliasTexts.includes(expandedQuery)) {
      score += 280;
    } else if (cleanNameOnly && (place._nameLower === cleanNameOnly || place._aliasTexts.includes(cleanNameOnly))) {
      score += 260; // Matches name part when region was also in query (e.g. "Total, Greater Accra" or "Labone Greater Accra")
    } else if (isCommercialOrAmenity && (baseNameWithoutBranch === cleanLower || baseNameWithoutBranch === expandedQuery)) {
      score += 275; // Commercial branch matching base brand name (e.g. Shoprite (Accra Mall) for "Shoprite")
    } else if (baseNameWithoutBranch === cleanLower || baseNameWithoutBranch === expandedQuery) {
      score += 150; // Non-commercial parenthetical suffix
    } else {
      // Fuzzy full name match (Typo in entire single/multi-word name). When the query is itself a real indexed word
      // ("Kotoka"), a place one letter off ("Kotoya") is probably not what was meant, so it gets far less.
      const lenDiff = Math.abs(place._nameLower.length - cleanLower.length);
      if (lenDiff <= 2 && place._nameLower[0] === cleanLower[0]) {
        const fullDist = levenshtein(place._nameLower, cleanLower);
        if (fullDist === 1) {
          score += queryIsKnownWord ? 40 : 180;
        } else if (fullDist === 2 && cleanLower.length >= 6) {
          score += queryIsKnownWord ? 20 : 110;
        }
      }

      // The same name written with or without spaces ("GTBank" and "GT Bank") counts as the name being in the query.
      const compactName = place._nameLower.replace(/[^a-z0-9]/g, '');
      if (!cleanLower.includes(place._nameLower) && compactName.length >= 4 && compactQuery.includes(compactName)) {
        score += Math.round(120 * compactName.length / compactQuery.length);
      } else if (cleanLower.includes(place._nameLower) && place._nameLower.length >= 3) {
        // Query contains place full name (e.g. "Koforidua Market, Eastern Region")
        const ratio = place._nameLower.length / cleanLower.length;
        score += Math.round(120 * ratio);
      } else if (place._nameLower.startsWith(cleanLower) || place._nameLower.startsWith(terms[0])) {
        score += 40;
      }
    }

    // B. QUERY TERM COVERAGE BONUS (Places matching all or most query terms win)
    const coverage = Math.min(1.0, matchCount / terms.length);
    score += coverage * 140;
    if (matchCount === terms.length && terms.length >= 2) {
      score += 40; // All words in multi-word query matched!
    } else if (matchCount === 1 && terms.length >= 3) {
      score -= 30; // Penalize matching only 1 word of a 3+ word query
    }
    // A distinctive word the place does not explain ("GTBank" in "GTBank Cape Coast") means the person wants something
    // more specific than this place, so the town alone should not beat the business in that town.
    for (let ti = 0; ti < terms.length; ti++) {
      if (!data.matchedTerms.has(ti) && !GENERIC_CATEGORY_WORDS.has(terms[ti]) && terms[ti].length >= 3 && !place._searchable.includes(terms[ti])) score -= 60;
    }

    // C. EXACT PHRASE IN SEARCHABLE TEXT
    if (place._searchable.includes(cleanLower) || place._searchable.includes(expandedQuery)) {
      score += 50;
    }

    // D. GEOGRAPHIC CONTEXT ALIGNMENT (General algorithms, universal for all communities)
    // 1. Locality alignment
    if (place._localityLower && place._localityLower.length >= 3 && cleanLower.includes(place._localityLower)) {
      score += 50;
    }
    // 2. City alignment
    if (place._cityLower && place._cityLower.length >= 3 && cleanLower.includes(place._cityLower)) {
      score += 40;
    }
    // 3. Region alignment
    if (queryRegions.length > 0) {
      if (queryRegions.includes(place._regionLower)) {
        score += 60; // Query explicitly specified this region
      } else {
        score -= 90; // Query explicitly specified a DIFFERENT region
      }
    }

    // Accidental match penalty: candidate matched ONLY generic stop words (e.g. "government", "hospital")
    // while the user specified distinct proper nouns (e.g. "Saltpond", "Nsawam", "Suhum")
    if (nonGenericTerms.length > 0) {
      let matchesAnyNonGeneric = false;
      for (const ti of data.matchedTerms) {
        if (!GENERIC_CATEGORY_WORDS.has(terms[ti])) {
          matchesAnyNonGeneric = true;
          break;
        }
      }
      if (!matchesAnyNonGeneric) {
        score -= 90;
      }
    }

    // E. LENGTH PENALTY FOR UNNECESSARY WORD SPRAWL (Ignore parenthetical location qualifiers)
    const baseNameWords = place._nameLower.replace(/\([^)]*\)/g, '').trim().split(/\s+/).length;
    if (baseNameWords > terms.length + 3) {
      score -= (baseNameWords - terms.length) * 3;
    }

    // Canonical Main Campus priority when no satellite branch specified
    if (place._nameLower.includes('main campus')) {
      score += 25;
    }

    // A well-known town name means the town, not a small place elsewhere that shares it.
    if (place._cityLower === expandedQuery && (place.popularity || 0) >= 70 && place._nameLower.startsWith(expandedQuery)) {
      score += 300;
    }

    // F. POPULARITY & VERIFIED STATUS TIE-BREAKER (Max 35 pts)
    score += (place.popularity || 50) * 0.25;
    if (place.verification_status === 'business_verified') {
      score += 15;
    }
    if (place.entrance) {
      score += 10;
    }

    scored.push({place, score, exact: terms.length >= 2 && place._nameLower === cleanLower});
  }

  const queryCompact = compactText(cleanLower);
  const queryHit = place => compactText(place._nameLower) === queryCompact || place._aliasTexts.some(alias => compactText(alias) === queryCompact);
  const longerNamedHit = scored.some(row => {
    const packed = compactText(row.place._nameLower);
    return queryCompact.length >= 4 && packed.includes(queryCompact) && packed.length >= queryCompact.length + 3;
  });
  const destinationHit = scored.some(row => DESTINATION_CATEGORIES.has(row.place.category) && queryHit(row.place));
  if (destinationHit || longerNamedHit) {
    for (const row of scored) {
      if (!STOP_CATEGORIES.has(row.place.category)) continue;
      const packed = compactText(row.place._nameLower);
      if (packed.length >= queryCompact.length + 3 && packed.includes(queryCompact)) continue;
      if (packed === queryCompact || queryHit(row.place)) {
        row.score -= 480;
        // A trotro stop whose whole name is the query must not jump the queue ahead of the hospital or market.
        row.exact = 0;
      }
    }
  }

  // An exact village name must not hide a business that uses that name (Papaye the restaurant, not the village).
  // A major town (popularity 90 or more) still means the town: Kumasi stays Kumasi.
  if (terms.length === 1) {
    const branded = scored.some(row => ['commerce', 'food', 'mall', 'market'].includes(row.place.category) && (row.place._nameLower === cleanLower || row.place._aliasTexts.includes(cleanLower)));
    if (branded) {
      for (const row of scored) {
        const village = row.place.category === 'settlement' || row.place.category === 'town' || ['village', 'hamlet'].includes(row.place.subcategory);
        if (!village || (row.place.popularity || 0) >= 90) continue;
        if (row.place._nameLower === cleanLower || row.place._aliasTexts.includes(cleanLower)) row.score -= 420;
      }
    }
  }

  if (nearOk) {
    for (const row of scored) row.distanceMeters = Math.round(haversine(nearOk, row.place));
    const closestByName = new Map();
    for (const row of scored) {
      const previous = closestByName.get(row.place._nameLower);
      if (previous == null || row.distanceMeters < previous) closestByName.set(row.place._nameLower, row.distanceMeters);
    }
    for (const row of scored) {
      if (row.distanceMeters < 3000) row.score += wantsProximity ? 220 : 140;
      else if (row.distanceMeters < 20000) row.score += wantsProximity ? 120 : 70;
      const closest = closestByName.get(row.place._nameLower);
      if (closest != null && row.distanceMeters > closest + 20000) row.score -= Math.min(360, Math.round((row.distanceMeters - closest) / 250));
    }
  }

  // The exact name of a multi-word place comes first, whatever its context scores.
  scored.sort((a, b) => (b.exact - a.exact) || (b.score - a.score));

  // The same place listed twice shows once.
  const wanted = Math.max(1, Math.min(limit, 30)), distinct = [];
  for (const row of scored) {
    if (distinct.length >= wanted) break;
    const repeat = distinct.some(kept => kept.place._nameLower === row.place._nameLower && haversine(kept.place, row.place) <= DUPLICATE_METERS);
    if (!repeat) distinct.push(row);
  }

  const results = distinct.map(({place, score, distanceMeters}) => placeResult(place, score, distanceMeters));

  // Store in bounded LRU cache
  if (QUERY_CACHE.size >= MAX_CACHE_SIZE) {
    const firstKey = QUERY_CACHE.keys().next().value;
    QUERY_CACHE.delete(firstKey);
  }
  QUERY_CACHE.set(cacheKey, results);

  return results;
}

// Fast In-Memory Reverse Geocoding (< 1ms using spatial grid)
export function ghanaReverseGeocode(lat, lon) {
  check(Number.isFinite(lat) && lat >= GHANA_BOUNDS.minLatitude && lat <= GHANA_BOUNDS.maxLatitude, 400, 'Latitude outside Ghana');
  check(Number.isFinite(lon) && lon >= GHANA_BOUNDS.minLongitude && lon <= GHANA_BOUNDS.maxLongitude, 400, 'Longitude outside Ghana');

  const cacheKey = `${lat.toFixed(4)}:${lon.toFixed(4)}`;
  if (REVERSE_CACHE.has(cacheKey)) {
    return { ...REVERSE_CACHE.get(cacheKey), latitude: lat, longitude: lon };
  }

  const gLat = Math.floor(lat / GRID_CELL_SIZE);
  const gLon = Math.floor(lon / GRID_CELL_SIZE);
  let closest = null, minDist = Infinity;

  // Search candidate grid cell and 8 adjacent cells
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const key = `${gLat + dy}:${gLon + dx}`;
      const list = SPATIAL_GRID.get(key);
      if (!list) continue;

      for (const idx of list) {
        const place = GHANA_GAZETTEER[idx];
        const d = haversine({latitude: lat, longitude: lon}, place);
        if (d < minDist) {
          minDist = d;
          closest = place;
        }
      }
    }
  }

  // Fallback to broader radius if sparse
  if (!closest) {
    for (const place of GHANA_GAZETTEER) {
      const d = haversine({latitude: lat, longitude: lon}, place);
      if (d < minDist) {
        minDist = d;
        closest = place;
      }
    }
  }

  // A place this far away describes nothing useful, so the pin is reported as it is.
  if (!closest || minDist > REVERSE_MAX_METERS) {
    return {address: `Ghana (${lat.toFixed(5)}, ${lon.toFixed(5)})`, latitude: lat, longitude: lon};
  }

  const distKm = minDist / 1000;
  const distanceLabel = distKm < 0.1 ? 'At' : distKm < 1 ? `~${Math.round(minDist)}m from` : `~${distKm.toFixed(1)} km from`;
  const address = `${distanceLabel} ${closest.name}, ${closest.locality || closest.region}, ${closest.city || closest.region}`;

  const cachedEntry = {
    address,
    nearestPlace: closest.name,
    locality: closest.locality || closest.region,
    city: closest.city || closest.region,
    region: closest.region,
    distanceMeters: Math.round(minDist)
  };

  if (REVERSE_CACHE.size >= MAX_REVERSE_CACHE_SIZE) {
    const firstKey = REVERSE_CACHE.keys().next().value;
    REVERSE_CACHE.delete(firstKey);
  }
  REVERSE_CACHE.set(cacheKey, cachedEntry);

  return { ...cachedEntry, latitude: lat, longitude: lon };
}

// PostgreSQL / PostGIS Direct Spatial Search
export async function ghanaSearchPostGIS(db, query, {limit = 10, near = null} = {}) {
  check(db, 500, 'Database required for PostGIS search');
  check(typeof query === 'string', 400, 'Search query must be text');
  const clean = query.trim();
  if (!clean) return [];

  const rawWords = clean.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 0 && !STOP_WORDS.has(w));
  const searchPattern = rawWords.join(' ');
  // Only filler words ("at the") would match every row and scan both tables, so there is nothing to look up.
  if (searchPattern.length < 2) return [];

  const nearLat = Number.isFinite(Number(near?.latitude)) ? Number(near.latitude) : null;
  const nearLon = Number.isFinite(Number(near?.longitude)) ? Number(near.longitude) : null;
  const res = await db.query(`
    SELECT id, name, category, subcategory, locality, city, region,
           latitude, longitude, aliases, entrance, popularity, street, coordinate_kind,
           verification_status, source, license,
           similarity(name, $1) AS name_sim,
           similarity(search_name, $1) AS sim
    FROM searchable_landmarks_v9
    WHERE search_name % $1
       OR name % $1
       OR search_name ILIKE '%' || $1 || '%'
    ORDER BY (
      CASE WHEN lower(name) = lower($1) THEN 50
           WHEN lower(name) LIKE lower($1) || '%' THEN 30
           ELSE 0 END +
      similarity(name, $1) * 50 +
      similarity(search_name, $1) * 30 +
      popularity * 0.5 +
      CASE WHEN $3::float8 IS NULL OR $4::float8 IS NULL THEN 0
           ELSE GREATEST(0, 80 - ST_Distance(geom, ST_SetSRID(ST_MakePoint($4::float8, $3::float8), 4326)::geography) / 800.0) END
    ) DESC
    LIMIT $2
  `, [searchPattern, Math.max(1, Math.min(limit, 30)), nearLat, nearLon]);

  return res.rows.map(r => {
    const road = r.category === 'road' || r.coordinate_kind === 'road_midpoint';
    return {
      id: r.id,
      name: r.name,
      label: road ? `Road · ${r.name}` : `${r.locality}, ${r.city}`,
      locality: r.locality,
      city: r.city,
      region: r.region,
      category: r.category,
      subcategory: r.subcategory || 'general',
      latitude: r.latitude,
      longitude: r.longitude,
      coordinate_kind: r.coordinate_kind || 'mapped_point',
      type: road ? 'road' : 'place',
      housenumber: null,
      aliases: r.aliases || [],
      entrance: r.entrance || null,
      street: road ? null : (r.street || null),
      verification_status: r.verification_status || null,
      source: r.source || null,
      license: r.license || null,
      score: Number((r.sim * 100).toFixed(1))
    };
  });
}

// PostgreSQL / PostGIS Direct Spatial Nearest Neighbor KNN Reverse Geocoding
export async function ghanaReverseGeocodePostGIS(db, lat, lon) {
  check(db, 500, 'Database required for PostGIS reverse geocoding');
  check(Number.isFinite(lat) && lat >= GHANA_BOUNDS.minLatitude && lat <= GHANA_BOUNDS.maxLatitude, 400, 'Latitude outside Ghana');
  check(Number.isFinite(lon) && lon >= GHANA_BOUNDS.minLongitude && lon <= GHANA_BOUNDS.maxLongitude, 400, 'Longitude outside Ghana');

  const res = await db.query(`
    SELECT id, name, category, locality, city, region, latitude, longitude,
           ST_Distance(geom, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_meters
    FROM searchable_landmarks_v9
    ORDER BY geom <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
    LIMIT 1
  `, [lat, lon]);

  if (!res.rows.length) {
    return {address: `Ghana (${lat.toFixed(5)}, ${lon.toFixed(5)})`, latitude: lat, longitude: lon};
  }

  const closest = res.rows[0];
  const distM = Number(closest.distance_meters);
  const distKm = distM / 1000;
  const distanceLabel = distKm < 0.1 ? 'At' : distKm < 1 ? `~${Math.round(distM)}m from` : `~${distKm.toFixed(1)} km from`;
  const address = `${distanceLabel} ${closest.name}, ${closest.locality}, ${closest.city}`;

  return {
    address,
    nearestPlace: closest.name,
    locality: closest.locality,
    city: closest.city,
    region: closest.region,
    distanceMeters: Math.round(distM),
    latitude: lat,
    longitude: lon
  };
}

/**
 * What the customer search box returns: the built-in places, plus places in the database (businesses added there and
 * places riders taught the map once they are approved). Those used to be saved but never offered in search.
 * If the database is slow or unavailable the built-in results are returned on their own.
 */
export async function searchPlaces(db, query, {limit = 10, timeoutMs = 800, near = null, ghanaPostGps = null, photonUrl = null, fetchImpl = fetch} = {}) {
  const digital = interpretDigitalAddress(query);
  if (digital) {
    if (typeof ghanaPostGps !== 'function') return digitalAddressUnavailable(digital);
    try {
      const found = await ghanaPostGps(digital.formatted);
      if (found?.found === true && Number.isFinite(Number(found.latitude)) && Number.isFinite(Number(found.longitude))) {
        return [{
          name: found.label || digital.formatted,
          label: digital.formatted,
          type: 'digital_address',
          digitalAddress: digital.formatted,
          available: true,
          found: true,
          latitude: Number(found.latitude),
          longitude: Number(found.longitude),
          source: 'GhanaPostGPS',
          requiresPinReview: true
        }];
      }
      return [{name: 'Digital address was not found', label: digital.formatted, type: 'digital_address', digitalAddress: digital.formatted, available: true, found: false, latitude: null, longitude: null}];
    } catch {
      return [{name: 'Digital address lookup is not available yet', label: digital.formatted, type: 'digital_address', digitalAddress: digital.formatted, available: false, latitude: null, longitude: null, uncertainty: 'GhanaPostGPS lookup did not answer. No coordinate was guessed.'}];
    }
  }
  const local = ghanaSearch(query, {limit, near});
  let photon = [];
  if (photonUrl && looksLikeStreetQuery(query)) photon = await photonSearch(query, {baseUrl: photonUrl, fetchImpl});
  if (!db) return dedupePlaces([...photon, ...local], limit);
  let stored = [];
  // The database stops the query itself after timeoutMs, so a slow search frees its connection instead of holding one
  // while bookings wait. The race is a second guard for a database that does not answer at all.
  const lookup = typeof db.tx === 'function'
    ? db.tx(async c => { await c.query(`SET LOCAL statement_timeout = ${Math.max(50, Math.min(5000, Math.round(timeoutMs)))}`); return ghanaSearchPostGIS(c, query, {limit, near}); })
    : ghanaSearchPostGIS(db, query, {limit, near});
  let timer;
  try {
    stored = await Promise.race([lookup, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs + 200, []); })]) || [];
  } catch { stored = []; } finally { clearTimeout(timer); }
  lookup.catch?.(() => {});
  const sameSpot = (a, b) => String(a.name).trim().toLowerCase() === String(b.name).trim().toLowerCase()
    && haversine({latitude: Number(a.latitude), longitude: Number(a.longitude)}, {latitude: Number(b.latitude), longitude: Number(b.longitude)}) < 150;
  const compact = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = compact(query);
  const fresh = stored.filter(s => Number.isFinite(Number(s.latitude)) && Number.isFinite(Number(s.longitude)) && !local.some(l => sameSpot(l, s)))
    .map(s => ({...s, latitude: Number(s.latitude), longitude: Number(s.longitude)}));
  // A stored place whose name holds everything typed is what was asked for; anything else follows the built-in results.
  const exact = fresh.filter(s => wanted.length >= 3 && compact(s.name).includes(wanted));
  const rest = fresh.filter(s => !exact.includes(s));
  return dedupePlaces([...photon, ...exact, ...local, ...rest], limit);
}

function dedupePlaces(rows, limit) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${String(row?.name || '').toLowerCase()}|${Number(row?.latitude).toFixed(4)}|${Number(row?.longitude).toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}
