import {GHANA_GAZETTEER, GHANA_BOUNDS} from './ghana-geocoder.mjs';
import {check} from '../../security.mjs';

const CACHE = new Map();

function tier(zoom) {
  if (zoom < 11) return {minPop: 90, limit: 12, cluster: true, cell: 0.25};
  if (zoom < 13) return {minPop: 80, limit: 20, cluster: true, cell: 0.06};
  if (zoom < 15) return {minPop: 72, limit: 16, cluster: false, cell: 0.015};
  return {minPop: 45, limit: 24, cluster: false, cell: 0.008};
}

/**
 * Landmarks inside the visible map. Coordinates are copied from gazetteer records.
 * Cluster pins reuse the most relevant member's coordinates; they are not averages.
 */
export function viewportMarkers({west, south, east, north, zoom}) {
  for (const value of [west, south, east, north, zoom]) check(Number.isFinite(value), 400, 'Viewport requires west, south, east, north and zoom');
  let w = west, e = east, s = south, n = north;
  if (w > e) [w, e] = [e, w];
  if (s > n) [s, n] = [n, s];
  check(e - w <= 12 && n - s <= 12, 400, 'Viewport is too large');
  check(e >= GHANA_BOUNDS.minLongitude && w <= GHANA_BOUNDS.maxLongitude && n >= GHANA_BOUNDS.minLatitude && s <= GHANA_BOUNDS.maxLatitude, 400, 'Viewport is outside Ghana');
  const z = Math.max(1, Math.min(18, zoom));
  const spec = tier(z);
  const key = [w.toFixed(3), s.toFixed(3), e.toFixed(3), n.toFixed(3), Math.round(z)].join(':');
  if (CACHE.has(key)) return CACHE.get(key);

  const chosen = [];
  const seenIds = new Set();
  const seenPoints = new Map();
  for (const place of GHANA_GAZETTEER) {
    const lat = place.latitude;
    const lon = place.longitude;
    if (lat < s || lat > n || lon < w || lon > e) continue;
    if ((place.popularity || 50) < spec.minPop) continue;
    if (place.id && seenIds.has(place.id)) continue;
    if (place.id) seenIds.add(place.id);
    const pointKey = `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
    const stacked = seenPoints.get(pointKey);
    if (stacked) {
      if (stacked.alsoHere.length < 6) stacked.alsoHere.push(place.name);
      continue;
    }
    const feature = {
      id: place.id || pointKey,
      kind: 'place',
      latitude: lat,
      longitude: lon,
      name: place.name,
      category: place.category || 'landmark',
      locality: place.locality || null,
      city: place.city || null,
      region: place.region || null,
      popularity: place.popularity || 50,
      count: 1,
      alsoHere: [],
      nameConflict: place._distantName === true,
      coordinateSource: 'gazetteer_record'
    };
    seenPoints.set(pointKey, feature);
    chosen.push(feature);
  }

  chosen.sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name));
  let features = chosen.slice(0, spec.limit);
  const truncated = chosen.length > features.length;

  if (spec.cluster) {
    const cells = new Map();
    for (const feature of features) {
      const cellKey = `${Math.floor(feature.latitude / spec.cell)}:${Math.floor(feature.longitude / spec.cell)}`;
      let cell = cells.get(cellKey);
      if (!cell) {
        cell = [];
        cells.set(cellKey, cell);
      }
      cell.push(feature);
    }
    features = [];
    for (const cell of cells.values()) {
      cell.sort((a, b) => b.popularity - a.popularity);
      const head = cell[0];
      if (cell.length === 1) {
        features.push(head);
        continue;
      }
      features.push({
        ...head,
        kind: 'cluster',
        count: cell.reduce((sum, item) => sum + 1 + item.alsoHere.length, 0),
        alsoHere: cell.slice(1).map(item => item.name).concat(head.alsoHere).slice(0, 8),
        coordinateSource: 'representative_member'
      });
    }
  }

  const result = {zoom: z, truncated, limit: spec.limit, features};
  if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, result);
  return result;
}
