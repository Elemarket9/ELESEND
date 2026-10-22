import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const gazetteerPath = join(projectRoot, 'services', 'api', 'infrastructure', 'maps', 'ghana-gazetteer-data.json');
const rawGazetteer = JSON.parse(readFileSync(gazetteerPath, 'utf8'));

// Foundational national regional anchors for remaining 10 administrative regions
const NATIONAL_ANCHORS = [
  {name:'Takoradi Market Circle',category:'market',locality:'Market Circle',city:'Takoradi',region:'Western',latitude:4.8872,longitude:-1.7584,popularity:88},
  {name:'Sekondi Commercial Area',category:'town',locality:'Sekondi Central',city:'Sekondi',region:'Western',latitude:4.9392,longitude:-1.7136,popularity:80},
  {name:'Tarkwa Market Circle',category:'market',locality:'Central',city:'Tarkwa',region:'Western',latitude:5.3012,longitude:-1.9961,popularity:79},
  {name:'Axim Town Center',category:'town',locality:'Central',city:'Axim',region:'Western',latitude:4.8699,longitude:-2.2405,popularity:75},
  {name:'Tamale Central Market',category:'market',locality:'Central',city:'Tamale',region:'Northern',latitude:9.4072,longitude:-0.8392,popularity:86},
  {name:'Savelugu Main Station',category:'transit',locality:'Central',city:'Savelugu',region:'Northern',latitude:9.6253,longitude:-0.8267,popularity:75},
  {name:'Ho Central Market',category:'market',locality:'Central',city:'Ho',region:'Volta',latitude:6.6112,longitude:0.4715,popularity:76},
  {name:'Hohoe Central Market',category:'market',locality:'Central',city:'Hohoe',region:'Volta',latitude:7.1519,longitude:0.4736,popularity:74},
  {name:'Keta Central Market',category:'market',locality:'Central',city:'Keta',region:'Volta',latitude:5.9179,longitude:0.9879,popularity:73},
  {name:'Techiman Central Market',category:'market',locality:'Central',city:'Techiman',region:'Bono East',latitude:7.5855,longitude:-1.9395,popularity:84},
  {name:'Kintampo Waterfalls / Town',category:'landmark',locality:'Central',city:'Kintampo',region:'Bono East',latitude:8.0563,longitude:-1.7306,popularity:76},
  {name:'Atebubu Market',category:'market',locality:'Central',city:'Atebubu',region:'Bono East',latitude:7.7561,longitude:-0.9934,popularity:73},
  {name:'Sefwi Wiawso Central',category:'town',locality:'Central',city:'Sefwi Wiawso',region:'Western North',latitude:6.2162,longitude:-2.4847,popularity:75},
  {name:'Bibiani Commercial Area',category:'town',locality:'Central',city:'Bibiani',region:'Western North',latitude:6.4635,longitude:-2.3321,popularity:74},
  {name:'Dambai Central / Lakeside',category:'market',locality:'Central',city:'Dambai',region:'Oti',latitude:8.0683,longitude:0.1794,popularity:75},
  {name:'Nkwanta Market',category:'market',locality:'Central',city:'Nkwanta',region:'Oti',latitude:8.2589,longitude:0.5204,popularity:72},
  {name:'Jasikan Town Center',category:'town',locality:'Central',city:'Jasikan',region:'Oti',latitude:7.4089,longitude:0.4686,popularity:71},
  {name:'Damongo Central',category:'town',locality:'Central',city:'Damongo',region:'Savannah',latitude:9.0833,longitude:-1.8167,popularity:75},
  {name:'Bole Main Station',category:'transit',locality:'Central',city:'Bole',region:'Savannah',latitude:9.0342,longitude:-2.4831,popularity:73},
  {name:'Salaga Market',category:'market',locality:'Central',city:'Salaga',region:'Savannah',latitude:8.5508,longitude:-0.5186,popularity:72},
  {name:'Nalerigu Town Center',category:'town',locality:'Central',city:'Nalerigu',region:'North East',latitude:10.5312,longitude:-0.3708,popularity:75},
  {name:'Walewale Market',category:'market',locality:'Central',city:'Walewale',region:'North East',latitude:10.3524,longitude:-0.8003,popularity:74},
  {name:'Gambaga Old Town',category:'landmark',locality:'Central',city:'Gambaga',region:'North East',latitude:10.5318,longitude:-0.4439,popularity:71},
  {name:'Bolgatanga Central Market',category:'market',locality:'Central',city:'Bolgatanga',region:'Upper East',latitude:10.7874,longitude:-0.8580,popularity:80},
  {name:'Navrongo Central Market',category:'market',locality:'Central',city:'Navrongo',region:'Upper East',latitude:10.8956,longitude:-1.0921,popularity:77},
  {name:'Bawku Central Market',category:'market',locality:'Central',city:'Bawku',region:'Upper East',latitude:11.0558,longitude:-0.2417,popularity:76},
  {name:'Wa Central Market',category:'market',locality:'Central',city:'Wa',region:'Upper West',latitude:10.0607,longitude:-2.5099,popularity:80},
  {name:'Lawra Town Center',category:'town',locality:'Central',city:'Lawra',region:'Upper West',latitude:10.6433,longitude:-2.8242,popularity:72}
];

