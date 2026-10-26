import {randomUUID} from 'node:crypto';
import {ABBREVIATIONS, GHANA_BOUNDS, GHANA_GAZETTEER, ghanaSearch} from './ghana-geocoder.mjs';
import {check} from '../../security.mjs';

const FIELD_KEYS = ['region', 'city', 'community', 'street', 'house', 'landmark', 'instructions'];
const BROAD_PLACES = new Set([
  'accra', 'kumasi', 'tema', 'takoradi', 'tamale', 'ghana', 'greater accra', 'ashanti',
  'central', 'eastern', 'western', 'northern', 'volta', 'bono', 'ahafo', 'oti',
  'savannah', 'upper east', 'upper west', 'western north', 'bono east', 'north east'
]);
const COMMUNITY_CATEGORIES = new Set(['neighborhood', 'town', 'suburb', 'locality', 'city', 'village']);

export function normalizeAddressText(value) {
  const base = String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return '';
  return base.split(' ').map(word => ABBREVIATIONS[word] || word).join(' ').replace(/\s+/g, ' ').trim();
}

export function readManualFields(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fields = {};
  for (const key of FIELD_KEYS) {
    const value = String(source[key] ?? '').replace(/\s+/g, ' ').trim();
    check(value.length <= 160, 400, 'Address field is too long');
    fields[key] = value;
  }
  return fields;
}

export function composeManualAddress(fields) {
  const parts = [fields.house, fields.street, fields.community, fields.city, fields.region].filter(Boolean);
  let text = parts.join(', ');
  if (fields.landmark) text += text ? ` — near ${fields.landmark}` : `Near ${fields.landmark}`;
  if (fields.instructions) text += text ? `. ${fields.instructions}` : fields.instructions;
  return text.trim();
}

export function assessManualAddress(fields) {
  const landmark = fields.landmark || '';
  const community = fields.community || '';
  const city = fields.city || '';
  const street = fields.street || '';
  const house = fields.house || '';
  const instructions = fields.instructions || '';
  if (landmark.length >= 3) return {ok: true};
  if (community.length >= 3) return {ok: true};
  if (city && (street.length >= 2 || house.length >= 1 || instructions.length >= 8)) return {ok: true};
  return {
    ok: false,
    reason: 'Add a community, landmark, or a street within a city. A region or city on its own is not enough to identify a pickup or delivery point.'
  };
}

let communityIndex = null;
let communityKeys = null;
function communities() {
  if (communityIndex) return communityIndex;
  communityIndex = new Map();
  for (const place of GHANA_GAZETTEER) {
    if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
    const category = String(place.category || '').toLowerCase();
    const keys = [];
    if (COMMUNITY_CATEGORIES.has(category)) keys.push(place.name, place.locality);
    const nameKey = normalizeAddressText(place.name);
    const localityKey = normalizeAddressText(place.locality);
    if (nameKey && localityKey && nameKey === localityKey) keys.push(place.name);
    for (const key of keys) {
      const norm = normalizeAddressText(key);
      if (norm.length < 4 || BROAD_PLACES.has(norm)) continue;
      const prev = communityIndex.get(norm);
      if (!prev || (place.popularity || 0) > (prev.popularity || 0)) communityIndex.set(norm, place);
    }
  }
  return communityIndex;
}
function sortedCommunityKeys() {
  if (!communityKeys) communityKeys = [...communities().keys()].sort((a, b) => b.length - a.length);
  return communityKeys;
}

export function detectCommunities(text) {
  const normalized = normalizeAddressText(text);
  if (!normalized) return [];
  const padded = ` ${normalized} `;
  const found = [];
  const keys = sortedCommunityKeys();
  for (const key of keys) {
    if (!padded.includes(` ${key} `)) continue;
    if (found.some(item => item.key.includes(key) || key.includes(item.key))) continue;
    const place = communities().get(key);
    found.push({
      key,
      id: place.id || null,
      name: place.name,
      locality: place.locality || null,
      city: place.city || null,
      region: place.region || null,
      latitude: place.latitude,
      longitude: place.longitude,
      category: place.category || 'locality'
    });
    if (found.length >= 4) break;
  }
  return found;
}

function mentionsPlace(text, place) {
  const normalized = normalizeAddressText(text);
  return [place.locality, place.city, place.name].some(part => {
    const key = normalizeAddressText(part);
    return key.length >= 4 && !BROAD_PLACES.has(key) && normalized.includes(key);
  });
}

