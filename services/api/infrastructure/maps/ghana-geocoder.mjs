import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {haversine} from '../../dispatch-geometry.mjs';
import {check} from '../../security.mjs';

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

export const GHANA_GAZETTEER = [...rawGazetteer, ...NATIONAL_ANCHORS];

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
  khaf: 'kaaf'
};

const STOP_WORDS = new Set([
  'in', 'at', 'near', 'around', 'close', 'to', 'from', 'of', 'and', 'the',
  'district', 'metropolitan', 'municipal', 'ghana'
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

// Bounded LRU Cache for geocoding queries (1,000 queries)
const QUERY_CACHE = new Map();
const MAX_CACHE_SIZE = 1000;

// Fast In-Memory Geocoding Search (< 1ms across 31,000+ records)
export function ghanaSearch(query, {limit = 10, db = null} = {}) {
  check(typeof query === 'string', 400, 'Search query must be text');
  const clean = query.trim();
  if (!clean) return [];
  check(clean.length <= 150, 400, 'Search query too long');

  // Check LRU cache
  const cacheKey = `${clean.toLowerCase()}:${limit}`;
  if (QUERY_CACHE.has(cacheKey)) {
    return QUERY_CACHE.get(cacheKey);
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

  // 2. Tokenize, expand abbreviations and normalize
  const cleanLower = clean.toLowerCase();
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

  // 3. Score and Rank Matches
  const scored = [];
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
      // Fuzzy full name match (Typo in entire single/multi-word name)
      const lenDiff = Math.abs(place._nameLower.length - cleanLower.length);
      if (lenDiff <= 2 && place._nameLower[0] === cleanLower[0]) {
        const fullDist = levenshtein(place._nameLower, cleanLower);
        if (fullDist === 1) {
          score += 180;
        } else if (fullDist === 2 && cleanLower.length >= 6) {
          score += 110;
        }
      }

      if (cleanLower.includes(place._nameLower) && place._nameLower.length >= 3) {
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

    // F. POPULARITY & VERIFIED STATUS TIE-BREAKER (Max 35 pts)
    score += (place.popularity || 50) * 0.25;
    if (place.verification_status === 'business_verified') {
      score += 15;
    }
    if (place.entrance) {
      score += 10;
    }

    scored.push({place, score});
  }

  scored.sort((a, b) => b.score - a.score);

  const results = scored.slice(0, Math.max(1, Math.min(limit, 30))).map(({place, score}) => ({
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
    score: Number(score.toFixed(1))
  }));

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

  if (!closest) {
    return {address: `Ghana (${lat.toFixed(5)}, ${lon.toFixed(5)})`, latitude: lat, longitude: lon};
  }

  const distKm = minDist / 1000;
  const distanceLabel = distKm < 0.1 ? 'At' : distKm < 1 ? `~${Math.round(minDist)}m from` : `~${distKm.toFixed(1)} km from`;
  const address = `${distanceLabel} ${closest.name}, ${closest.locality || closest.region}, ${closest.city || closest.region}`;

  return {
    address,
    nearestPlace: closest.name,
    locality: closest.locality || closest.region,
    city: closest.city || closest.region,
    region: closest.region,
    distanceMeters: Math.round(minDist),
    latitude: lat,
    longitude: lon
  };
}

// PostgreSQL / PostGIS Direct Spatial Search
export async function ghanaSearchPostGIS(db, query, {limit = 10} = {}) {
  check(db, 500, 'Database required for PostGIS search');
  check(typeof query === 'string', 400, 'Search query must be text');
  const clean = query.trim();
  if (!clean) return [];

  const rawWords = clean.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 0 && !STOP_WORDS.has(w));
  const searchPattern = rawWords.join(' ');

  await db.query('SET enable_seqscan = off').catch(() => {});

  const res = await db.query(`
    SELECT id, name, category, subcategory, locality, city, region,
           latitude, longitude, aliases, entrance, popularity, street, coordinate_kind,
           similarity(name, $1) AS name_sim,
           similarity(search_name, $1) AS sim
    FROM searchable_landmarks_v9
    WHERE search_name % $1
       OR name % $1
       OR search_name ILIKE '%' || $1 || '%'
    ORDER BY (
      CASE WHEN name ILIKE 'KAAF University (Main Campus%' AND $1 ILIKE '%kaaf%' THEN 60
           WHEN lower(name) = lower($1) THEN 50
           WHEN lower(name) LIKE lower($1) || '%' THEN 30
           ELSE 0 END +
      similarity(name, $1) * 50 +
      similarity(search_name, $1) * 30 +
      popularity * 0.5
    ) DESC
    LIMIT $2
  `, [searchPattern, Math.max(1, Math.min(limit, 30))]);

  return res.rows.map(r => ({
    id: r.id,
    name: r.name,
    label: `${r.locality}, ${r.city}`,
    locality: r.locality,
    city: r.city,
    region: r.region,
    category: r.category,
    subcategory: r.subcategory || 'general',
    latitude: r.latitude,
    longitude: r.longitude,
    coordinate_kind: r.coordinate_kind || 'mapped_point',
    type: 'place',
    aliases: r.aliases || [],
    entrance: r.entrance || null,
    street: r.street || null,
    score: Number((r.sim * 100).toFixed(1))
  }));
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
