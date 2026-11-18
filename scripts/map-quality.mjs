// Runs the checks in config/map-quality.json. Searches always run; routes run when OSRM is reachable.
// Usage: ROUTING_OSRM_CAR_URL=... ROUTING_OSRM_MOTORCYCLE_URL=... node scripts/map-quality.mjs [--routes-required]
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {ghanaSearch} from '../services/api/modules/maps/ghana-geocoder.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MAP_QUALITY = JSON.parse(readFileSync(join(root, 'config/map-quality.json'), 'utf8'));
const crowKm = (a, b) => { const r = Math.PI / 180, x = (b[1] - a[1]) * r * Math.cos((a[0] + b[0]) / 2 * r), y = (b[0] - a[0]) * r; return Math.hypot(x, y) * 6371; };

export function searchFailures(cases = MAP_QUALITY.searches) {
  return cases.flatMap(c => { const top = ghanaSearch(c.query, {limit: 3})[0]; return top && new RegExp(c.first, 'i').test(top.name) ? [] : [`search "${c.query}": expected "${c.first}" first, got "${top?.name ?? 'nothing'}"`]; });
}

export async function routeResults(endpoints, cases = MAP_QUALITY.routes, rules = MAP_QUALITY.routeRules) {
  const rows = [];
  for (const c of cases) for (const vehicle of c.vehicles) {
    const base = endpoints[vehicle];
    if (!base) { rows.push({name: c.name, vehicle, skipped: 'no routing endpoint'}); continue; }
    const url = `${base.replace(/\/$/, '')}/route/v1/driving/${c.from[1]},${c.from[0]};${c.to[1]},${c.to[0]}?overview=false`;
    let body;
    try { body = await (await fetch(url, {signal: AbortSignal.timeout(15000)})).json(); } catch (e) { rows.push({name: c.name, vehicle, problem: 'routing unreachable: ' + e.message}); continue; }
    const route = body?.routes?.[0];
    if (body?.code !== 'Ok' || !route) { rows.push({name: c.name, vehicle, problem: `no road route (${body?.code})`}); continue; }
    const km = route.distance / 1000, minutes = route.duration / 60, crow = crowKm(c.from, c.to), kmh = km / (minutes / 60);
    const problems = [];
    if (km > crow * rules.maxDetourFactor + 0.5) problems.push(`road ${km.toFixed(1)} km is over ${rules.maxDetourFactor}x the ${crow.toFixed(1)} km straight line`);
    if (km < crow * 0.98) problems.push(`road ${km.toFixed(1)} km is shorter than the straight line`);
    if (kmh < rules.minAverageKmh || kmh > rules.maxAverageKmh) problems.push(`average ${kmh.toFixed(0)} km/h is outside ${rules.minAverageKmh}-${rules.maxAverageKmh}`);
    if (c.minKm !== undefined && km < c.minKm) problems.push(`road ${km.toFixed(1)} km below expected ${c.minKm}`);
    if (c.maxKm !== undefined && km > c.maxKm) problems.push(`road ${km.toFixed(1)} km above expected ${c.maxKm}`);
    rows.push({name: c.name, vehicle, km: +km.toFixed(2), minutes: +minutes.toFixed(1), ...(problems.length ? {problem: problems.join('; ')} : {})});
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = searchFailures();
  for (const f of failures) console.log('FAIL', f);
  console.log(`searches: ${MAP_QUALITY.searches.length - failures.length}/${MAP_QUALITY.searches.length} passed`);
  const rows = await routeResults({car: process.env.ROUTING_OSRM_CAR_URL, motorcycle: process.env.ROUTING_OSRM_MOTORCYCLE_URL});
  for (const r of rows) console.log(r.problem ? 'FAIL' : r.skipped ? 'SKIP' : 'ok  ', r.vehicle.padEnd(10), r.name, r.km !== undefined ? `${r.km} km ${r.minutes} min` : '', r.problem || r.skipped || '');
  const routeFailures = rows.filter(r => r.problem).length, skipped = rows.filter(r => r.skipped).length;
  if (process.argv.includes('--routes-required') && skipped) { console.log('Routes were required but routing was not configured'); process.exit(1); }
  process.exit(failures.length || routeFailures ? 1 : 0);
}
