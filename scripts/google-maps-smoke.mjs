// Live check of ELESEND's Google Maps adapters against the real Google APIs, with your key.
// About 12 billable requests: 4 routes, 1 matrix of 3, 3 place searches, 1 tile session and 2 tiles.
//   GOOGLE_MAPS_API_KEY=... node scripts/google-maps-smoke.mjs
// Exits non-zero if any API refuses the key or returns something ELESEND cannot use.
import {googleRouting, googlePlacesSearch, googleTileProxy} from '../services/api/modules/maps/google-maps.mjs';
import {roadModel} from './full-journey-simulation.mjs';

const apiKey = (process.env.GOOGLE_MAPS_API_KEY || '').trim();
if (apiKey.length < 20) {
  console.error('Set GOOGLE_MAPS_API_KEY to a key with Routes API, Places API (New) and Map Tiles API enabled.');
  process.exit(2);
}
const P = {
  accraMall: {latitude: 5.6221, longitude: -0.1735}, osu: {latitude: 5.5571, longitude: -0.1817},
  kasoa: {latitude: 5.5340, longitude: -0.4239}, makola: {latitude: 5.5480, longitude: -0.2087},
  adum: {latitude: 6.6930, longitude: -1.6244}, knust: {latitude: 6.6745, longitude: -1.5716}
};
const results = [];
async function step(name, fn) {
  try { const detail = await fn(); results.push({name, ok: true, detail}); console.log(`PASS  ${name}\n      ${detail}`); }
  catch (e) { results.push({name, ok: false, detail: e.message}); console.log(`FAIL  ${name}\n      ${e.status ?? ''} ${e.message}`); }
}
// Google's own error text says what to fix (API not enabled, key restricted, billing off). Show it.
const realFetch = globalThis.fetch;
let lastGoogleError = null;
const fetchImpl = async (url, init) => {
  const res = await realFetch(url, init);
  if (!res.ok) { const text = await res.clone().text(); try { const body = JSON.parse(text); lastGoogleError = (Array.isArray(body) ? body[0] : body).error?.message ?? text.slice(0, 200); } catch { lastGoogleError = text.slice(0, 200); } }
  return res;
};
const explain = fn => async () => { lastGoogleError = null; try { return await fn(); } catch (e) { throw Object.assign(Error(`${e.message}${lastGoogleError ? ` (Google says: ${lastGoogleError})` : ''}`), {status: e.status}); } };

const routing = googleRouting({apiKey, fetchImpl, limits: {routes: 10, matrixElements: 10}});
const twoWheel = googleRouting({apiKey, fetchImpl, twoWheeler: true, limits: {routes: 2, matrixElements: 0}});
const km = m => (m / 1000).toFixed(1) + ' km', min = s => Math.round(s / 60) + ' min';
const compare = (g, a, b, vehicle) => { const m = roadModel(a, b, {vehicle}); return `Google ${km(g.distanceMeters)}, ${min(g.durationSeconds)} | simulation model ${km(m.distanceMeters)}, ${min(m.durationSeconds)}`; };

await step('Route: Accra Mall to Osu, car, with turn-by-turn steps', explain(async () => {
  const r = await routing.route(P.accraMall, P.osu, {vehicle: 'car', steps: true, billing: true});
  return `${compare(r, P.accraMall, P.osu, 'car')}; ${r.steps.length} steps, first: "${r.steps[0].instruction}"`;
}));
await step('Route: Kasoa to Makola, motorbike priced on car roads (default)', explain(async () => {
  const r = await routing.route(P.kasoa, P.makola, {vehicle: 'motorcycle', billing: true});
  return compare(r, P.kasoa, P.makola, 'motorcycle');
}));
await step('Route: Kasoa to Makola, Google two-wheeler mode (GOOGLE_ROUTES_TWO_WHEELER=true)', explain(async () => {
  const r = await twoWheel.route(P.kasoa, P.makola, {vehicle: 'motorcycle', billing: true});
  return compare(r, P.kasoa, P.makola, 'motorcycle') + ' — if this works in Ghana, consider turning two-wheeler mode on';
}));
await step('Route: Adum to KNUST, Kumasi', explain(async () => {
  const r = await routing.route(P.adum, P.knust, {vehicle: 'motorcycle', billing: true});
  return compare(r, P.adum, P.knust, 'motorcycle');
}));
await step('Rider matching: 3 riders to an Accra Mall pickup', explain(async () => {
  const riders = [{latitude: 5.6300, longitude: -0.1700}, {latitude: 5.6100, longitude: -0.1900}, {latitude: 5.6400, longitude: -0.1500}];
  const rows = await routing.matrix(riders, P.accraMall, {vehicle: 'motorcycle'});
  if (rows.some(r => !r)) throw Error('a rider got no road time');
  return rows.map((r, i) => `rider ${i + 1}: ${km(r.distanceMeters)}, ${min(r.durationSeconds)}`).join('; ');
}));
const places = googlePlacesSearch({apiKey, fetchImpl, limit: 5});
for (const q of ['Accra Mall', 'Kasoa New Market', 'KNUST Kumasi']) {
  await step(`Place search: "${q}"`, explain(async () => {
    const rows = await places(q);
    // The adapter swallows errors so search never breaks; an empty answer for a famous place means a key problem.
    if (!rows.length) throw Error(`no results${lastGoogleError ? '' : ' (check that Places API (New) is enabled for this key)'}`);
    return rows.slice(0, 2).map(r => `${r.name} (${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)})`).join('; ');
  }));
}
const tiles = googleTileProxy({apiKey, fetchImpl, limit: 5});
await step('Map tiles: Accra at street level (zoom 15)', explain(async () => {
  const t = await tiles.tile(15, 16366, 15873);
  return `${t.contentType}, ${t.bytes.length} bytes, cache: ${t.cacheControl}`;
}));
await step('Map tiles: a tile outside Ghana is refused before Google is asked', async () => {
  try { await tiles.tile(12, 2047, 1362); } catch (e) { if (e.status === 404) return 'refused, no request sent'; throw e; }
  throw Error('a London tile was served');
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Google usage: ${JSON.stringify({...routing.usage(), ...tiles.usage()})}`);
process.exitCode = failed ? 1 : 0;
