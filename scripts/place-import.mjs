// Shared rules for OpenStreetMap places, named roads and Overture places.
// Coordinates are copied from the source feature. Nothing here invents a point or a house number.
import {createReadStream} from 'node:fs';
import readline from 'node:readline';

export const GHANA_BOUNDS = {minLatitude: 4.5, maxLatitude: 11.4, minLongitude: -3.4, maxLongitude: 1.4};

// Delivery priority. Kasoa (about -0.42) falls in Central, east of -0.35 in Greater Accra.
export function priorityArea(latitude, longitude) {
  const lat = Number(latitude), lon = Number(longitude);
  if (lat >= 6.55 && lat <= 6.85 && lon >= -1.75 && lon <= -1.45) return 'kumasi';
  if (lat >= 5.45 && lat <= 5.90 && lon >= -0.55 && lon <= -0.35) return 'central';
  if (lat >= 5.00 && lat <= 5.70 && lon >= -1.55 && lon <= -0.35) return 'central';
  if (lat >= 5.45 && lat <= 5.90 && lon >= -0.55 && lon <= 0.25) return 'greater_accra';
  return 'other';
}

const AMENITY = {
  bank: 'bank', atm: null,
  hospital: 'health', clinic: 'health', doctors: 'health', pharmacy: 'health', dentist: 'health',
  veterinary: 'health', social_facility: 'health', nursing_home: 'health',
  school: 'education', college: 'education', university: 'education', kindergarten: 'education',
  childcare: 'education', driving_school: 'education', language_school: 'education', music_school: 'education',
  research_institute: 'education', library: 'education',
  restaurant: 'commerce', fast_food: 'commerce', cafe: 'commerce', bar: 'commerce', pub: 'commerce',
  ice_cream: 'commerce', food_court: 'commerce', biergarten: 'commerce',
  fuel: 'commerce', bus_station: 'transport', taxi: 'transport', ferry_terminal: 'transport',
  marketplace: 'market',
  police: 'public_service', post_office: 'logistics', courthouse: 'public_service', townhall: 'public_service',
  community_centre: 'landmark', place_of_worship: 'religion',
  cinema: 'leisure', theatre: 'leisure', arts_centre: 'leisure', events_venue: 'landmark',
  car_rental: 'commerce', car_wash: 'commerce', hotel: 'commerce'
};
const BUILDING = {
  commercial: 'commerce', retail: 'commerce', supermarket: 'commerce',
  hospital: 'health', school: 'education', university: 'education', college: 'education', kindergarten: 'education',
  hotel: 'commerce', church: 'religion', mosque: 'religion', chapel: 'religion',
  civic: 'public_service', public: 'public_service', train_station: 'transport', transportation: 'transport'
};
const TOURISM = {hotel: 'commerce', guest_house: 'commerce', motel: 'commerce', hostel: 'commerce', attraction: 'landmark', museum: 'landmark', gallery: 'landmark', apartment: 'commerce', camp_site: 'leisure', chalet: 'commerce'};
const LEISURE = {stadium: 'leisure', park: 'leisure', sports_centre: 'leisure', pitch: 'leisure', playground: 'leisure', fitness_centre: 'leisure', sports_hall: 'leisure', swimming_pool: 'leisure'};
const ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian', 'service']);

export function classifyOsmTags(tags = {}) {
  if (tags.disused === 'yes' || tags.disused === 'true') return {drop: 'disused'};
  if (tags.abandoned === 'yes' || tags.abandoned === 'true') return {drop: 'abandoned'};
  const name = String(tags.name || tags['name:en'] || '').trim();
  if (!name) return {drop: 'unnamed'};
  if (name.length < 3 || name.length > 120) return {drop: 'name_length'};
  if (tags.highway) {
    if (!ROAD_CLASSES.has(tags.highway)) return {drop: 'not_a_destination'};
    return {kind: 'road', category: 'road', subcategory: tags.highway, name};
  }
  const named = (key, map) => {
    const value = tags[key];
    if (!value || !(value in map)) return null;
    return map[value] ? {kind: 'place', category: map[value], subcategory: value, name} : {drop: 'not_a_destination'};
  };
  for (const [key, map] of [['shop', null], ['office', null], ['craft', null]]) {
    if (tags[key]) return {kind: 'place', category: 'commerce', subcategory: String(tags[key]), name};
  }
  for (const [key, map] of [['amenity', AMENITY], ['tourism', TOURISM], ['leisure', LEISURE], ['building', BUILDING]]) {
    const found = named(key, map);
    if (found) return found;
  }
  if (tags.healthcare) return {kind: 'place', category: 'health', subcategory: String(tags.healthcare), name};
  if (tags.aeroway === 'terminal' || tags.aeroway === 'aerodrome') return {kind: 'place', category: 'airport', subcategory: tags.aeroway, name};
  if (tags.public_transport === 'station' || tags.railway === 'station' || tags.railway === 'halt') return {kind: 'place', category: 'transport', subcategory: 'station', name};
  return {drop: 'not_a_destination'};
}

