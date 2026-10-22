import {GHANA_GAZETTEER, ghanaSearch} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';

// Replicate the exact 1,000 benchmark sample
const step = Math.floor(GHANA_GAZETTEER.length / 1000);
const sample = [];
for (let i = 0; i < GHANA_GAZETTEER.length && sample.length < 1000; i += step) {
  sample.push(GHANA_GAZETTEER[i]);
}

const top1Errors = [];
const top5Errors = [];

for (let i = 0; i < sample.length; i++) {
  const target = sample[i];
  let queryText = target.name;
  let hasTypo = false;
  if (i % 4 === 1 && target.name.length > 5) {
    const idx = 3;
    queryText = target.name.slice(0, idx) + target.name[idx] + target.name.slice(idx);
    hasTypo = true;
  }

  const res = ghanaSearch(queryText, {limit: 5});
  const isTop1 = res.length > 0 && (res[0].name === target.name || (res[0].latitude === target.latitude && res[0].longitude === target.longitude));
  const isTop5 = res.some(r => r.name === target.name || (r.latitude === target.latitude && r.longitude === target.longitude));

  if (!isTop1) {
    top1Errors.push({
      index: i,
      queryText,
      hasTypo,
      targetName: target.name,
      targetRegion: target.region,
      top1Result: res[0]?.name || 'NO_RESULT',
      top1Region: res[0]?.region || 'N/A',
      foundInTop5: isTop5
    });
  }
  if (!isTop5) {
    top5Errors.push({
      index: i,
      queryText,
      hasTypo,
      targetName: target.name,
      targetRegion: target.region,
      resultsCount: res.length,
      topResults: res.map(r => r.name)
    });
  }
}

console.log(`Total Top-1 Errors: ${top1Errors.length}`);
console.log(`Total Top-5 Errors: ${top5Errors.length}`);

// Categorize Top-1 Errors
const categories = {
  typoRelated: top1Errors.filter(e => e.hasTypo).length,
  nonTypoRelated: top1Errors.filter(e => !e.hasTypo).length,
  inTop5ButNotTop1: top1Errors.filter(e => e.foundInTop5).length,
  completelyMissing: top1Errors.filter(e => !e.foundInTop5).length
};
console.log('Error Breakdown:', categories);

// Show sample top 1 errors
console.log('\nSample Top-1 Errors (First 15):');
for (const err of top1Errors.slice(0, 15)) {
  console.log(`- Query: "${err.queryText}" (Target: "${err.targetName}" [${err.targetRegion}]) -> Got Top-1: "${err.top1Result}" [${err.top1Region}] | inTop5: ${err.foundInTop5}`);
}

// Show sample top 5 errors
console.log('\nSample Top-5 Misses (First 10):');
for (const err of top5Errors.slice(0, 10)) {
  console.log(`- Query: "${err.queryText}" (Target: "${err.targetName}" [${err.targetRegion}]) -> Found: [${err.topResults.join(', ')}]`);
}
