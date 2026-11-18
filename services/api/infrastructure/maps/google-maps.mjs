// Optional Google Maps Platform adapters for launch: road routing (Routes API), place search fallback
// (Places API Text Search) and map tiles (Map Tiles API, proxied so the key never leaves the server).
// Off unless ROUTING_PROVIDER_PRIORITY=google. Self-hosted OSRM, Photon and tiles remain the default and can
// replace Google later with configuration only.
//
// Every billable call passes a per-process daily budget. Set matching hard quotas in Google Cloud Console too:
// the console quota is the real spending cap, and the budget here keeps one process from using all of it.
// Google results are not stored: the terms only allow keeping place IDs, so nothing here writes to the database.
import {check} from '../../security.mjs';
import {haversine} from '../../dispatch-geometry.mjs';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const TILES_URL = 'https://tile.googleapis.com/v1';
const GHANA = {minLatitude: 4.5, maxLatitude: 11.4, minLongitude: -3.4, maxLongitude: 1.4};
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TILE_BYTES = 512 * 1024;

const positiveInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const truthy = value => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());

/** Reads Google settings. Throws only when Google is selected and the key is missing. */
export function googleMapsConfig(env = process.env) {
  const enabled = (env.ROUTING_PROVIDER_PRIORITY ?? 'osrm').trim().toLowerCase() === 'google';
  const apiKey = (env.GOOGLE_MAPS_API_KEY || '').trim();
  if (enabled) check(apiKey.length >= 20, 500, 'ROUTING_PROVIDER_PRIORITY=google needs GOOGLE_MAPS_API_KEY');
  return {
    enabled,
    apiKey,
    trafficAware: truthy(env.GOOGLE_ROUTES_TRAFFIC_AWARE),
    twoWheeler: truthy(env.GOOGLE_ROUTES_TWO_WHEELER),
    placesEnabled: enabled && env.GOOGLE_PLACES_ENABLED !== 'false',
    tilesEnabled: enabled && env.GOOGLE_MAP_TILES_ENABLED !== 'false',
    limits: {
      routes: positiveInt(env.GOOGLE_MAPS_DAILY_ROUTE_LIMIT, 1000),
      matrixElements: positiveInt(env.GOOGLE_MAPS_DAILY_MATRIX_ELEMENT_LIMIT, 3000),
      places: positiveInt(env.GOOGLE_MAPS_DAILY_PLACES_LIMIT, 300),
      tiles: positiveInt(env.GOOGLE_MAPS_DAILY_TILE_LIMIT, 20000)
    }
  };
}

/** A daily request allowance that resets at midnight UTC. */
export function dailyBudget(limit, {name = 'Google Maps', now = () => Date.now()} = {}) {
  let day = '', used = 0;
  const today = () => new Date(now()).toISOString().slice(0, 10);
  return {
    take(n = 1) {
      const d = today();
      if (d !== day) { day = d; used = 0; }
      check(used + n <= limit, 503, `${name} daily limit reached; try again later`);
      used += n;
    },
    used() { return today() === day ? used : 0; },
    limit
  };
}

async function readJson(response, limit = MAX_RESPONSE_BYTES) {
  const text = await response.text();
  check(text.length <= limit, 503, 'Map service response too large');
  try { return JSON.parse(text); } catch { check(false, 503, 'Invalid map service response'); }
}

function point(p) {
  check(p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180, 400, 'Invalid coordinates');
  return {latitude: p.latitude, longitude: p.longitude};
}
const seconds = d => { const n = Number.parseFloat(String(d ?? '').replace(/s$/, '')); return Number.isFinite(n) ? n : NaN; };

const MANEUVERS = {
  DEPART: ['depart', null], STRAIGHT: ['continue', 'straight'], NAME_CHANGE: ['continue', 'straight'], MERGE: ['merge', null],
  TURN_LEFT: ['turn', 'left'], TURN_RIGHT: ['turn', 'right'], TURN_SLIGHT_LEFT: ['turn', 'slight left'], TURN_SLIGHT_RIGHT: ['turn', 'slight right'],
  TURN_SHARP_LEFT: ['turn', 'sharp left'], TURN_SHARP_RIGHT: ['turn', 'sharp right'], UTURN_LEFT: ['turn', 'uturn'], UTURN_RIGHT: ['turn', 'uturn'],
  RAMP_LEFT: ['on ramp', 'slight left'], RAMP_RIGHT: ['on ramp', 'slight right'], FORK_LEFT: ['fork', 'slight left'], FORK_RIGHT: ['fork', 'slight right'],
  ROUNDABOUT_LEFT: ['roundabout', 'left'], ROUNDABOUT_RIGHT: ['roundabout', 'right'], FERRY: ['ferry', null], FERRY_TRAIN: ['ferry', null]
};

