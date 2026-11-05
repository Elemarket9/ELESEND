import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustedSeconds, segmentSpeeds, trafficRouting, trafficService } from '../services/api/traffic.mjs';
import { riderRoadsOsm } from '../scripts/export-rider-roads.mjs';

const at = s => new Date(1800000000000 + s * 1000).toISOString();
const points = [0, 30, 60].map(s => ({ observedAt: at(s) }));
const tracepoints = [0, 1, 2].map(i => ({ matchings_index: 0, waypoint_index: i }));

test('a matched trip gives a speed for each road segment', () => {
  const match = { tracepoints, matchings: [{ confidence: 0.9, legs: [{ distance: 300, annotation: { nodes: [1, 2, 3] } }, { distance: 150, annotation: { nodes: [3, 4] } }] }] };
  const rows = segmentSpeeds(match, points);
  assert.deepEqual(rows.map(r => [r.fromNode, r.toNode, Math.round(r.speedKmh)]), [[1, 2, 36], [2, 3, 36], [3, 4, 18]]);
  assert.equal(rows.some(r => 'riderId' in r || 'rider_id' in r), false);
});

test('stops, impossible speeds and weak matches are ignored', () => {
  const legs = distance => [{ distance, annotation: { nodes: [1, 2] } }, { distance, annotation: { nodes: [2, 3] } }];
  assert.equal(segmentSpeeds({ tracepoints, matchings: [{ confidence: 0.9, legs: legs(5) }] }, points).length, 0, 'parked');
  assert.equal(segmentSpeeds({ tracepoints, matchings: [{ confidence: 0.9, legs: legs(3000) }] }, points).length, 0, 'too fast');
  assert.equal(segmentSpeeds({ tracepoints, matchings: [{ confidence: 0.1, legs: legs(300) }] }, points).length, 0, 'weak match');
  assert.deepEqual(segmentSpeeds(null, points), []);
});

const leg = (name, durationSeconds, nodes) => ({ name, source: 'routing-provider', distanceMeters: 1000, durationSeconds, segments: { nodes, distances: nodes.slice(1).map(() => 500), durations: nodes.slice(1).map(() => durationSeconds / 2) } });
const a = { latitude: 5.6, longitude: -0.2 }, b = { latitude: 5.61, longitude: -0.2 };

test('measured speeds replace graph time only where measured', () => {
  const route = leg('x', 100, [1, 2, 3]);
  assert.equal(adjustedSeconds(route, new Map()).durationSeconds, 100);
  const slow = adjustedSeconds(route, new Map([['1:2', 9]]));
  assert.equal(slow.durationSeconds, 250);
  assert.equal(slow.measuredMeters, 500);
});

test('traffic picks the alternative that is really faster, and hides internals', async () => {
  const routing = { route: async () => ({ ...leg('main', 100, [1, 2, 3]), alternatives: [leg('side', 140, [1, 5, 3])] }) };
  const traffic = { speedsFor: async (_v, nodes) => new Map(nodes.includes(2) ? [['1:2', 5], ['2:3', 5]] : []) };
  const best = await trafficRouting(routing, traffic).route(a, b, { vehicle: 'motorcycle', traffic: true });
  assert.equal(best.name, 'side');
  assert.equal(best.durationSeconds, 140);
  assert.equal(best.trafficAware, false);
  assert.equal(best.segments, undefined);
  assert.equal(best.alternatives, undefined);
});

test('with no data or a failure, routing behaves as before', async () => {
  const calls = [];
  const routing = { route: async (_a, _b, opts) => { calls.push(opts); if (opts.annotations) throw Error('too big'); return leg('plain', 100, []); } };
  const best = await trafficRouting(routing, { speedsFor: async () => new Map() }).route(a, b, { vehicle: 'car', traffic: true });
  assert.equal(best.name, 'plain');
  assert.deepEqual(calls.at(-1), { vehicle: 'car' });
  assert.equal(trafficRouting(null, {}), null);
  const far = await trafficRouting(routing, { speedsFor: async () => new Map() }).route(a, { latitude: 9.4, longitude: -0.8 }, { vehicle: 'car', traffic: true });
  assert.equal(far.name, 'plain');
});

test('rider roads join the network, and a road touching nothing is left out', async () => {
  const roads = [{ name: 'Rider <Lane>', allowedVehicles: ['motorcycle'], coordinates: [[-0.18, 5.56], [-0.181, 5.561], [-0.182, 5.562]] }, { coordinates: [[-1, 7], [-1.001, 7.001]] }];
  const { osm, count } = await riderRoadsOsm(roads, async p => (p.longitude === -0.18 ? { meters: 8, node: 42 } : { meters: 500, node: 7 }));
  assert.equal(count, 1);
  assert.match(osm, /<nd ref="42"\/>/);
  assert.doesNotMatch(osm, /ref="7"/);
  assert.match(osm, /Rider &lt;Lane&gt;/);
  assert.match(osm, /k="motorcar" v="no"/);
});

