import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const gazetteerPath = join(projectRoot, 'services', 'api', 'infrastructure', 'maps', 'ghana-gazetteer-data.json');
const gazetteer = JSON.parse(readFileSync(gazetteerPath, 'utf8'));

// Deterministic Pseudo-random number generator (LCG) with fixed seed for true reproducibility
let seed = 123456789;
function pseudoRandom() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

function sampleFromArray(arr, count) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(pseudoRandom() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

// Group by region
const byRegion = {};
for (const p of gazetteer) {
  if (!byRegion[p.region]) byRegion[p.region] = [];
  byRegion[p.region].push(p);
}

// Target distribution for 2,000 queries:
// Greater Accra: 800, Ashanti: 500, Central: 350, Eastern: 200, Ahafo: 100, Bono: 50 = 2,000
const targets = [
  {region: 'Greater Accra', count: 800},
  {region: 'Ashanti', count: 500},
  {region: 'Central', count: 350},
  {region: 'Eastern', count: 200},
  {region: 'Ahafo', count: 100},
  {region: 'Bono', count: 50}
];

const selectedPlaces = [];
for (const {region, count} of targets) {
  const pool = byRegion[region] || [];
  const chosen = sampleFromArray(pool, count);
  selectedPlaces.push(...chosen);
}

console.log(`Total selected places: ${selectedPlaces.length}`);

// Typo generator with realistic human typing errors:
// 1. Double letter / extra letter
// 2. Missed letter
// 3. Adjacent keyboard swap or transposition
// 4. Common phonetic substitutions
function introduceTypo(text) {
  if (text.length <= 4) return text;
  const chars = text.split('');
  const pos = 2 + Math.floor(pseudoRandom() * (chars.length - 3));
  const mode = Math.floor(pseudoRandom() * 4);

  if (mode === 0) {
    // Duplicate letter
    chars.splice(pos, 0, chars[pos]);
  } else if (mode === 1) {
    // Delete letter
    chars.splice(pos, 1);
  } else if (mode === 2 && pos < chars.length - 1) {
    // Transpose adjacent
    const tmp = chars[pos];
    chars[pos] = chars[pos + 1];
    chars[pos + 1] = tmp;
  } else {
    // Substitute common vowel or consonant
    const swaps = {'a': 'e', 'e': 'i', 'o': 'u', 'k': 'c', 'c': 'k', 's': 'z', 'm': 'n'};
    if (swaps[chars[pos].toLowerCase()]) {
      chars[pos] = swaps[chars[pos].toLowerCase()];
    }
  }
  return chars.join('');
}

// Build 2,000 diverse test query cases
const benchmarkCases = [];

for (let i = 0; i < selectedPlaces.length; i++) {
  const place = selectedPlaces[i];
  let query = place.name;
  let queryType = 'exact_name';

  const variantType = i % 5;
  if (variantType === 0) {
    // 20%: Exact name query
    query = place.name;
    queryType = 'exact_name';
  } else if (variantType === 1) {
    // 20%: Name + Locality/City qualifier
    if (place.locality && place.locality !== place.name && place.locality !== place.region) {
      query = `${place.name}, ${place.locality}`;
      queryType = 'name_and_locality';
    } else {
      query = `${place.name}, ${place.region}`;
      queryType = 'name_and_region';
    }
  } else if (variantType === 2) {
    // 20%: Query with realistic human typo
    const words = place.name.split(' ');
    if (words.length === 1) {
      query = introduceTypo(words[0]);
    } else {
      const targetWordIdx = Math.floor(pseudoRandom() * words.length);
      words[targetWordIdx] = introduceTypo(words[targetWordIdx]);
      query = words.join(' ');
    }
    queryType = 'typo_tolerance';
  } else if (variantType === 3) {
    // 20%: Lowercase + no punctuation query
    query = place.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    queryType = 'lowercase_unpunctuated';
  } else {
    // 20%: Name + City or Region
    query = `${place.name} ${place.city || place.region}`;
    queryType = 'name_and_city';
  }

  benchmarkCases.push({
    id: `BENCH_${(i + 1).toString().padStart(4, '0')}`,
    query: query.trim(),
    queryType,
    target: {
      name: place.name,
      locality: place.locality,
      city: place.city,
      region: place.region,
      category: place.category,
      latitude: place.latitude,
      longitude: place.longitude
    }
  });
}

// Ensure fixture dir exists
const fixtureDir = join(projectRoot, 'tests', 'fixtures');
if (!existsSync(fixtureDir)) {
  mkdirSync(fixtureDir, {recursive: true});
}

const outputPath = join(fixtureDir, 'search-benchmark-2000.json');
writeFileSync(outputPath, JSON.stringify(benchmarkCases, null, 2), 'utf8');

console.log(`Successfully generated and FROZE 2,000 benchmark queries at:\n${outputPath}`);

// Print category distribution
const catCount = {};
const typeCount = {};
for (const b of benchmarkCases) {
  catCount[b.target.category] = (catCount[b.target.category] || 0) + 1;
  typeCount[b.queryType] = (typeCount[b.queryType] || 0) + 1;
}
console.log('\nQuery Types:', typeCount);
console.log('\nCategories:', catCount);