/** Rider steps in the same shape as the OSRM adapter's navigationSteps. */
export function googleSteps(route, destination) {
  const raw = (route?.legs || []).flatMap(leg => leg.steps || []);
  const steps = raw.map(step => {
    const [type, modifier] = MANEUVERS[step.navigationInstruction?.maneuver] || ['continue', null];
    const at = step.startLocation?.latLng || {};
    return {
      type, modifier, name: null,
      instruction: String(step.navigationInstruction?.instructions || '').replace(/\s+/g, ' ').trim() || 'Continue',
      distanceMeters: Math.ceil(step.distanceMeters || 0),
      durationSeconds: Math.ceil(seconds(step.staticDuration) || 0),
      location: {latitude: at.latitude, longitude: at.longitude}
    };
  });
  steps.push({type: 'arrive', modifier: null, name: null, instruction: 'You have arrived', distanceMeters: 0, durationSeconds: 0, location: {latitude: destination.latitude, longitude: destination.longitude}});
  return steps;
}

/** Same interface as osrmRouting: route() and matrix(). No map matching, so road-speed learning stays off. */
export function googleRouting({apiKey, trafficAware = false, twoWheeler = false, limits = {}, timeoutMs = 5000, maxSnapMeters = 2500, billingSnapMeters = 500, minBilledRoadRatio = 0.75, fetchImpl = fetch, now} = {}) {
  check(typeof apiKey === 'string' && apiKey.length >= 20, 500, 'Google Maps API key required');
  const routeBudget = dailyBudget(limits.routes ?? 1000, {name: 'Google route', now});
  const matrixBudget = dailyBudget(limits.matrixElements ?? 3000, {name: 'Google route matrix', now});

  function travelMode(vehicle) {
    if (vehicle === 'bicycle') return 'BICYCLE';
    if (twoWheeler && (vehicle === 'motorcycle' || vehicle === 'tricycle')) return 'TWO_WHEELER';
    return 'DRIVE';
  }
  function preference(mode) {
    return mode === 'BICYCLE' ? {} : {routingPreference: trafficAware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE'};
  }
  async function post(url, body, fieldMask) {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: {'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask},
      body: JSON.stringify(body)
    });
    check(response.status !== 429, 429, 'Routing service rate limited');
    check(response.ok, 503, 'Routing service unavailable');
    return readJson(response);
  }
  const normalize = (distance, duration) => {
    check(Number.isFinite(distance) && distance >= 0 && distance <= 10000000 && Number.isFinite(duration) && duration >= 0 && duration <= 604800, 503, 'Invalid road estimate');
    return {distanceMeters: Math.ceil(distance), durationSeconds: Math.ceil(duration), source: 'routing-provider', trafficAware};
  };

  return {
    async route(from, to, {vehicle = 'car', steps = false, alternatives = false, billing = false, bearing = null} = {}) {
      const a = point(from), b = point(to), mode = travelMode(vehicle);
      routeBudget.take();
      const origin = {location: {latLng: a, ...(Number.isFinite(bearing) && bearing >= 0 && bearing < 360 ? {heading: Math.round(bearing) % 360} : {})}};
      const fields = ['routes.distanceMeters', 'routes.duration', 'routes.polyline.geoJsonLinestring'];
      if (steps) fields.push('routes.legs.steps.distanceMeters', 'routes.legs.steps.staticDuration', 'routes.legs.steps.navigationInstruction', 'routes.legs.steps.startLocation');
      const body = await post(ROUTES_URL, {
        origin, destination: {location: {latLng: b}}, travelMode: mode, ...preference(mode),
        computeAlternativeRoutes: Boolean(alternatives), polylineEncoding: 'GEO_JSON_LINESTRING', units: 'METRIC', regionCode: 'gh', languageCode: 'en-GB'
      }, fields.join(','));
      const best = body?.routes?.[0];
      check(best && Array.isArray(best.polyline?.geoJsonLinestring?.coordinates) && best.polyline.geoJsonLinestring.coordinates.length >= 2, 422, 'No connected road path');
      // Google does not report how far each pin is from the road, so measure it from the route's ends.
      const line = best.polyline.geoJsonLinestring.coordinates;
      const ends = [haversine(a, {longitude: line[0][0], latitude: line[0][1]}), haversine(b, {longitude: line.at(-1)[0], latitude: line.at(-1)[1]})];
      const limit = billing ? billingSnapMeters : maxSnapMeters;
      check(ends.every(m => m <= limit), 422, billing ? 'This pin is too far from a mapped road. Move it closer to the road.' : 'No connected road path');
      const straightLine = haversine(a, b);
      if (straightLine > 250) check(Number(best.distanceMeters) >= straightLine * (billing ? minBilledRoadRatio : 0.25), 422, billing ? 'This route looks too short for these pins. Check both pins.' : 'No connected road path');
      const shape = r => ({...normalize(Number(r.distanceMeters ?? 0), seconds(r.duration)), geometry: r.polyline?.geoJsonLinestring, ...(steps ? {steps: googleSteps(r, b)} : {})});
      const rest = alternatives ? body.routes.slice(1).filter(r => r.polyline?.geoJsonLinestring) : [];
      return {...shape(best), ...(rest.length ? {alternatives: rest.map(shape)} : {})};
    },
    async matrix(sources, destination, {vehicle = 'car'} = {}) {
      check(Array.isArray(sources) && sources.length > 0 && sources.length <= 30, 400, 'Invalid matrix');
      const target = point(destination), origins = sources.map(point), mode = travelMode(vehicle);
      matrixBudget.take(origins.length);
      const rows = await post(MATRIX_URL, {
        origins: origins.map(p => ({waypoint: {location: {latLng: p}}})),
        destinations: [{waypoint: {location: {latLng: target}}}],
        travelMode: mode, ...preference(mode), regionCode: 'gh'
      }, 'originIndex,destinationIndex,distanceMeters,duration,condition');
      check(Array.isArray(rows), 503, 'Route matrix response malformed');
      const out = sources.map(() => null);
      for (const row of rows) {
        const i = row?.originIndex ?? 0;
        if (!Number.isInteger(i) || i < 0 || i >= origins.length || row.condition !== 'ROUTE_EXISTS') continue;
        const m = Number(row.distanceMeters ?? 0), d = seconds(row.duration);
        if (!Number.isFinite(m) || !Number.isFinite(d)) continue;
        const straightLine = haversine(origins[i], target);
        if (straightLine > 250 && m < straightLine * 0.25) continue;
        out[i] = normalize(m, d);
      }
      return out;
    },
    usage: () => ({routes: routeBudget.used(), matrixElements: matrixBudget.used()}),
    capabilities: Object.freeze({roadNetwork: true, traffic: trafficAware, mapMatching: false, provider: 'google'})
  };
}