function fakeDb(start) {
  const state = { cursor: start, inserts: 0 };
  return { state, query: async (sql, args) => {
    if (sql.startsWith('SELECT processed_until')) return { rows: state.cursor ? [{ processed_until: state.cursor }] : [] };
    if (sql.startsWith('INSERT INTO traffic_cursor')) state.cursor = args[0];
    if (sql.includes('INSERT INTO traffic_observations')) state.inserts += 1;
    return { rows: [] };
  } };
}
const NOW = 1800000000000;
const trip = { vehicle: 'motorcycle', points: [0, 30, 60].map(s => ({ latitude: 5.6, longitude: -0.2, accuracyMeters: 10, observedAt: at(s) })) };
const goodMatch = async () => ({ tracepoints, matchings: [{ confidence: 0.9, legs: [{ distance: 300, annotation: { nodes: [1, 2] } }, { distance: 300, annotation: { nodes: [2, 3] } }] }] });

test('a routing outage does not lose recent trips, and they are read later', async () => {
  const db = fakeDb(new Date(NOW - 180000));
  const reads = async (_s, until) => ({ traces: [trip], until });
  await trafficService(db, { routing: { matchTrace: async () => { throw Error('down'); } }, now: () => NOW }).ingest(reads);
  assert.equal(db.state.cursor.getTime(), NOW - 180000, 'cursor kept');
  const result = await trafficService(db, { routing: { matchTrace: goodMatch }, now: () => NOW }).ingest(reads);
  assert.equal(result.segments, 2);
  assert.equal(db.state.cursor.getTime(), NOW - 60000);
});

test('a batch cut short carries on from its last row, and old failures stop blocking', async () => {
  const db = fakeDb(new Date(NOW - 600000));
  const seen = [];
  await trafficService(db, { routing: { matchTrace: goodMatch }, now: () => NOW }).ingest(async (since, until) => {
    seen.push(since.getTime());
    return { traces: [], until: seen.length === 1 ? new Date(since.getTime() + 1000) : until };
  });
  assert.equal(seen[1], NOW - 600000 + 1000);
  const stale = fakeDb(new Date(NOW - 3600000));
  await trafficService(stale, { routing: { matchTrace: async () => { throw Error('no match'); } }, now: () => NOW }).ingest(async (_s, until) => ({ traces: [trip], until }));
  assert.ok(stale.state.cursor.getTime() > NOW - 3600000);
});

const url = process.env.TEST_DATABASE_URL;
test('trips become road speeds without rider ids, on a real database', { skip: !url }, async () => {
  assert.match(new URL(url).pathname, /^\/elesend_test/);
  const { randomUUID, randomInt } = await import('node:crypto');
  const { database } = await import('../services/api/db.mjs');
  const { migrate } = await import('../scripts/migrate.mjs');
  const { dispatchEngine } = await import('../services/api/dispatch.mjs');
  const db = database(url);
  try {
    await migrate(db);
    await db.query('DELETE FROM traffic_cursor');
    await db.query('DELETE FROM traffic_observations');
    const rider = randomUUID();
    await db.query("INSERT INTO users(id,phone,password_hash,kind,phone_verified_at) VALUES($1,$2,'test-only','rider',now())", [rider, `+2332${randomInt(10000000, 99999999)}`]);
    await db.query("INSERT INTO riders(id,status,vehicle,max_weight_g) VALUES($1,'approved','motorcycle',20000)", [rider]);
    const base = Date.now() - 200000;
    for (const s of [0, 30, 60]) await db.query('INSERT INTO rider_location_samples(rider_id,position,observed_at,accuracy_m) VALUES($1,ST_SetSRID(ST_MakePoint(-0.2,5.6),4326)::geography,$2,10)', [rider, new Date(base + s * 1000)]);
    await db.query('INSERT INTO traffic_cursor(id,processed_until) VALUES(1,$1)', [new Date(base - 1000)]);
    const n = randomInt(1000000, 9000000);
    const matchTrace = async () => ({ tracepoints, matchings: [{ confidence: 0.9, legs: [{ distance: 90, annotation: { nodes: [n, n + 1] } }, { distance: 90, annotation: { nodes: [n + 1, n + 2] } }] }] });
    const service = trafficService(db, { routing: { matchTrace } });
    const engine = dispatchEngine(db, { routing: { matchTrace, route: async () => null, matrix: async () => [] } });
    const first = await service.ingest(engine.recentRiderTraces);
    assert.ok(first.segments >= 2);
    assert.equal((await service.ingest(engine.recentRiderTraces)).segments, 0, 'each trip is read once');
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('traffic_observations','traffic_typical_speeds')")).rows.map(r => r.column_name);
    assert.equal(columns.some(c => c.includes('rider')), false, 'no rider stored');
    // Three sightings make a live speed; fewer do not.
    assert.equal((await service.speedsFor('motorcycle', [n, n + 1])).size, 0);
    for (let i = 0; i < 2; i += 1) await db.query('INSERT INTO traffic_observations(vehicle,from_node,to_node,speed_kmh,observed_at) VALUES($1,$2,$3,$4,now())', ['motorcycle', n, n + 1, 11]);
    const live = await service.speedsFor('motorcycle', [n, n + 1]);
    assert.ok(Math.abs(live.get(`${n}:${n + 1}`) - 11) < 0.5);
    assert.equal((await service.speedsFor('car', [n, n + 1])).size, 0, 'other vehicles are unaffected');
  } finally {
    await db.query('DELETE FROM traffic_cursor').catch(() => {});
    await db.close();
  }
});
