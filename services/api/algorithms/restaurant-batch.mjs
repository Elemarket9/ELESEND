import {check} from '../security.mjs';
import {verifiedRoadEstimate} from './roads.mjs';

/**
 * Evaluates multi-order restaurant food batching under the 30-minute delivery constraint.
 * ELESEND Food Policy:
 * - Preferred target: 20-25 minutes from kitchen food-ready time to customer handover.
 * - Strict maximum: 30 minutes from kitchen food-ready time to customer handover.
 * - Evaluates individual meal readiness timestamps (not fresh 30m reset at each dropoff).
 * - Splits batch if any order would exceed 30 minutes or rider capacity.
 */
export async function evaluateRestaurantBatch({
 routing,
 restaurant,
 orders,
 rider,
 options = {}
}) {
 check(restaurant && Number.isFinite(restaurant.latitude) && Number.isFinite(restaurant.longitude), 400, 'Invalid restaurant coordinates');
 check(Array.isArray(orders) && orders.length > 0, 400, 'No orders provided');
 check(rider && Number.isFinite(rider.latitude) && Number.isFinite(rider.longitude), 400, 'Invalid rider coordinates');
 check(typeof routing?.route === 'function', 500, 'Authoritative routing engine required');

 const now = options.now ? new Date(options.now).getTime() : Date.now();
 const maxPlannedMinutes = options.maxPlannedMinutes ?? 30;
 const targetPlannedMinutes = options.targetPlannedMinutes ?? 25;
 const vehicle = rider.vehicle || 'motorcycle';
 const maxCapacityG = rider.maxCapacityG ?? 15000;
 const currentLoadedG = rider.currentLoadedG ?? 0;
 const pickupServiceSeconds = options.pickupServiceSeconds ?? 120; // 2 min at restaurant
 const dropoffServiceSeconds = options.dropoffServiceSeconds ?? 120; // 2 min at customer door

 // 1. Calculate rider approach leg to restaurant
 const approachLeg = await routing.route(rider, restaurant, {vehicle});
 if (!verifiedRoadEstimate(approachLeg)) {
  return {feasible: false, reason: 'unreachable_restaurant', acceptedOrders: [], splitOrders: orders};
 }

 const riderArrivalAtRestaurant = now + approachLeg.durationSeconds * 1000;

 // 2. Sequence dropoffs: evaluate candidate order sequences (optimal permutation for small N <= 5)
 // Permutation generator for customer destinations
 function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const res = [];
  for (let i = 0; i < arr.length; i++) {
   const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
   for (const p of permutations(rest)) res.push([arr[i], ...p]);
  }
  return res;
 }

 const validOrders = orders.filter(o =>
  o && o.destination && Number.isFinite(o.destination.latitude) && Number.isFinite(o.destination.longitude)
 );
 if (validOrders.length !== orders.length) {
  return {feasible: false, reason: 'invalid_order_destination', acceptedOrders: [], splitOrders: orders};
 }

 // Find best sequence for all valid orders
 const candidateSequences = permutations(validOrders);
 let bestRoute = null;

 for (const seq of candidateSequences) {
  // Check weight capacity along this sequence
  let totalOrderWeight = 0;
  for (const o of seq) totalOrderWeight += (o.weightG || 1000);
  if (currentLoadedG + totalOrderWeight > maxCapacityG) continue;

  // Meal readiness: rider departs restaurant when rider has arrived AND all bundled food is ready, plus pickup service time
  let latestFoodReady = riderArrivalAtRestaurant;
  for (const o of seq) {
   const orderReadyTime = o.readyAt ? new Date(o.readyAt).getTime() : now;
   if (orderReadyTime > latestFoodReady) latestFoodReady = orderReadyTime;
  }
  const departureFromRestaurant = latestFoodReady + pickupServiceSeconds * 1000;

  // Walk legs
  let currentLoc = restaurant;
  let currentTime = departureFromRestaurant;
  let totalDist = approachLeg.distanceMeters;
  let totalDur = approachLeg.durationSeconds + pickupServiceSeconds;
  let sequenceFeasible = true;
  const metrics = [];
  const legs = [];

  for (const order of seq) {
   let leg;
   try {
    leg = await routing.route(currentLoc, order.destination, {vehicle});
   } catch {
    sequenceFeasible = false;
    break;
   }
   if (!verifiedRoadEstimate(leg)) {
    sequenceFeasible = false;
    break;
   }

   const handoverTime = currentTime + leg.durationSeconds * 1000 + dropoffServiceSeconds * 1000;
   const orderReadyTime = order.readyAt ? new Date(order.readyAt).getTime() : now;
   const minutesFromReady = (handoverTime - orderReadyTime) / 60000;

   metrics.push({
    orderId: order.id,
    readyAt: new Date(orderReadyTime).toISOString(),
    handoverTimestamp: new Date(handoverTime).toISOString(),
    minutesFromReady: Math.round(minutesFromReady * 10) / 10,
    withinTarget: minutesFromReady <= targetPlannedMinutes,
    withinMax: minutesFromReady <= maxPlannedMinutes,
    distanceMeters: leg.distanceMeters,
    durationSeconds: leg.durationSeconds
   });

   totalDist += leg.distanceMeters;
   totalDur += leg.durationSeconds + dropoffServiceSeconds;
   currentTime = handoverTime;
   currentLoc = order.destination;
   legs.push(leg);
  }

  if (!sequenceFeasible) continue;

  const allWithinMax = metrics.every(m => m.withinMax);
  const allWithinTarget = metrics.every(m => m.withinTarget);
  const maxMinutes = Math.max(...metrics.map(m => m.minutesFromReady));

  const candidate = {
   sequence: seq,
   metrics,
   totalDistanceMeters: totalDist,
   totalDurationSeconds: totalDur,
   departureTimestamp: new Date(departureFromRestaurant).toISOString(),
   allWithinMax,
   allWithinTarget,
   maxMinutes
  };

  if (!bestRoute || (allWithinMax && !bestRoute.allWithinMax) || (allWithinMax === bestRoute.allWithinMax && candidate.totalDurationSeconds < bestRoute.totalDurationSeconds)) {
   bestRoute = candidate;
  }
 }

 // If all orders can be served within 30 minutes:
 if (bestRoute && bestRoute.allWithinMax) {
  return {
   feasible: true,
   allWithinTarget: bestRoute.allWithinTarget,
   allWithinMax: true,
   exceedsTargetOnly: !bestRoute.allWithinTarget,
   acceptedOrders: bestRoute.sequence,
   splitOrders: [],
   metrics: bestRoute.metrics,
   totalDistanceMeters: bestRoute.totalDistanceMeters,
   totalDurationSeconds: bestRoute.totalDurationSeconds,
   departureTimestamp: bestRoute.departureTimestamp
  };
 }

 // If bestRoute exceeds 30 minutes for one or more orders, split orders!
 // Incrementally find the largest feasible subset (greedy prefix along best sequence)
 if (bestRoute) {
  const feasibleOrders = [];
  const splitOrders = [];
  
  // Re-evaluate prefix subsets
  for (let k = bestRoute.sequence.length - 1; k >= 1; k--) {
   const subOrders = bestRoute.sequence.slice(0, k);
   const subResult = await evaluateRestaurantBatch({
    routing,
    restaurant,
    orders: subOrders,
    rider,
    options: {...options, maxPlannedMinutes, targetPlannedMinutes}
   });
   if (subResult.feasible && subResult.allWithinMax) {
    const acceptedIds = new Set(subResult.acceptedOrders.map(o => o.id));
    return {
     feasible: false, // The 4-order batch as a whole cannot be delivered by 1 rider
     batchRequiresSplit: true,
     recommendedBatch: subResult.acceptedOrders,
     splitOrders: orders.filter(o => !acceptedIds.has(o.id)),
     batchMetrics: subResult.metrics,
     reason: '30_minute_deadline_exceeded_for_batch',
     exceededOrderCount: orders.length - subResult.acceptedOrders.length
    };
   }
  }
 }

 return {
  feasible: false,
  batchRequiresSplit: true,
  reason: 'no_feasible_batch_within_30_minutes',
  recommendedBatch: [],
  splitOrders: orders
 };
}