const inGhana = (lat, lon) => lat >= GHANA.minLatitude && lat <= GHANA.maxLatitude && lon >= GHANA.minLongitude && lon <= GHANA.maxLongitude;

/** Place search fallback: asked only when the built-in Ghana places do not answer the query. */
export function googlePlacesSearch({apiKey, limit = 300, timeoutMs = 2000, fetchImpl = fetch, now} = {}) {
  const budget = dailyBudget(limit, {name: 'Google place search', now});
  return async function search(query, {near = null} = {}) {
    const text = String(query || '').trim().slice(0, 150);
    if (text.length < 2) return [];
    try { budget.take(); } catch { return []; }
    try {
      const response = await fetchImpl(PLACES_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: {'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType'},
        body: JSON.stringify({
          textQuery: text, regionCode: 'GH', languageCode: 'en', pageSize: 5,
          ...(near && inGhana(near.latitude, near.longitude)
            ? {locationBias: {circle: {center: {latitude: near.latitude, longitude: near.longitude}, radius: 30000}}}
            : {locationRestriction: {rectangle: {low: {latitude: GHANA.minLatitude, longitude: GHANA.minLongitude}, high: {latitude: GHANA.maxLatitude, longitude: GHANA.maxLongitude}}}})
        })
      });
      if (!response?.ok) return [];
      const body = await readJson(response);
      return (body?.places || []).map(googlePlaceResult).filter(Boolean);
    } catch {
      return [];
    }
  };
}

export function googlePlaceResult(place) {
  const latitude = Number(place?.location?.latitude), longitude = Number(place?.location?.longitude);
  if (!inGhana(latitude, longitude)) return null;
  const name = String(place.displayName?.text || '').trim();
  if (!name) return null;
  const road = place.primaryType === 'route';
  return {
    name,
    label: road ? `Road · ${name}` : String(place.formattedAddress || name),
    type: road ? 'road' : 'place',
    category: place.primaryType || 'place',
    latitude, longitude,
    placeId: typeof place.id === 'string' ? place.id : null,
    source: 'Google',
    license: 'Google Maps Platform',
    attribution: 'Google Maps',
    coordinate_kind: road ? 'road_midpoint' : 'mapped_point'
  };
}