const GHANA_GAZETTEER = [...rawGazetteer, ...NATIONAL_ANCHORS];

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
  khaf: 'kaaf',
  kia: 'kotoka international airport',
  kath: 'komfo anokye teaching hospital',
  kbth: 'korle bu teaching hospital',
  akyem: 'akim',
  coomassie: 'kumasi',
  oguaa: 'cape coast'
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

function soundex(s) {
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

function levenshtein(a, b) {
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

// Build Inverted Index, Initial Bucket Index, Soundex Index
const INVERTED_INDEX = new Map();
const INITIAL_BUCKET = new Map();
const SOUNDEX_INDEX = new Map();

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
}

// Advanced Candidate Generation & Scoring Engine
function improvedGhanaSearch(query, {limit = 10} = {}) {
  const clean = query.trim();
  if (!clean) return [];

  const cleanLower = clean.toLowerCase();
  const expandedQuery = ABBREVIATIONS[cleanLower] || cleanLower;

  // Extract detected region mentions in the query
  const queryRegions = [];
  for (const r of ALL_REGIONS) {
    if (cleanLower.includes(r)) queryRegions.push(r);
  }

  // Tokenize
  const rawWords = expandedQuery.split(/[^a-z0-9]+/).filter(w => w.length > 0 && !STOP_WORDS.has(w));
  if (!rawWords.length) return [];

  const terms = rawWords.map(w => ABBREVIATIONS[w] || w);
  const candidateScores = new Map(); // placeIdx -> {matchCount, termMatchScores, exactTermMatches}

  for (let ti = 0; ti < terms.length; ti++) {
    const term = terms[ti];
    const rawWord = rawWords[ti];

    // 1. Exact matches
    const exactList = INVERTED_INDEX.get(term) || (rawWord !== term ? INVERTED_INDEX.get(rawWord) : null);
    if (exactList) {
      for (const idx of exactList) {
        let entry = candidateScores.get(idx);
        if (!entry) {
          entry = {matchCount: 0, score: 0, exactMatches: 0};
          candidateScores.set(idx, entry);
        }
        entry.matchCount++;
        entry.exactMatches++;
        entry.score += 50;
      }
    }

    // 2. Prefix matches (for terms >= 3 chars)
    const firstChar = term[0];
    const bucket = INITIAL_BUCKET.get(firstChar);
    if (bucket && term.length >= 3) {
      for (const indexedWord of bucket) {
        if (indexedWord === term) continue; // already handled
        if (indexedWord.startsWith(term) || (rawWord !== term && indexedWord.startsWith(rawWord))) {
          const list = INVERTED_INDEX.get(indexedWord) || [];
          for (const idx of list) {
            let entry = candidateScores.get(idx);
            if (!entry) {
              entry = {matchCount: 0, score: 0, exactMatches: 0};
              candidateScores.set(idx, entry);
            }
            entry.matchCount++;
            entry.score += 30;
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
              let entry = candidateScores.get(idx);
              if (!entry) {
                entry = {matchCount: 0, score: 0, exactMatches: 0};
                candidateScores.set(idx, entry);
              }
              entry.matchCount++;
              entry.score += typoBonus;
            }
          }
        }
      }
    }

    // 4. Phonetic Soundex (for terms >= 4 chars, fallback if few candidates)
    if (candidateScores.size < 30 && term.length >= 4) {
      const snd = soundex(term);
      const sndList = SOUNDEX_INDEX.get(snd) || [];
      for (const idx of sndList) {
        let entry = candidateScores.get(idx);
        if (!entry) {
          entry = {matchCount: 0, score: 0, exactMatches: 0};
          candidateScores.set(idx, entry);
        }
        entry.matchCount++;
        entry.score += 20;
      }
    }
  }

  // Score and Rank
  const scored = [];
  const minMatches = terms.length <= 2 ? 1 : Math.ceil(terms.length * 0.6);

  for (const [idx, data] of candidateScores) {
    if (data.matchCount < minMatches) continue;

    const place = GHANA_GAZETTEER[idx];
    let score = data.score;

    // A. EXACT FULL NAME MATCH (Highest possible priority)
    if (place._nameLower === cleanLower || place._nameLower === expandedQuery) {
      score += 250;
    } else {
      // Fuzzy full name match (Typo in entire single/multi-word name)
      const lenDiff = Math.abs(place._nameLower.length - cleanLower.length);
      if (lenDiff <= 2) {
        const fullDist = levenshtein(place._nameLower, cleanLower);
        if (fullDist === 1) {
          score += 180;
        } else if (fullDist === 2 && cleanLower.length >= 6) {
          score += 110;
        }
      }
      
      if (cleanLower.includes(place._nameLower) && place._nameLower.length >= 3) {
        // Query contains place full name (e.g. "Koforidua Market, Eastern Region")
        // Scale by coverage of place name in query to prevent single common words dominating
        const ratio = place._nameLower.length / cleanLower.length;
        score += Math.round(120 * ratio);
      } else if (place._nameLower.startsWith(cleanLower) || place._nameLower.startsWith(terms[0])) {
        score += 40;
      }
    }

    // B. QUERY TERM COVERAGE BONUS (Places matching all or most query terms win)
    const coverage = Math.min(1.0, data.matchCount / terms.length);
    score += coverage * 140;

    // C. EXACT PHRASE IN SEARCHABLE TEXT
    if (place._searchable.includes(cleanLower) || place._searchable.includes(expandedQuery)) {
      score += 50;
    }

    // C. GEOGRAPHIC CONTEXT ALIGNMENT (General algorithms, universal for all communities)
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
        score += 60; // Query explicitly specified this region!
      } else {
        score -= 90; // Query explicitly specified a DIFFERENT region!
      }
    }

    // D. LENGTH PENALTY FOR UNNECESSARY WORD SPRAWL
    // If the query is short, prefer places whose names are concise matches over places with 10 extra words
    const nameWords = place._nameLower.split(/\s+/).length;
    if (nameWords > terms.length + 3) {
      score -= (nameWords - terms.length) * 3;
    }

    // E. POPULARITY TIE-BREAKER (Max 25 pts)
    score += (place.popularity || 50) * 0.25;

    scored.push({place, score});
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({place, score}) => ({
    name: place.name,
    locality: place.locality,
    city: place.city,
    region: place.region,
    category: place.category,
    latitude: place.latitude,
    longitude: place.longitude,
    score
  }));
}