function suggestionFrom(place, positionKind, confidence, resolution, uncertainty) {
  return {
    id: place.id || null,
    name: place.name,
    label: place.label || [place.locality, place.city].filter(Boolean).join(', '),
    locality: place.locality || null,
    city: place.city || null,
    region: place.region || null,
    latitude: place.latitude,
    longitude: place.longitude,
    positionKind,
    confidence,
    resolution,
    uncertainty,
    coordinateSource: 'gazetteer_record'
  };
}

function chooseSuggestion(fields, candidates, detected) {
  const text = composeManualAddress(fields);
  const usable = candidates.filter(item => item.type !== 'coordinate' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude) && !item.needsConfirmation);
  const top = usable[0];
  const second = usable[1];
  const gap = top && second ? top.score - second.score : 999;
  const ambiguous = Boolean(top?.ambiguous && second && gap < 120);
  if (top && !ambiguous && top.score >= 240) {
    const blocked = top.nameConflict && !mentionsPlace(text, top);
    if (!blocked && top.score >= 560 && gap >= 70) {
      return suggestionFrom(top, 'verified_record', 'high', 'matched_record', 'Matched an existing EGIE place record.');
    }
    if (!blocked && top.score >= 300) {
      return suggestionFrom(top, 'approximate', 'medium', 'approximate', `Approximate: this is the recorded point for ${top.name}, not a measured doorstep. You can move the pin.`);
    }
  }
  const community = detected.find(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
  if (community && !ambiguous && (fields.community || fields.landmark || fields.street || fields.house)) {
    return suggestionFrom(community, 'approximate', 'low', 'approximate', `No doorstep record. The pin is the known point for ${community.name}. Move it if this is not the right entrance.`);
  }
  return null;
}

function conflictsFor(candidates, detected) {
  const conflicts = [];
  const seen = new Set();
  for (const item of [...candidates, ...detected]) {
    if (!item?.nameConflict) continue;
    const id = item.id || item.name;
    if (seen.has(id)) continue;
    seen.add(id);
    conflicts.push({
      type: 'distant_same_name',
      id: item.id || null,
      name: item.name,
      note: 'Records sharing this name sit far apart. They were left unchanged for verification and were not merged.'
    });
  }
  return conflicts.slice(0, 6);
}

export function resolveManualAddress(rawFields, {near = null} = {}) {
  const fields = readManualFields(rawFields);
  const composedAddress = composeManualAddress(fields);
  const normalizedText = normalizeAddressText(composedAddress);
  const assessment = assessManualAddress(fields);
  const detected = detectCommunities([fields.community, fields.city, fields.landmark, fields.street, normalizedText].filter(Boolean).join(' '));
  if (!assessment.ok) {
    return {
      original: fields,
      composedAddress,
      normalizedText,
      detectedCommunities: detected,
      candidates: [],
      suggestion: null,
      resolution: 'unresolved',
      confidence: 'none',
      conflicts: [],
      requiresCustomerPin: true,
      uncertainty: assessment.reason
    };
  }
  const query = [fields.landmark, fields.community, fields.street, fields.city, fields.house].filter(Boolean).join(' ');
  const candidates = ghanaSearch(query, {limit: 8, near: near || null});
  const conflicts = conflictsFor(candidates, detected);
  const suggestion = chooseSuggestion(fields, candidates, detected);
  return {
    original: fields,
    composedAddress,
    normalizedText,
    detectedCommunities: detected,
    candidates,
    suggestion,
    resolution: suggestion ? suggestion.resolution : 'unresolved',
    confidence: suggestion ? suggestion.confidence : 'none',
    conflicts,
    requiresCustomerPin: !suggestion,
    uncertainty: suggestion?.uncertainty || 'No confident geographic record matched this description. Choose a point on the map. The written address will be kept, and no fare is calculated until a point is chosen.'
  };
}

function closeEnough(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.00001;
}

