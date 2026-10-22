import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ghanaSearch} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const benchmarkPath = join(projectRoot, 'tests', 'fixtures', 'search-benchmark-2000.json');
const testCases = JSON.parse(readFileSync(benchmarkPath, 'utf8'));

console.log(`Running baseline benchmark on ${testCases.length} frozen queries...`);

let top1Hits = 0;
let top5Hits = 0;
let totalDurationMs = 0;
const errorsByType = {};
const misses = [];

const t0Start = performance.now();

for (let i = 0; i < testCases.length; i++) {
  const tc = testCases[i];
  const t0 = performance.now();
  const results = ghanaSearch(tc.query, {limit: 5});
  const dur = performance.now() - t0;
  totalDurationMs += dur;

  const isMatch = (res) => {
    if (!res) return false;
    if (res.name.toLowerCase() === tc.target.name.toLowerCase()) return true;
    if (Math.abs(res.latitude - tc.target.latitude) < 0.001 && Math.abs(res.longitude - tc.target.longitude) < 0.001) return true;
    return false;
  };

  const top1 = isMatch(results[0]);
  const top5 = results.some(isMatch);

  if (top1) top1Hits++;
  if (top5) top5Hits++;

  if (!top1) {
    errorsByType[tc.queryType] = (errorsByType[tc.queryType] || 0) + 1;
    if (!top5 && misses.length < 20) {
      misses.push({
        id: tc.id,
        query: tc.query,
        type: tc.queryType,
        target: `${tc.target.name} (${tc.target.region})`,
        got: results.slice(0, 3).map(r => `${r.name} (${r.region})`)
      });
    }
  }
}

const totalWallMs = performance.now() - t0Start;
const avgLatencyMs = totalDurationMs / testCases.length;
const top1Accuracy = (top1Hits / testCases.length) * 100;
const top5Recall = (top5Hits / testCases.length) * 100;

console.log('\n==================================================');
console.log('BASELINE FROZEN 2,000-QUERY SEARCH BENCHMARK');
console.log('==================================================');
console.log(`Total Queries Evaluated: ${testCases.length}`);
console.log(`Top-1 Accuracy: ${top1Accuracy.toFixed(2)}% (${top1Hits}/${testCases.length})`);
console.log(`Top-5 Recall: ${top5Recall.toFixed(2)}% (${top5Hits}/${testCases.length})`);
console.log(`Average Latency: ${avgLatencyMs.toFixed(3)}ms per query`);
console.log(`Total Wall Clock Time: ${totalWallMs.toFixed(1)}ms`);
console.log('\nTop-1 Errors by Query Type:');
console.log(errorsByType);
console.log('\nSample Top-5 Misses:');
console.log(misses.slice(0, 10));
