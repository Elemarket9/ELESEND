import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRestaurantBatch} from '../services/api/algorithms/restaurant-batch.mjs';

const now = '2026-11-17T12:00:00.000Z';
const restaurant = {latitude: 5.6, longitude: -0.2};
const rider = {latitude: 5.61, longitude: -0.21, maxCapacityG: 3000};
const meal = (id, extra = {}) => ({id, readyAt: now, weightG: 1000,
 destination: {latitude: 5.62 + Number(id) / 1000, longitude: -0.22}, ...extra});
function fixture({orders = [meal(1)], estimate = () => 60, options = {}, riderOverrides = {}} = {}) {
 let calls = 0;
 return {calls: () => calls, run: () => evaluateRestaurantBatch({restaurant, rider: {...rider, ...riderOverrides}, orders,
  options: {now, ...options}, routing: {route: async (from, to) => {
   calls++;
   return {source: 'fixture', distanceMeters: 100, durationSeconds: estimate(from, to)};
  }}})};
}

test('overweight batch recommends the largest capacity-safe subset', async () => {
 const result = await fixture({orders: [meal(1), meal(2), meal(3)], riderOverrides: {maxCapacityG: 2000}}).run();
 assert.equal(result.batchRequiresSplit, true);
 assert.equal(result.recommendedBatch.length, 2);
 assert.equal(result.splitOrders.length, 1);
 assert.ok(result.batchMetrics.every(m => m.withinMax));
});
test('an expired first meal does not hide the feasible remaining pair', async () => {
 const result = await fixture({orders: [meal(1, {readyAt: '2026-11-17T11:30:00Z'}), meal(2), meal(3)]}).run();
 assert.deepEqual(result.recommendedBatch.map(o => o.id).sort(), [2, 3]);
 assert.deepEqual(result.splitOrders.map(o => o.id), [1]);
});
test('searches non-prefix subsets when only a later meal fits capacity', async () => {
 const result = await fixture({orders: [meal(1, {weightG: 4000}), meal(2)]}).run();
 assert.deepEqual(result.recommendedBatch.map(o => o.id), [2]);
});
test('exactly 30 minutes is allowed, one second beyond is not', async () => {
 const options = {pickupServiceSeconds: 0, dropoffServiceSeconds: 0};
 assert.equal((await fixture({estimate: () => 900, options}).run()).feasible, true);
 assert.equal((await fixture({estimate: () => 900.5, options}).run()).feasible, false);
});
test('options cannot relax the food deadline beyond 30 minutes', async () => {
 await assert.rejects(fixture({options: {maxPlannedMinutes: 60}}).run(), {status: 400});
});
test('waiting for the last meal is included in elapsed duration', async () => {
 const result = await fixture({orders: [meal(1, {readyAt: '2026-11-17T12:10:00Z'})]}).run();
 assert.equal(result.totalDurationSeconds, 900);
 assert.equal(result.metrics[0].handoverTimestamp, '2026-11-17T12:15:00.000Z');
});
test('later readiness cannot reset an older meal deadline', async () => {
 const result = await fixture({orders: [meal(1, {readyAt: '2026-11-17T11:40:00Z'}), meal(2, {readyAt: '2026-11-17T12:10:00Z'})]}).run();
 assert.equal(result.feasible, false);
 assert.equal(result.recommendedBatch.length, 1);
});
test('missing and malformed ready times fail closed', async () => {
 for (const readyAt of [undefined, null, '', 'not-a-date']) {
  const result = await fixture({orders: [meal(1, {readyAt})]}).run();
  assert.equal(result.feasible, false);
  assert.equal(result.reason, 'invalid_order_ready_time');
 }
});
test('search is bounded before making any routing requests', async () => {
 const f = fixture({orders: Array.from({length: 6}, (_, i) => meal(i))});
 await assert.rejects(f.run(), {status: 400});
 assert.equal(f.calls(), 0);
});
test('directed road legs are cached across permutations and subsets', async () => {
 const f = fixture({orders: [meal(1), meal(2), meal(3), meal(4), meal(5)], riderOverrides: {maxCapacityG: 4000}});
 const result = await f.run();
 assert.equal(result.recommendedBatch.length, 4);
 assert.ok(f.calls() <= 26, `expected at most 26 directed legs, got ${f.calls()}`);
});
test('routing outages return an infeasible result', async () => {
 const result = await fixture({estimate: () => {throw Error('routing offline');}}).run();
 assert.equal(result.feasible, false);
 assert.equal(result.reason, 'unreachable_restaurant');
});
test('invalid service times, capacities, weights and duplicate IDs are rejected', async () => {
 for (const options of [{pickupServiceSeconds: -1}, {dropoffServiceSeconds: NaN}, {now: 'bad'}, {targetPlannedMinutes: 31}])
  await assert.rejects(fixture({options}).run(), {status: 400});
 await assert.rejects(fixture({riderOverrides: {currentLoadedG: -1}}).run(), {status: 400});
 await assert.rejects(fixture({orders: [meal(1, {weightG: -1})]}).run(), {status: 400});
 await assert.rejects(fixture({orders: [meal(1), meal(1)]}).run(), {status: 400});
});
test('directional routes choose the faster feasible stop order', async () => {
 const a = meal(1), b = meal(2);
 const result = await fixture({orders: [a, b], estimate: (from, to) =>
  from.latitude === a.destination.latitude && to.latitude === b.destination.latitude ? 600 : 60}).run();
 assert.deepEqual(result.acceptedOrders.map(o => o.id), [2, 1]);
});
test('unreachable destination still permits a reachable subset', async () => {
 const a = meal(1), b = meal(2);
 const result = await fixture({orders: [a, b], estimate: (_, to) => {
  if (to.latitude === a.destination.latitude) throw Error('no road');
  return 60;
 }}).run();
 assert.deepEqual(result.recommendedBatch.map(o => o.id), [2]);
});