/** Web Mercator tile bounds, used to refuse paid tiles outside Ghana. */
export function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lon = v => v / n * 360 - 180;
  const lat = v => Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))) * 180 / Math.PI;
  return {west: lon(x), east: lon(x + 1), north: lat(y), south: lat(y + 1)};
}
export function tileTouchesGhana(z, x, y) {
  if (z < 6) return true;
  const b = tileBounds(z, x, y);
  return b.east >= GHANA.minLongitude - 0.5 && b.west <= GHANA.maxLongitude + 0.5 && b.north >= GHANA.minLatitude - 0.5 && b.south <= GHANA.maxLatitude + 0.5;
}

/**
 * Serves Google roadmap tiles through the API so the app never holds the key. Tiles outside Ghana are refused,
 * each phone address is rate limited, and the daily allowance caps the bill.
 */
export function googleTileProxy({apiKey, limit = 20000, perClientPerMinute = 300, timeoutMs = 5000, fetchImpl = fetch, now = () => Date.now()} = {}) {
  const budget = dailyBudget(limit, {name: 'Google map tile', now});
  let session = null, sessionRequest = null;
  const clients = new Map();

  async function createSession() {
    const response = await fetchImpl(`${TILES_URL}/createSession?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({mapType: 'roadmap', language: 'en-GB', region: 'GH', scale: 'scaleFactor2x', highDpi: true})
    });
    check(response.ok, 503, 'Map tiles unavailable');
    const body = await readJson(response, 65536);
    check(typeof body?.session === 'string' && body.session, 503, 'Map tiles unavailable');
    // Renew an hour before Google's expiry.
    const expiresAt = Number(body.expiry) * 1000 || now() + 86400000;
    return {token: body.session, renewAt: expiresAt - 3600000};
  }
  async function currentSession(force = false) {
    if (!force && session && now() < session.renewAt) return session.token;
    sessionRequest ??= createSession().then(s => { session = s; return s.token; }).finally(() => { sessionRequest = null; });
    return sessionRequest;
  }
  function admit(client) {
    const minute = Math.floor(now() / 60000);
    const entry = clients.get(client);
    if (!entry || entry.minute !== minute) {
      if (clients.size > 20000) clients.clear();
      clients.set(client, {minute, count: 1});
      return;
    }
    entry.count++;
    check(entry.count <= perClientPerMinute, 429, 'Too many map requests');
  }

  return {
    async tile(z, x, y, {client = 'unknown'} = {}) {
      check([z, x, y].every(Number.isInteger) && z >= 0 && z <= 20 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z, 404, 'Tile not found');
      check(tileTouchesGhana(z, x, y), 404, 'Map covers Ghana only');
      admit(client);
      budget.take();
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await currentSession(attempt > 0);
        const response = await fetchImpl(`${TILES_URL}/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(token)}&key=${encodeURIComponent(apiKey)}`, {redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
        if ((response.status === 400 || response.status === 401 || response.status === 403) && attempt === 0) continue;
        check(response.status !== 404, 404, 'Tile not found');
        check(response.ok, 503, 'Map tiles unavailable');
        const bytes = Buffer.from(await response.arrayBuffer());
        check(bytes.length <= MAX_TILE_BYTES, 503, 'Map tile too large');
        const type = response.headers.get('content-type') || 'image/png';
        check(/^image\/(png|jpeg|webp)$/.test(type.split(';')[0].trim()), 503, 'Unexpected map tile type');
        return {bytes, contentType: type, cacheControl: response.headers.get('cache-control') || 'public, max-age=86400'};
      }
      check(false, 503, 'Map tiles unavailable');
    },
    usage: () => ({tiles: budget.used()})
  };
}

/** Raster map style for the apps. Provider-neutral on the phone: it only sees a tile URL and attribution text. */
export function rasterMapStyle(tileUrl, {attribution = 'Map data © Google'} = {}) {
  return {
    version: 8,
    name: 'ELESEND Ghana',
    sources: {base: {type: 'raster', tiles: [tileUrl], tileSize: 256, minzoom: 0, maxzoom: 20, attribution}},
    layers: [{id: 'base', type: 'raster', source: 'base'}]
  };
}
