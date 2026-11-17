import {check} from '../security.mjs';
import {verifiedRoadEstimate} from './roads.mjs';

// Matches the restaurant queue's five-order planning window. Keep exhaustive
// search bounded; a larger queue must be planned in separate windows.
const MAX_BATCH_ORDERS = 5;
const FOOD_DEADLINE_MINUTES = 30;
const validPoint = p => p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 &&
 Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;

/** Plan a single-restaurant batch against each meal's own ready-to-handover clock.
 * Road estimates are cached only for this evaluation, including subset searches.
 * A split recommendation is advisory; it does not assign any rider or shipment.
 */
export async function evaluateRestaurantBatch({routing, restaurant, orders, rider, options = {}}) {
 check(validPoint(restaurant), 400, 'Invalid restaurant coordinates');
 check(Array.isArray(orders) && orders.length > 0 && orders.length <= MAX_BATCH_ORDERS, 400, 'Batch requires one to five orders');
 check(validPoint(rider), 400, 'Invalid rider coordinates');
 check(typeof routing?.route === 'function', 500, 'Authoritative routing engine required');
 const now = options.now == null ? Date.now() : new Date(options.now).getTime();
 const maxPlannedMinutes = options.maxPlannedMinutes ?? FOOD_DEADLINE_MINUTES;
 const targetPlannedMinutes = options.targetPlannedMinutes ?? Math.min(25, maxPlannedMinutes);
 const pickupServiceSeconds = options.pickupServiceSeconds ?? 120;
 const dropoffServiceSeconds = options.dropoffServiceSeconds ?? 120;
 const maxCapacityG = rider.maxCapacityG ?? 15000;
 const currentLoadedG = rider.currentLoadedG ?? 0;
 check(Number.isFinite(now), 400, 'Invalid planning time');
 check(Number.isFinite(maxPlannedMinutes) && maxPlannedMinutes > 0 && maxPlannedMinutes <= FOOD_DEADLINE_MINUTES, 400, 'Food deadline must not exceed 30 minutes');
 check(Number.isFinite(targetPlannedMinutes) && targetPlannedMinutes > 0 && targetPlannedMinutes <= maxPlannedMinutes, 400, 'Invalid target delivery time');
 check([pickupServiceSeconds, dropoffServiceSeconds, currentLoadedG].every(n => Number.isFinite(n) && n >= 0) && Number.isFinite(maxCapacityG) && maxCapacityG > 0, 400, 'Invalid service time or rider capacity');
 const reject = reason => ({feasible: false, reason, acceptedOrders: [], splitOrders: orders});
 if (!orders.every(o => validPoint(o?.destination))) return reject('invalid_order_destination');
 check(orders.every(o => o.id != null) && new Set(orders.map(o => o.id)).size === orders.length, 400, 'Unique order IDs required');
 // Never reset an unknown food-ready clock to the current time.
 if (!orders.every(o => o.readyAt != null && o.readyAt !== '' && Number.isFinite(new Date(o.readyAt).getTime()))) return reject('invalid_order_ready_time');
 check(orders.every(o => Number.isFinite(o.weightG ?? 1000) && (o.weightG ?? 1000) > 0), 400, 'Invalid order weight');
 const readyTimes = new Map(orders.map(o => [o.id, new Date(o.readyAt).getTime()]));
 const vehicle = rider.vehicle || 'motorcycle';
 const cache = new Map();
 async function road(from, to) {
  const key = JSON.stringify([from.latitude, from.longitude, to.latitude, to.longitude]);
  if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => routing.route(from, to, {vehicle}))
   .then(leg => verifiedRoadEstimate(leg) ? leg : null).catch(() => null));
  return cache.get(key);
 }
 const approach = await road(rider, restaurant);
 if (!approach) return reject('unreachable_restaurant');
 const arrival = now + approach.durationSeconds * 1000;
 function* permutations(items) {
  if (!items.length) { yield []; return; }
  for (let i = 0; i < items.length; i++) {
   for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...rest];
  }
 }
 async function bestFor(subset) {
  if (currentLoadedG + subset.reduce((sum, o) => sum + (o.weightG ?? 1000), 0) > maxCapacityG) return null;
  const departure = Math.max(arrival, ...subset.map(o => readyTimes.get(o.id))) + pickupServiceSeconds * 1000;
  let best = null;
  for (const sequence of permutations(subset)) {
   let location = restaurant, time = departure, distance = approach.distanceMeters;
   const metrics = [];
   for (const order of sequence) {
    const leg = await road(location, order.destination);
    if (!leg) break;
    time += (leg.durationSeconds + dropoffServiceSeconds) * 1000;
    const ready = readyTimes.get(order.id), minutes = (time - ready) / 60000;
    // Compare unrounded times: 30 minutes plus one second is already too late.
    if (minutes > maxPlannedMinutes) break;
    metrics.push({orderId: order.id, readyAt: new Date(ready).toISOString(),
     handoverTimestamp: new Date(time).toISOString(), minutesFromReady: Math.round(minutes * 10) / 10,
     withinTarget: minutes <= targetPlannedMinutes, withinMax: true,
     distanceMeters: leg.distanceMeters, durationSeconds: leg.durationSeconds});
    distance += leg.distanceMeters;
    location = order.destination;
   }
   if (metrics.length !== sequence.length) continue;
   const candidate = {sequence, metrics, totalDistanceMeters: distance,
    // Includes waiting for food, as well as approach, road legs and service.
    totalDurationSeconds: (time - now) / 1000, departureTimestamp: new Date(departure).toISOString(),
    allWithinTarget: metrics.every(m => m.withinTarget)};
   if (!best || candidate.totalDurationSeconds < best.totalDurationSeconds) best = candidate;
  }
  return best;
 }
 const full = await bestFor(orders);
 if (full) return {feasible: true, allWithinTarget: full.allWithinTarget, allWithinMax: true,
  exceedsTargetOnly: !full.allWithinTarget, acceptedOrders: full.sequence, splitOrders: [],
  metrics: full.metrics, totalDistanceMeters: full.totalDistanceMeters,
  totalDurationSeconds: full.totalDurationSeconds, departureTimestamp: full.departureTimestamp};

 // Search every subset at a given size before trying fewer orders. Prefix-only
 // search misses viable combinations when an old meal or heavy parcel comes first.
 for (let size = orders.length - 1; size >= 1; size--) {
  let best = null;
  for (let mask = 1; mask < (1 << orders.length); mask++) {
   const subset = orders.filter((_, i) => mask & (1 << i));
   if (subset.length !== size) continue;
   const candidate = await bestFor(subset);
   if (candidate && (!best || candidate.totalDurationSeconds < best.totalDurationSeconds)) best = candidate;
  }
  if (best) {
   const acceptedIds = new Set(best.sequence.map(o => o.id));
   return {feasible: false, batchRequiresSplit: true, recommendedBatch: best.sequence,
    splitOrders: orders.filter(o => !acceptedIds.has(o.id)), batchMetrics: best.metrics,
    reason: 'batch_deadline_or_capacity_requires_split', exceededOrderCount: orders.length - size};
  }
 }
 return {feasible: false, batchRequiresSplit: true, reason: 'no_feasible_batch_within_30_minutes',
  recommendedBatch: [], splitOrders: orders};
}
