// Pure navigation maths for the rider's turn-by-turn screen.
const R = 6371000, RAD = Math.PI / 180;

export function metersBetween(a, b) {
  const dLat = (b.latitude - a.latitude) * RAD, dLon = (b.longitude - a.longitude) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * RAD) * Math.cos(b.latitude * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Closest point on the route: how far off it the rider is and how far along it they have come. */
export function locateOnRoute(position, points) {
  if (!position || !Array.isArray(points) || points.length < 2) return null;
  const scale = Math.cos(position.latitude * RAD);
  let best = null, along = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i], b = points[i + 1], length = metersBetween(a, b);
    const ax = (b.longitude - a.longitude) * scale, ay = b.latitude - a.latitude;
    const px = (position.longitude - a.longitude) * scale, py = position.latitude - a.latitude;
    const span = ax * ax + ay * ay;
    const t = span > 0 ? Math.max(0, Math.min(1, (px * ax + py * ay) / span)) : 0;
    const off = metersBetween(position, { latitude: a.latitude + t * (b.latitude - a.latitude), longitude: a.longitude + t * (b.longitude - a.longitude) });
    if (!best || off < best.offRouteMeters) best = { offRouteMeters: off, traveledMeters: along + t * length, segment: i };
    along += length;
  }
  return { ...best, routeMeters: along, remainingMeters: Math.max(0, along - best.traveledMeters) };
}

/** The manoeuvre coming up, and how far away it is. */
export function upcomingStep(steps, traveledMeters) {
  if (!Array.isArray(steps) || !steps.length) return null;
  let start = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const end = start + steps[i].distanceMeters;
    if (traveledMeters < end) {
      const next = steps[i + 1] || steps[i];
      return { index: i, step: next, metersToStep: Math.max(0, end - traveledMeters), last: !steps[i + 1] };
    }
    start = end;
  }
  return { index: steps.length - 1, step: steps[steps.length - 1], metersToStep: 0, last: true };
}

export const OFF_ROUTE_METERS = 60;
export const REROUTE_COOLDOWN_MS = 20000;
const OFF_ROUTE_FIXES = 2;
const WORST_USABLE_ACCURACY = 50;

/** Reroutes only on repeated, trustworthy fixes, so GPS jitter does not trigger it. */
export function rerouteCheck(state, { offRouteMeters, accuracy, now }) {
  const usable = !Number.isFinite(accuracy) || accuracy <= WORST_USABLE_ACCURACY;
  if (!usable) return { ...state, reroute: false };
  const strikes = offRouteMeters > OFF_ROUTE_METERS ? (state.strikes || 0) + 1 : 0;
  const reroute = strikes >= OFF_ROUTE_FIXES && now - (state.lastRerouteAt || 0) >= REROUTE_COOLDOWN_MS;
  return { strikes: reroute ? 0 : strikes, lastRerouteAt: reroute ? now : state.lastRerouteAt || 0, reroute };
}

export const ARRIVED_METERS = 30;

export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

const ARROWS = { left: '←', 'slight left': '↖', 'sharp left': '↙', right: '→', 'slight right': '↗', 'sharp right': '↘', uturn: '↩', straight: '↑' };
export function stepArrow(step) {
  if (step?.type === 'arrive') return '🏁';
  if (step?.type === 'roundabout' || step?.type === 'rotary') return '⟳';
  return ARROWS[step?.modifier] || '↑';
}