// Run test against the 2,000 frozen benchmark queries
const benchmarkPath = join(projectRoot, 'tests', 'fixtures', 'search-benchmark-2000.json');
const testCases = JSON.parse(readFileSync(benchmarkPath, 'utf8'));

console.log('Evaluating improved algorithm on frozen 2,000 queries...');
let top1Hits = 0;
let top5Hits = 0;
let totalDurationMs = 0;

for (let i = 0; i < testCases.length; i++) {
  const tc = testCases[i];
  const t0 = performance.now();
  const results = improvedGhanaSearch(tc.query, {limit: 5});
  totalDurationMs += (performance.now() - t0);

  const isMatch = (res) => {
    if (!res) return false;
    if (res.name.toLowerCase() === tc.target.name.toLowerCase()) return true;
    if (Math.abs(res.latitude - tc.target.latitude) < 0.001 && Math.abs(res.longitude - tc.target.longitude) < 0.001) return true;
    return false;
  };

  if (isMatch(results[0])) top1Hits++;
  if (results.some(isMatch)) top5Hits++;
}

const avgMs = totalDurationMs / testCases.length;
const top1Acc = (top1Hits / testCases.length) * 100;
const top5Rec = (top5Hits / testCases.length) * 100;

console.log('\n==================================================');
console.log('IMPROVED ALGORITHM RESULTS ON FROZEN 2,000 BENCHMARK');
console.log('==================================================');
console.log(`Top-1 Accuracy: ${top1Acc.toFixed(2)}% (${top1Hits}/${testCases.length})`);
console.log(`Top-5 Recall: ${top5Rec.toFixed(2)}% (${top5Hits}/${testCases.length})`);
console.log(`Average Latency: ${avgMs.toFixed(3)}ms per query`);

// Analyze remaining top 1 errors
const remainingErrors = [];
for (let i = 0; i < testCases.length; i++) {
  const tc = testCases[i];
  const results = improvedGhanaSearch(tc.query, {limit: 5});
  const isMatch = (res) => {
    if (!res) return false;
    if (res.name.toLowerCase() === tc.target.name.toLowerCase()) return true;
    if (Math.abs(res.latitude - tc.target.latitude) < 0.001 && Math.abs(res.longitude - tc.target.longitude) < 0.001) return true;
    return false;
  };
  if (!isMatch(results[0])) {
    remainingErrors.push({
      id: tc.id,
      query: tc.query,
      type: tc.queryType,
      target: `${tc.target.name} [${tc.target.region}]`,
      top1: results[0] ? `${results[0].name} [${results[0].region}] (score: ${results[0].score})` : 'NO_RESULT',
      inTop5: results.some(isMatch)
    });
  }
}

const errByType = {};
for (const e of remainingErrors) {
  errByType[e.type] = (errByType[e.type] || 0) + 1;
}
console.log('\nRemaining Errors by Type (Total: ' + remainingErrors.length + '):', errByType);
console.log('\nSample Remaining Errors (first 10):');
console.log(remainingErrors.slice(0, 10));
