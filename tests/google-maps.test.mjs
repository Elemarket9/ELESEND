import test from 'node:test';
import assert from 'node:assert/strict';
import {googleMapsConfig, googleRouting, googlePlacesSearch, googleTileProxy, dailyBudget, tileTouchesGhana, googleSteps} from '../services/api/infrastructure/maps/google-maps.mjs';
import {privateRoutingPriority} from '../services/api/infrastructure/maps/PrivateRoutingPolicy.mjs';
import {createRouting} from '../services/api/infrastructure/maps/routing-provider.mjs';
import {searchPlaces} from '../services/api/infrastructure/maps/ghana-geocoder.mjs';

const KEY = 'test-google-key-0123456789';
const accra = {latitude: 5.6037, longitude: -0.187};
const tema = {latitude: 5.6698, longitude: -0.0166};
const json = (body, status = 200, headers = {}) => ({ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => JSON.stringify(body), json: async () => body});

function fakeRoute({distanceMeters = 21000, duration = '1500s', line = [[accra.longitude, accra.latitude], [tema.longitude, tema.latitude]], steps} = {}) {
  return {routes: [{distanceMeters, duration, polyline: {geoJsonLinestring: {type: 'LineString', coordinates: line}}, ...(steps ? {legs: [{steps}]} : {})}]};
}

test('routing stays self-hosted unless Google is chosen, and Google needs a key', () => {
  assert.equal(privateRoutingPriority({}), 'osrm');
  assert.equal(privateRoutingPriority({ROUTING_PROVIDER_PRIORITY: 'google'}), 'google');
  assert.throws(() => privateRoutingPriority({ROUTING_PROVIDER_PRIORITY: 'mapbox'}));
  assert.equal(googleMapsConfig({GOOGLE_MAPS_API_KEY: KEY}).enabled, false);
  assert.throws(() => googleMapsConfig({ROUTING_PROVIDER_PRIORITY: 'google'}), /GOOGLE_MAPS_API_KEY/);
  // A leftover key does nothing while OSRM is selected.
  assert.equal(createRouting({routing: {}}, {GOOGLE_MAPS_API_KEY: KEY}), null);
  const google = createRouting({routing: {}}, {ROUTING_PROVIDER_PRIORITY: 'google', GOOGLE_MAPS_API_KEY: KEY});
  assert.equal(google.capabilities.provider, 'google');
  assert.equal(typeof google.matchTrace, 'undefined');
});

test('a Google route has the same shape as an OSRM route and keeps the key in a header', async () => {
  let sent;
  const routing = googleRouting({apiKey: KEY, fetchImpl: async (url, init) => { sent = {url: String(url), init}; return json(fakeRoute({steps: [
    {distanceMeters: 500, staticDuration: '60s', navigationInstruction: {maneuver: 'DEPART', instructions: 'Head east on Ring Rd'}, startLocation: {latLng: accra}},
    {distanceMeters: 20500, staticDuration: '1440s', navigationInstruction: {maneuver: 'TURN_LEFT', instructions: 'Turn left onto Tema Motorway'}, startLocation: {latLng: accra}}
  ]})); }});
  const r = await routing.route(accra, tema, {vehicle: 'motorcycle', steps: true, billing: true, bearing: 90});
  assert.equal(r.distanceMeters, 21000);
  assert.equal(r.durationSeconds, 1500);
  assert.equal(r.geometry.type, 'LineString');
  assert.equal(r.steps.at(-1).type, 'arrive');
  assert.equal(r.steps[1].modifier, 'left');
  assert.equal(sent.url.includes(KEY), false);
  assert.equal(sent.init.headers['X-Goog-Api-Key'], KEY);
  const body = JSON.parse(sent.init.body);
  assert.equal(body.travelMode, 'DRIVE');
  assert.equal(body.routingPreference, 'TRAFFIC_UNAWARE');
  assert.equal(body.origin.location.heading, 90);
});

test('Google fares refuse pins far from the road and routes that are too short', async () => {
  const farStart = [[accra.longitude + 0.02, accra.latitude], [tema.longitude, tema.latitude]];
  const far = googleRouting({apiKey: KEY, fetchImpl: async () => json(fakeRoute({line: farStart}))});
  await assert.rejects(far.route(accra, tema, {billing: true}), /too far from a mapped road/);
  const short = googleRouting({apiKey: KEY, fetchImpl: async () => json(fakeRoute({distanceMeters: 5000}))});
  await assert.rejects(short.route(accra, tema, {billing: true}), /too short/);
  const none = googleRouting({apiKey: KEY, fetchImpl: async () => json({})});
  await assert.rejects(none.route(accra, tema), /No connected road path/);
});

test('the daily cap stops paid calls', async () => {
  let calls = 0;
  const routing = googleRouting({apiKey: KEY, limits: {routes: 2}, fetchImpl: async () => { calls++; return json(fakeRoute()); }});
  await routing.route(accra, tema);
  await routing.route(accra, tema);
  await assert.rejects(routing.route(accra, tema), /daily limit/);
  assert.equal(calls, 2);
  let t = Date.parse('2026-11-18T23:59:00Z');
  const budget = dailyBudget(1, {now: () => t});
  budget.take();
  assert.throws(() => budget.take());
  t += 120000;
  budget.take();
});

