import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ghanaSearch} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';
import {database} from '../services/api/db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const benchmarkPath = join(projectRoot, 'tests', 'fixtures', 'search-benchmark-2000.json');
const testCases = JSON.parse(readFileSync(benchmarkPath, 'utf8'));

async function run() {
  console.log('=== CONCURRENT SEARCH & RESOURCE PERFORMANCE BENCHMARK ===');

  const initialMemory = process.memoryUsage();
  console.log(`Initial Node RSS: ${(initialMemory.rss / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Initial Heap Used: ${(initialMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`);

  // Query database storage metrics from PostgreSQL
  const db = database(process.env.DATABASE_URL);
  const storageInfo = await db.query(`
    SELECT
      pg_size_pretty(pg_total_relation_size('spatial_landmarks')) AS total_size,
      pg_size_pretty(pg_relation_size('spatial_landmarks')) AS table_size,
      pg_size_pretty(pg_indexes_size('spatial_landmarks')) AS indexes_size
  `);
  console.log('\nPostgreSQL PostGIS `spatial_landmarks` Storage:');
  console.log(`- Table Data Size: ${storageInfo.rows[0].table_size}`);
  console.log(`- Indexes Size:    ${storageInfo.rows[0].indexes_size}`);
  console.log(`- Total Footprint: ${storageInfo.rows[0].total_size}`);

  // Test under concurrency: 20 concurrent workers processing 2,000 queries
  const concurrency = 20;
  const latencies = [];
  const startTotal = performance.now();

  const chunkSize = Math.ceil(testCases.length / concurrency);
  const workers = [];

  for (let w = 0; w < concurrency; w++) {
    const slice = testCases.slice(w * chunkSize, (w + 1) * chunkSize);
    workers.push((async () => {
      for (const tc of slice) {
        const t0 = performance.now();
        ghanaSearch(tc.query, {limit: 5});
        const elapsed = performance.now() - t0;
        latencies.push(elapsed);
      }
    })());
  }

  await Promise.all(workers);
  const totalElapsedMs = performance.now() - startTotal;

  // Compute percentiles: p50, p90, p95, p99
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)];
  const p90 = latencies[Math.floor(latencies.length * 0.90)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  const throughputRps = (testCases.length / (totalElapsedMs / 1000));

  const finalMemory = process.memoryUsage();

  console.log('\nConcurrency Results (20 Parallel Workers, 2,000 Queries):');
  console.log(`- Completed Queries: ${latencies.length}`);
  console.log(`- Total Wall Time:   ${totalElapsedMs.toFixed(1)} ms`);
  console.log(`- Throughput:        ${throughputRps.toFixed(1)} req/sec`);
  console.log(`- p50 Latency:       ${p50.toFixed(3)} ms`);
  console.log(`- p90 Latency:       ${p90.toFixed(3)} ms`);
  console.log(`- p95 Latency:       ${p95.toFixed(3)} ms`);
  console.log(`- p99 Latency:       ${p99.toFixed(3)} ms`);

  console.log('\nMemory Profile:');
  console.log(`- Final Node RSS:    ${(finalMemory.rss / 1024 / 1024).toFixed(2)} MB`);
  console.log(`- Heap Used:         ${(finalMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log(`- Delta RSS:         ${((finalMemory.rss - initialMemory.rss) / 1024 / 1024).toFixed(2)} MB`);

  await db.close();
}

run().catch(console.error);
