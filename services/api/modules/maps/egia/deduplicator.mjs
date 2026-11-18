import { levenshtein, ghanaSearch } from '../ghana-geocoder.mjs';
import {haversine} from '../../../shared/dispatch-geometry.mjs';
import { normalizeInformalText } from './informal-geocoder.mjs';

const PUBLIC_CATEGORIES = new Set([
  'restaurant', 'chop_bar', 'school', 'church', 'mosque', 'market',
  'hospital', 'clinic', 'pharmacy', 'fuel_station', 'community_center',
  'public_building', 'transit_stop', 'junction', 'shop', 'commerce'
]);

// Expanded patterns to rigorously protect customer privacy across Ghana
const PRIVATE_RESIDENCE_PATTERNS = [
  /\b(?:house|home|residence|residential|apartment|flat|personal|compound|living here|private residence)\b/i,
  /\b(?:proprietor|landlord|family house)\b/i,
  /\b(?:my house|my room|father(?:'s)? house|mother(?:'s)? house|mama(?:'s)? (?:house|room|compound)|papa(?:'s)? (?:house|room|compound)|kofi's place|ama's house|kwame's room)\b/i,
  /\b(?:villa|bungalow|private gate|gate \d+|room \d+|flat \d+|block \d+ flat)\b/i,
  /\b(?:fie|ofie|efie|kurom)\b/i // Akan/Twi domestic residence references
];

// Incompatible categories that must NEVER be merged even when within 80m of each other
const INCOMPATIBLE_CATEGORY_PAIRS = [
  ['restaurant', 'pharmacy'],
  ['restaurant', 'school'],
  ['restaurant', 'hospital'],
  ['church', 'bar'],
  ['school', 'fuel_station'],
  ['school', 'hospital'],
  ['shop', 'fuel_station']
];

// "Mrs. Adjei" is a person and stays off the map. "Mr. Mensah Store" and "Auntie Ama Chop Bar" are businesses that
// trade under a person's name, which is how most small shops in Ghana are known, so they are allowed.
const PERSON_TITLE = /\b(?:mr|mrs|miss|madam|maame|uncle|aunt|auntie|aunty|brother|sister|bro|sis)\b\.?/i;
const BUSINESS_WORD = /\b(?:store|stores|shop|chop ?bar|bar|spot|pub|salon|saloon|barber|barbering|pharmacy|chemist|ventures|enterprise|enterprises|kitchen|restaurant|canteen|eatery|joint|cafe|bakery|clinic|school|academy|church|mosque|market|supermarket|mart|boutique|fashion|tailor|tailoring|electricals|hardware|provisions|cold store|kiosk|hotel|lodge|filling station|workshop|fitting shop|vulcanizer|washing bay|printing|pharmaceuticals|cosmetics|mobile money|momo)\b/i;
// "Guest House" and "Chop House" are businesses, not homes.
const PUBLIC_HOUSE = /\b(?:guest|chop|club|rest|court|boarding|coffee|tea) ?house\b/i;
// A Ghanaian phone number written into a name is someone's contact, not a place name.
const PHONE_NUMBER = /(?:\+?233|0)\d{9}(?!\d)/;

/**
 * Checks whether a proposed landmark name looks like a private home or a private person
 */
export function isLikelyPrivateResidence(name) {
  if (!name || typeof name !== 'string') return false;
  if (PHONE_NUMBER.test(name.replace(/[\s().-]/g, ''))) return true;
  if (PERSON_TITLE.test(name) && !BUSINESS_WORD.test(name) && !PUBLIC_HOUSE.test(name)) return true;
  const text = name.replace(new RegExp(PUBLIC_HOUSE.source, 'gi'), ' ');
  return PRIVATE_RESIDENCE_PATTERNS.some(p => p.test(text));
}

/**
 * Validates and classifies a landmark discovery proposal
 */
export function validatePublicLandmarkCandidate(candidate) {
  if (!candidate || !candidate.name) return { eligible: false, reason: 'missing_name' };

  if (isLikelyPrivateResidence(candidate.name)) {
    return { eligible: false, reason: 'private_residence_excluded' };
  }

  const category = (candidate.category || 'commerce').toLowerCase();
  if (!PUBLIC_CATEGORIES.has(category)) {
    return { eligible: false, reason: 'unsupported_category', category };
  }

  return { eligible: true, category };
}

/**
 * Checks whether two categories are compatible for deduplication
 */
function areCategoriesCompatible(catA, catB) {
  if (!catA || !catB) return true;
  const a = catA.toLowerCase();
  const b = catB.toLowerCase();
  if (a === b) return true;

  // General commerce can match specific commerce subcategories
  if ((a === 'commerce' && ['shop', 'restaurant', 'market'].includes(b)) ||
      (b === 'commerce' && ['shop', 'restaurant', 'market'].includes(a))) {
    return true;
  }

  for (const [x, y] of INCOMPATIBLE_CATEGORY_PAIRS) {
    if ((a === x && b === y) || (a === y && b === x)) {
      return false;
    }
  }

  return false; // Distinct categories should not be merged by default
}

/**
 * Deduplicates candidate landmark against existing database and gazetteer records (Phase 9 & Priority 3).
 * Enforces strict category checking, high similarity threshold (0.85), distinct branch preservation,
 * and private residence prevention.
 */
export async function deduplicateLandmark(db, candidate) {
  if (isLikelyPrivateResidence(candidate.name)) {
    return { isDuplicate: true, matchType: 'private_residence_blocked', reason: 'private_residence' };
  }

  const normName = normalizeInformalText(candidate.name);
  const candCategory = candidate.category ? candidate.category.toLowerCase() : null;

  // 1. Search in-memory gazetteer within 80 meters
  const nearbyGaz = ghanaSearch(candidate.name, { limit: 10 });
  for (const g of nearbyGaz) {
    const distMeters = haversine(
      { latitude: candidate.latitude, longitude: candidate.longitude },
      { latitude: g.latitude, longitude: g.longitude }
    );

    if (distMeters <= 80) {
      const gCategory = g.category ? g.category.toLowerCase() : null;
      if (!areCategoriesCompatible(candCategory, gCategory)) {
        continue; // Do not merge adjacent distinct establishments with incompatible categories
      }

      const gNorm = normalizeInformalText(g.name);
      const maxLen = Math.max(normName.length, gNorm.length, 1);
      const distSim = 1 - (levenshtein(normName, gNorm) / maxLen);

      // Require high similarity (>= 0.85) or identical normalized text
      if (distSim >= 0.85 || normName === gNorm) {
        return {
          isDuplicate: true,
          matchType: 'existing_gazetteer',
          existingId: g.id,
          existingName: g.name,
          distanceMeters: Math.round(distMeters),
          similarity: distSim.toFixed(2)
        };
      }
    }
  }

  // 2. Query PostGIS database (checking searchable_landmarks_v9 or spatial_landmarks)
  if (db) {
    try {
      const dbMatch = await db.query(`
        SELECT id, name, category,
               ST_Distance(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS dist_m
        FROM searchable_landmarks_v9
        WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 80)
        LIMIT 10;
      `, [candidate.longitude, candidate.latitude]);

      for (const row of dbMatch.rows) {
        const rowCategory = row.category ? row.category.toLowerCase() : null;
        if (!areCategoriesCompatible(candCategory, rowCategory)) {
          continue; // Distinct businesses in same commercial area
        }

        const match = landmarkMatch(normName, row);
        if (match) return match;
      }
    } catch {
      // Fallback to spatial_landmarks if view query fails
      try {
        const fallbackMatch = await db.query(`
          SELECT id, name, category,
                 ST_Distance(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS dist_m
          FROM spatial_landmarks
          WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 80)
          LIMIT 5;
        `, [candidate.longitude, candidate.latitude]);

        for (const row of fallbackMatch.rows) {
          if (!areCategoriesCompatible(candCategory, row.category?.toLowerCase())) continue;
          const match = landmarkMatch(normName, row);
          if (match) return match;
        }
      } catch {
        // Ignore DB search error
      }
    }
  }

  // 3. A suggestion already waiting for review, or already decided, at the same spot. Without this, every rider who
  // reports the same shop adds another copy of it.
  if (db) {
    try {
      const waiting = await db.query(`
        SELECT id, name, category,
               ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS dist_m
        FROM candidate_landmarks
        WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 80)
        LIMIT 20;
      `, [candidate.longitude, candidate.latitude]);
      for (const row of waiting.rows || []) {
        const match = landmarkMatch(normName, row);
        if (match) return { ...match, matchType: 'existing_candidate_landmark' };
      }
    } catch {
      // The other checks still stand.
    }
  }

  return { isDuplicate: false };
}

function landmarkMatch(normName, row) {
  const rowNorm = normalizeInformalText(row.name);
  const similarity = 1 - (levenshtein(normName, rowNorm) / Math.max(normName.length, rowNorm.length, 1));
  if (similarity < 0.85 && normName !== rowNorm) return null;
  return {
    isDuplicate: true,
    matchType: 'existing_spatial_landmarks_db',
    existingId: row.id,
    existingName: row.name,
    distanceMeters: Math.round(Number(row.dist_m)),
    similarity: similarity.toFixed(2)
  };
}