test('the route matrix returns one estimate per rider and null where no road joins them', async () => {
  const routing = googleRouting({apiKey: KEY, fetchImpl: async () => json([
    {originIndex: 1, destinationIndex: 0, condition: 'ROUTE_NOT_FOUND'},
    {originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 21000, duration: '1500s'}
  ])});
  const rows = await routing.matrix([accra, {latitude: 5.7, longitude: -0.1}], tema);
  assert.equal(rows[0].distanceMeters, 21000);
  assert.equal(rows[1], null);
});

test('Google place search fills gaps only, stays in Ghana and never throws', async () => {
  const places = googlePlacesSearch({apiKey: KEY, fetchImpl: async () => json({places: [
    {id: 'abc', displayName: {text: 'Zebra Lodge Kasoa'}, formattedAddress: 'Kasoa, Ghana', location: {latitude: 5.53, longitude: -0.42}, primaryType: 'lodging'},
    {id: 'far', displayName: {text: 'Lagos place'}, location: {latitude: 6.5, longitude: 3.4}}
  ]})});
  const rows = await places('Zebra Lodge Kasoa');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'Google');
  const failing = googlePlacesSearch({apiKey: KEY, fetchImpl: async () => { throw Error('down'); }});
  assert.deepEqual(await failing('anything'), []);
  // A query the built-in places already answer does not cost a Google call.
  let asked = 0;
  await searchPlaces(null, 'Kotoka International Airport', {placesSearch: async () => { asked++; return []; }});
  assert.equal(asked, 0);
  const merged = await searchPlaces(null, 'Zebra Lodge Kasoa qwxz', {placesSearch: async () => rows});
  assert.ok(merged.some(r => r.source === 'Google'));
});

test('map tiles are proxied with the key on the server, Ghana only, with a session that renews', async () => {
  let sessions = 0, tiles = 0;
  const fetchImpl = async url => {
    url = String(url);
    if (url.includes('createSession')) { sessions++; return json({session: 's' + sessions, expiry: String(Math.floor(Date.now() / 1000) + 86400 * 10)}); }
    tiles++;
    if (url.includes('session=s1') && tiles === 2) return json({}, 401);
    return {ok: true, status: 200, headers: new Headers({'content-type': 'image/png', 'cache-control': 'max-age=3600'}), arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer};
  };
  const proxy = googleTileProxy({apiKey: KEY, fetchImpl});
  // Zoom 12 tile over Accra.
  const t = await proxy.tile(12, 2045, 1983);
  assert.equal(t.contentType, 'image/png');
  assert.equal(t.bytes.length, 4);
  await proxy.tile(12, 2045, 1983);
  assert.equal(sessions, 2);
  // Zoom 12 tile over London is refused before any paid call.
  assert.equal(tileTouchesGhana(12, 2047, 1362), false);
  await assert.rejects(proxy.tile(12, 2047, 1362), /Ghana only/);
  const limited = googleTileProxy({apiKey: KEY, fetchImpl, perClientPerMinute: 1});
  await limited.tile(12, 2045, 1983, {client: 'a'});
  await assert.rejects(limited.tile(12, 2045, 1983, {client: 'a'}), /Too many/);
});

test('steps from Google always end with an arrival', () => {
  const steps = googleSteps({legs: []}, tema);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].instruction, 'You have arrived');
});

test('the API serves proxied tiles and tells the app to use a raster map without offline packs', async () => {
  const {httpServer} = await import('../services/api/http.mjs');
  const query = async sql => sql.includes('rate_limits') ? {rowCount: 1, rows: [{count: 1}]} : {rowCount: 0, rows: []};
  const db = {query, tx: fn => fn({query})};
  const asked = [];
  const tileProxy = {tile: async (z, x, y) => { asked.push([z, x, y]); return {bytes: Buffer.from([1, 2, 3]), contentType: 'image/png', cacheControl: 'public, max-age=3600'}; }};
  const before = process.env.API_PUBLIC_ORIGIN;
  process.env.API_PUBLIC_ORIGIN = 'https://api.example.test';
  const server = httpServer(db, {authenticate: async () => { throw Object.assign(Error('no'), {status: 401}); }}, null, null, null, {restaurant: {}, restaurantOrders: {}, maps: {tileProxy, routingName: 'google'}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const config = await (await fetch(`${base}/api/v1/maps/config`)).json();
    assert.equal(config.renderer, 'raster');
    assert.equal(config.routing, 'google');
    assert.equal(config.offlineMaps, false);
    assert.equal(config.tileUrl, 'https://api.example.test/api/v1/maps/raster/{z}/{x}/{y}.png');
    const style = await (await fetch(`${base}/api/v1/maps/style.json`)).json();
    assert.equal(style.sources.base.type, 'raster');
    const tile = await fetch(`${base}/api/v1/maps/raster/12/2045/1984.png`);
    assert.equal(tile.status, 200);
    assert.equal(tile.headers.get('content-type'), 'image/png');
    assert.equal(tile.headers.get('cache-control'), 'public, max-age=3600');
    assert.deepEqual([...new Uint8Array(await tile.arrayBuffer())], [1, 2, 3]);
    assert.deepEqual(asked, [[12, 2045, 1984]]);
    assert.equal((await fetch(`${base}/api/v1/maps/raster/12/2045/../x.png`)).status, 404);
  } finally {
    if (before === undefined) delete process.env.API_PUBLIC_ORIGIN; else process.env.API_PUBLIC_ORIGIN = before;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
