// Pure navigation maths for the rider's turn-by-turn screen.
const R = 6371000, RAD = Math.PI / 180;
export const OFF_ROUTE_METERS = 60;

export function metersBetween(a, b) {
  const dLat = (b.latitude - a.latitude) * RAD, dLon = (b.longitude - a.longitude) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * RAD) * Math.cos(b.latitude * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const PROGRESS_BACK_METERS = 40, PROGRESS_AHEAD_METERS = 400;
/**
 * Closest point on the route: how far off it the rider is and how far along it they have come.
 * Given the last progress, it prefers the stretch the rider is on, so a road the route uses twice,
 * or a parallel stretch, cannot make progress jump. A large gap falls back to the closest point.
 */
export function locateOnRoute(position, points, { after = null } = {}) {
  if (!position || !Array.isArray(points) || points.length < 2) return null;
  const scale = Math.cos(position.latitude * RAD);
  let best = null, ahead = null, along = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i], b = points[i + 1], length = metersBetween(a, b);
    const ax = (b.longitude - a.longitude) * scale, ay = b.latitude - a.latitude;
    const px = (position.longitude - a.longitude) * scale, py = position.latitude - a.latitude;
    const span = ax * ax + ay * ay;
    const t = span > 0 ? Math.max(0, Math.min(1, (px * ax + py * ay) / span)) : 0;
    const off = metersBetween(position, { latitude: a.latitude + t * (b.latitude - a.latitude), longitude: a.longitude + t * (b.longitude - a.longitude) });
    const found = { offRouteMeters: off, traveledMeters: along + t * length, segment: i };
    if (!best || off < best.offRouteMeters) best = found;
    if (Number.isFinite(after) && found.traveledMeters >= after - PROGRESS_BACK_METERS && found.traveledMeters <= after + PROGRESS_AHEAD_METERS && (!ahead || off < ahead.offRouteMeters)) ahead = found;
    along += length;
  }
  const chosen = ahead && ahead.offRouteMeters <= Math.max(OFF_ROUTE_METERS, best.offRouteMeters + 20) ? ahead : best;
  return { ...chosen, routeMeters: along, remainingMeters: Math.max(0, along - chosen.traveledMeters) };
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

export const REROUTE_COOLDOWN_MS = 20000;
const OFF_ROUTE_FIXES = 2;
const WORST_USABLE_ACCURACY = 50;

/** Reroutes only on repeated, trustworthy fixes, so GPS jitter does not trigger it. */
export function rerouteCheck(state, { offRouteMeters, accuracy, now }) {
  const usable = !Number.isFinite(accuracy) || accuracy <= WORST_USABLE_ACCURACY;
  if (!usable) return { ...state, reroute: false };
  // A weak fix has to be further off before it counts, so GPS drift alone does not reroute.
  const limit = OFF_ROUTE_METERS + Math.max(0, (Number.isFinite(accuracy) ? accuracy : 0) - 20);
  const strikes = offRouteMeters > limit ? (state.strikes || 0) + 1 : 0;
  const reroute = strikes >= OFF_ROUTE_FIXES && now - (state.lastRerouteAt || 0) >= REROUTE_COOLDOWN_MS;
  return { strikes: reroute ? 0 : strikes, lastRerouteAt: reroute ? now : state.lastRerouteAt || 0, reroute };
}

export const ARRIVED_METERS = 30;
/** Arrived means at the end of the route, not merely level with it from another road. */
export function hasArrived(place) {
  return Boolean(place) && place.remainingMeters <= ARRIVED_METERS && place.offRouteMeters <= OFF_ROUTE_METERS;
}

const STALE_FIX_MS = 30000, IMPOSSIBLE_SPEED_MPS = 70, MOVING_MPS = 1.5;
/**
 * Turns a raw GPS fix into the position navigation uses, or null if it cannot be trusted:
 * unreadable, old, or further than a motorbike could travel. A compass heading is only kept
 * while moving, because a parked phone reports a meaningless one that would spin the map.
 */
export function usableFix(previous, fix, now = Date.now()) {
  const c = fix?.coords;
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return null;
  const at = Number.isFinite(fix.timestamp) ? fix.timestamp : now;
  if (now - at > STALE_FIX_MS) return null;
  const here = { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy, speed: c.speed, at };
  if (previous) {
    const elapsed = (at - previous.at) / 1000;
    if (elapsed <= 0) return null;
    const slack = (Number.isFinite(c.accuracy) ? c.accuracy : 0) + (Number.isFinite(previous.accuracy) ? previous.accuracy : 0);
    if (metersBetween(previous, here) - slack > IMPOSSIBLE_SPEED_MPS * elapsed) return null;
  }
  const moving = Number.isFinite(c.speed) && c.speed >= MOVING_MPS && Number.isFinite(c.heading) && c.heading >= 0;
  return { ...here, heading: moving ? c.heading : previous?.heading ?? null };
}

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

const VOICE_FAR_METERS = 300, VOICE_NEAR_METERS = 60, FAR_SECONDS = 20, NEAR_SECONDS = 6;
/**
 * What to say now, if anything. Each turn is announced once from afar and once when close.
 * Faster riders hear it earlier, so a warning always leaves time to act.
 */
export function voicePrompt(state, { index, metersToStep, step, speed }) {
  if (!step) return { state, say: null };
  // GPS noise near a turn can step progress back. A turn already passed is not announced again.
  if (Number.isFinite(state?.index) && index < state.index) return { state, say: null };
  const said = state?.index === index ? state.said : 0;
  const words = String(step.instruction || '').trim();
  if (!words) return { state: { index, said }, say: null };
  const mps = Number.isFinite(speed) && speed > 0 ? speed : 0;
  const near = Math.max(VOICE_NEAR_METERS, mps * NEAR_SECONDS), far = Math.max(VOICE_FAR_METERS, mps * FAR_SECONDS);
  if (metersToStep <= near && said < 2) return { state: { index, said: 2 }, say: words };
  if (metersToStep <= far && said < 1) {
    const say = step.type === 'arrive' ? `Your destination is in ${formatDistance(metersToStep)}` : `In ${formatDistance(metersToStep)}, ${words[0].toLowerCase()}${words.slice(1)}`;
    return { state: { index, said: 1 }, say };
  }
  return { state: { index, said }, say: null };
}