export function geometryCentre(geometry) {
  if (!geometry?.coordinates) return null;
  const points = [];
  (function walk(value) {
    if (typeof value?.[0] === 'number' && typeof value?.[1] === 'number') points.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
  })(geometry.coordinates);
  if (!points.length) return null;
  return {
    longitude: points.reduce((sum, point) => sum + point[0], 0) / points.length,
    latitude: points.reduce((sum, point) => sum + point[1], 0) / points.length
  };
}

export function inGhana(point) {
  return !!point && point.latitude >= GHANA_BOUNDS.minLatitude && point.latitude <= GHANA_BOUNDS.maxLatitude
    && point.longitude >= GHANA_BOUNDS.minLongitude && point.longitude <= GHANA_BOUNDS.maxLongitude;
}

export function metresBetween(a, b) {
  const lat = (Number(b.latitude) - Number(a.latitude)) * 111320;
  const lon = (Number(b.longitude) - Number(a.longitude)) * 111320 * Math.cos(Number(a.latitude) * Math.PI / 180);
  return Math.hypot(lat, lon);
}

const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cell = point => `${Math.floor(Number(point.latitude) * 100)}:${Math.floor(Number(point.longitude) * 100)}`;

export function placeGrid(places) {
  const grid = new Map();
  for (const place of places) {
    if (!Number.isFinite(Number(place.latitude)) || !Number.isFinite(Number(place.longitude))) continue;
    const key = cell(place);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(place);
  }
  return grid;
}

export function nearbyNamed(grid, point, name, metres = 150) {
  const key = norm(name);
  const lat = Math.floor(Number(point.latitude) * 100), lon = Math.floor(Number(point.longitude) * 100);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const place of grid.get(`${lat + i}:${lon + j}`) || []) {
      if (norm(place.name) === key && metresBetween(point, place) < metres) return true;
    }
  }
  return false;
}

export function placeFromFeature(feature, classified) {
  const at = geometryCentre(feature.geometry);
  if (!at) return {drop: 'no_geometry'};
  if (!inGhana(at)) return {drop: 'outside_ghana'};
  const tags = feature.properties || {};
  const place = {
    id: (classified.kind === 'road' ? 'ROAD_' : 'OSMIMP_') + String(feature.id ?? tags['@id'] ?? '').replace(/[^a-z0-9]/gi, ''),
    name: classified.name,
    category: classified.category,
    subcategory: classified.subcategory,
    latitude: Number(at.latitude.toFixed(6)),
    longitude: Number(at.longitude.toFixed(6)),
    area: priorityArea(at.latitude, at.longitude),
    coordinate_kind: classified.kind === 'road' ? 'road_midpoint' : feature.geometry?.type === 'Point' ? 'mapped_point' : 'mapped_area',
    aliases: [tags.brand, tags.alt_name, tags.short_name, tags.official_name].filter(alias => alias && alias !== classified.name),
    license: 'ODbL 1.0',
    source: 'OpenStreetMap',
    verification_status: 'unverified'
  };
  if (classified.kind === 'road') {
    place.label = `Road · ${classified.name}`;
  } else if (tags['addr:street']) {
    place.street = String(tags['addr:street']);
  }
  return {place};
}