export function assertSubmissionCoordinates(positionKind, latitude, longitude, resolved) {
  if (positionKind === 'none' || positionKind === 'unresolved') {
    check(latitude == null && longitude == null, 400, 'Unresolved addresses cannot include coordinates');
    return {resolution: 'unresolved', positionKind: 'none', latitude: null, longitude: null, matchedLandmarkId: null};
  }
  check(positionKind === 'verified_record' || positionKind === 'approximate' || positionKind === 'customer_pin' || positionKind === 'gps', 400, 'Unknown position kind');
  check(Number.isFinite(latitude) && Number.isFinite(longitude), 400, 'A confirmed location needs coordinates you selected or that EGIE already has');
  check(latitude >= GHANA_BOUNDS.minLatitude && latitude <= GHANA_BOUNDS.maxLatitude && longitude >= GHANA_BOUNDS.minLongitude && longitude <= GHANA_BOUNDS.maxLongitude, 422, 'Location is outside Ghana');
  if (positionKind === 'customer_pin' || positionKind === 'gps') {
    return {resolution: positionKind, positionKind, latitude, longitude, matchedLandmarkId: null};
  }
  const pool = [resolved?.suggestion, ...(resolved?.candidates || []), ...(resolved?.detectedCommunities || [])].filter(Boolean);
  let match = pool.find(item => closeEnough(item.latitude, latitude) && closeEnough(item.longitude, longitude));
  if (!match) {
    const record = GHANA_GAZETTEER.find(place => closeEnough(place.latitude, latitude) && closeEnough(place.longitude, longitude));
    if (record) match = {id: record.id || null, latitude: record.latitude, longitude: record.longitude, name: record.name};
  }
  check(match, 409, 'Those coordinates are not an EGIE record for this address and were not stored');
  if (positionKind === 'verified_record') {
    check(resolved?.suggestion?.positionKind === 'verified_record' && closeEnough(resolved.suggestion.latitude, latitude) && closeEnough(resolved.suggestion.longitude, longitude), 409, 'This description is not a high-confidence record match');
  }
  return {
    resolution: positionKind === 'verified_record' ? 'matched_record' : 'approximate',
    positionKind,
    latitude: match.latitude,
    longitude: match.longitude,
    matchedLandmarkId: match.id || null
  };
}

export async function saveAddressSubmission(db, actor, input) {
  check(actor && ['customer', 'business'].includes(actor.kind) && !actor.api_client_id, 403, 'Customer account required');
  check(input && typeof input === 'object' && !Array.isArray(input), 400, 'Address submission required');
  check(['pickup', 'destination', 'food_delivery'].includes(input.role), 400, 'Address role must be pickup, destination or food delivery');
  const near = input.near && typeof input.near === 'object' ? input.near : null;
  const resolved = resolveManualAddress(input.original || input, {near});
  check(composeManualAddress(resolved.original).length >= 5, 400, 'Enter the address to keep with this point');
  const assessment = assessManualAddress(resolved.original);
  if (!assessment.ok) check(input.positionKind === 'none' || input.positionKind === 'unresolved', 400, assessment.reason);
  const latitude = input.latitude == null || input.latitude === '' ? null : Number(input.latitude);
  const longitude = input.longitude == null || input.longitude === '' ? null : Number(input.longitude);
  const judged = assertSubmissionCoordinates(input.positionKind, latitude, longitude, resolved);
  const uncertainty = judged.positionKind === 'customer_pin'
    ? 'Customer selected this point. The written address was kept as entered.'
    : judged.positionKind === 'gps'
      ? 'Device GPS position. The written address was kept as entered.'
      : (resolved.suggestion?.uncertainty || resolved.uncertainty || null);
  const id = randomUUID();
  await db.query(
    `INSERT INTO customer_address_submissions(
      id, customer_id, role, original, normalized_text, composed_address, resolution, confidence,
      matched_landmark_id, latitude, longitude, position_kind, uncertainty_note, conflict_flags
    ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
    [
      id,
      actor.id,
      input.role,
      JSON.stringify(resolved.original),
      resolved.normalizedText,
      resolved.composedAddress,
      judged.resolution,
      resolved.confidence || 'none',
      judged.matchedLandmarkId,
      judged.latitude,
      judged.longitude,
      judged.positionKind,
      uncertainty,
      JSON.stringify(resolved.conflicts || [])
    ]
  );
  return {
    id,
    role: input.role,
    original: resolved.original,
    composedAddress: resolved.composedAddress,
    normalizedText: resolved.normalizedText,
    resolution: judged.resolution,
    confidence: resolved.confidence || 'none',
    positionKind: judged.positionKind,
    latitude: judged.latitude,
    longitude: judged.longitude,
    matchedLandmarkId: judged.matchedLandmarkId,
    uncertainty,
    conflicts: resolved.conflicts || []
  };
}