// Overture release ids look like 2026-11-01.0. source_date is inserted as a PostgreSQL date, so only the calendar day is kept.
export function sourceDate(value) {
  if (value == null || value === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:\.\d+)?$/.exec(String(value).trim());
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function overturePlace(feature, {release, minConfidence = 0.5, grid} = {}) {
  const props = feature.properties || feature;
  const name = String(props.names?.primary || props.name || '').trim();
  if (!name || name.length < 3 || name.length > 120) return {drop: 'unnamed'};
  const confidence = Number(props.confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence) return {drop: 'low_confidence'};
  const at = geometryCentre(feature.geometry || {type: 'Point', coordinates: [props.longitude, props.latitude]});
  if (!at || !inGhana(at)) return {drop: 'outside_ghana'};
  const area = priorityArea(at.latitude, at.longitude);
  if (area === 'other') return {drop: 'outside_priority'};
  if (grid && nearbyNamed(grid, at, name)) return {drop: 'duplicate_curated'};
  const primary = String(props.categories?.primary || props.category || 'place');
  return {place: {
    id: 'OVERTURE_' + String(props.id || `${name}-${at.latitude.toFixed(4)}-${at.longitude.toFixed(4)}`).replace(/[^a-z0-9]/gi, '').slice(0, 96),
    name,
    category: overtureCategory(primary),
    subcategory: primary,
    latitude: Number(at.latitude.toFixed(6)),
    longitude: Number(at.longitude.toFixed(6)),
    area,
    coordinate_kind: 'mapped_point',
    confidence,
    license: 'CDLA-Permissive-2.0',
    source: 'Overture Maps',
    source_date: sourceDate(release),
    verification_status: 'unverified'
  }};
}

function overtureCategory(primary) {
  const value = primary.toLowerCase();
  if (/hospital|clinic|pharmacy|dentist|health/.test(value)) return 'health';
  if (/school|college|university|education/.test(value)) return 'education';
  if (/church|mosque|worship|religion/.test(value)) return 'religion';
  if (/restaurant|cafe|bar|food|bakery/.test(value)) return 'commerce';
  if (/bank|shop|store|market|mall|supermarket|fuel/.test(value)) return 'commerce';
  return 'landmark';
}

export const INSERT_LANDMARKS_SQL = `INSERT INTO spatial_landmarks (
  id, name, search_name, category, subcategory, region, locality, city, street,
  latitude, longitude, geom, coordinate_kind, source, source_id, source_date, license,
  verification_status, aliases, popularity, confidence
) SELECT id, name, search_name, category, subcategory, region, locality, city, street,
  latitude, longitude, ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
  coordinate_kind, source, source_id, source_date, license, verification_status, aliases, popularity, confidence
FROM json_to_recordset($1::json) AS x(
  id text, name text, search_name text, category text, subcategory text, region text, locality text, city text, street text,
  latitude float8, longitude float8, coordinate_kind text, source text, source_id text, source_date date, license text,
  verification_status text, aliases jsonb, popularity int, confidence float8
)
WHERE NOT EXISTS (
  SELECT 1 FROM spatial_landmarks existing
  WHERE existing.verification_status IS DISTINCT FROM 'unverified'
    AND lower(existing.name) = lower(x.name)
    AND ST_DWithin(existing.geom, ST_SetSRID(ST_MakePoint(x.longitude, x.latitude), 4326)::geography, 150)
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, search_name = EXCLUDED.search_name, category = EXCLUDED.category,
  subcategory = EXCLUDED.subcategory, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
  geom = EXCLUDED.geom, source_date = EXCLUDED.source_date, confidence = EXCLUDED.confidence, updated_at = now()
WHERE spatial_landmarks.verification_status = 'unverified' AND spatial_landmarks.source = EXCLUDED.source`;

export function emptyAreaCounts() {
  return {greater_accra: 0, kumasi: 0, central: 0, other: 0};
}

export async function readGeoJsonSeq(input, onFeature) {
  const droppedByReason = {};
  let read = 0;
  const drop = reason => { droppedByReason[reason] = (droppedByReason[reason] || 0) + 1; };
  for await (const raw of readline.createInterface({input: createReadStream(input)})) {
    const line = raw.replace(/^\x1e/, '');
    if (!line) continue;
    let feature;
    try { feature = JSON.parse(line); } catch { drop('invalid_json'); continue; }
    read++;
    onFeature(feature, drop);
  }
  return {read, droppedByReason};
}

export function landmarkRecord(place) {
  const region = place.region || (place.area === 'greater_accra' ? 'Greater Accra' : place.area === 'kumasi' ? 'Ashanti' : place.area === 'central' ? 'Central' : 'Ghana');
  return {
    id: place.id,
    name: place.name,
    search_name: [place.name, place.locality, place.city, place.region, ...(place.aliases || [])].filter(Boolean).join(' ').toLowerCase(),
    category: place.category,
    subcategory: place.subcategory || 'general',
    region,
    locality: place.locality || region,
    city: place.city || region,
    street: place.category === 'road' ? null : (place.street || null),
    latitude: place.latitude,
    longitude: place.longitude,
    coordinate_kind: place.coordinate_kind || 'mapped_point',
    source: place.source,
    source_id: place.id,
    source_date: sourceDate(place.source_date),
    license: place.license,
    verification_status: 'unverified',
    aliases: place.aliases || [],
    popularity: place.popularity || (place.category === 'road' ? 20 : 25),
    confidence: place.confidence ?? null
  };
}
