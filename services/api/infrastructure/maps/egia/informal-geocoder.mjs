import { ghanaSearch, GHANA_BOUNDS, GHANA_GAZETTEER } from '../ghana-geocoder.mjs';
import { haversine } from '../../../dispatch-geometry.mjs';

// Prepositional relative patterns in Ghanaian informal addresses
const RELATIVE_MARKERS = [
  { pattern: /\b(?:behind|at the back of)\b/i, kind: 'behind', offsetMeters: 40, bearingDeg: 180 },
  { pattern: /\b(?:opposite|directly opposite|facing)\b/i, kind: 'opposite', offsetMeters: 30, bearingDeg: 90 },
  { pattern: /\b(?:near|close to|around|nearby|adjacent to)\b/i, kind: 'near', offsetMeters: 25, bearingDeg: 0 },
  { pattern: /\b(?:in front of|front of|before)\b/i, kind: 'in_front_of', offsetMeters: 30, bearingDeg: 0 },
  { pattern: /\b(?:beside|next to|by the side of)\b/i, kind: 'beside', offsetMeters: 25, bearingDeg: 270 },
  { pattern: /\b(?:last stop|last junction|end of road)\b/i, kind: 'last_stop', offsetMeters: 0, bearingDeg: 0 },
  { pattern: /\b(?:junction|traffic light|crossroad|roundabout)\b/i, kind: 'junction', offsetMeters: 0, bearingDeg: 0 }
];

// Common Ghanaian locality names for rapid boundary and context extraction
// Sorted by length descending so longer/more specific sub-localities match first
const RAW_LOCALITIES = [
  'fetteh kakraba', 'awutu breku', 'awutu bereku', 'gomoa fetteh', 'mccarthy hill', 'buduburam',
  'agona swedru', 'east legon', 'cantonments', 'cape coast', 'mankessim', 'agbogbloshie',
  'bolgatanga', 'oforikrom', 'koforidua', 'sakumono', 'kaneshie', 'ashaiman', 'kwabenya',
  'opeikuma', 'techiman', 'takoradi', 'old tafo', 'new tafo', 'winneba', 'bantama', 'achimota',
  'dansoman', 'odorkor', 'spintex', 'sunyani', 'nkawkaw', 'damongo', 'nalerigu', 'elmina',
  'swedru', 'kumasi', 'madina', 'haatso', 'adenta', 'teshie', 'nungua', 'atonsu', 'tamale',
  'tarkwa', 'dambai', 'chorkor', 'ayigya', 'ejisu', 'hohoe', 'suame', 'abura', 'adum',
  'kasoa', 'weija', 'lapaz', 'dome', 'tafo', 'tema', 'osu'
];
const GHANA_LOCALITIES = [...RAW_LOCALITIES].sort((a, b) => b.length - a.length);

/**
 * Normalizes input text, corrects typical Ghanaian informal speech and spelling errors
 */
export function normalizeInformalText(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text.trim().toLowerCase();

  // Common spelling corrections
  s = s.replace(/\bkakrabaa\b/g, 'kakraba')
       .replace(/\bopiekuma\b/g, 'opeikuma')
       .replace(/\bkasowa\b/g, 'kasoa')
       .replace(/\bawutu senya\b/g, 'awutu breku')
       .replace(/\bbudumburam\b/g, 'buduburam')
       .replace(/\bcoomassie\b/g, 'kumasi')
       .replace(/\bjuncton\b/g, 'junction')
       .replace(/\bfiling station\b/g, 'filling station')
       .replace(/\bpetrol station\b/g, 'fuel station')
       .replace(/\bgas station\b/g, 'fuel station')
       .replace(/\bschools\b/g, 'school')
       .replace(/\bchurchs\b/g, 'church')
       .replace(/\bprovisn\b/g, 'provision')
       .replace(/\bprovison\b/g, 'provision')
       .replace(/\s+/g, ' ');

  return s;
}

/**
 * Extracts informal geographic structure:
 * - relativeRelation: 'behind', 'opposite', 'near', etc.
 * - coreTarget: The anchor landmark or POI (e.g. "SDA School", "filling station")
 * - localityContext: e.g. "Fetteh Kakraba", "Kasoa", "Bantama"
 * - modifier: e.g. "near the junction", "last stop"
 */
export function parseInformalDescription(text) {
  const normalized = normalizeInformalText(text);

  let relativeRelation = null;
  for (const m of RELATIVE_MARKERS) {
    if (m.pattern.test(normalized)) {
      relativeRelation = m;
      break;
    }
  }

  // Extract locality context if present (longer / more specific first)
  let localityContext = null;
  for (const loc of GHANA_LOCALITIES) {
    if (new RegExp(`\\b${loc}\\b`, 'i').test(normalized)) {
      localityContext = loc;
      break;
    }
  }

  // Strip relative marker keywords to isolate target landmark
  let coreTarget = normalized;
  if (localityContext) {
    coreTarget = coreTarget.replace(new RegExp(`\\b${localityContext}\\b`, 'gi'), '').trim();
  }
  // Also strip generic parent city if specific locality was found (e.g. "kumasi" when "bantama" was found)
  coreTarget = coreTarget.replace(/\b(kumasi|accra|cape coast|takoradi)\b/gi, ' ');
  coreTarget = coreTarget.replace(/\b(behind|opposite|near|close to|in front of|beside|next to|at|around|the|near the junction|last stop)\b/gi, ' ')
                         .replace(/,/g, ' ')
                         .replace(/\s+/g, ' ')
                         .trim();

  return {
    raw: text,
    normalized,
    relativeRelation: relativeRelation ? relativeRelation.kind : null,
    offsetMeters: relativeRelation ? relativeRelation.offsetMeters : 0,
    coreTarget: coreTarget || normalized,
    localityContext
  };
}

/**
 * Advanced Ghanaian Location Intelligence Search (Phase 2)
 * Ranks candidates with explainable confidence scoring (0-100)
 */
export async function searchInformalLocation(query, { db = null, userCoordinates = null, limit = 8 } = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];

  const parsed = parseInformalDescription(query);
  const candidates = [];

  // 1. Direct Search on Core Target + Locality (deduplicated to avoid redundant gazetteer scans)
  const searchTerms = [...new Set([
    parsed.localityContext ? `${parsed.coreTarget} ${parsed.localityContext}` : null,
    parsed.coreTarget,
    parsed.normalized
  ].filter(t => t && t.length >= 2))];

  const seenIds = new Set();

  for (const term of searchTerms) {
    if (!term || term.length < 2) continue;

    // Search in-memory gazetteer
    const gazResults = ghanaSearch(term, { limit: 12 });
    for (const res of gazResults) {
      const key = `${res.latitude.toFixed(5)}:${res.longitude.toFixed(5)}`;
      if (seenIds.has(key)) continue;
      seenIds.add(key);

      // Calculate candidate confidence
      let confidence = 50;
      const reasons = [];

      // Exact or partial name match on core target
      const resNameLower = (res.name || '').toLowerCase();
      if (resNameLower.includes(parsed.coreTarget)) {
        confidence += 25;
        reasons.push(`Matched landmark "${res.name}"`);
      } else {
        confidence += 10;
        reasons.push(`Partial text match on "${res.name}"`);
      }

      // Locality boost
      if (parsed.localityContext) {
        const resLoc = ((res.locality || '') + ' ' + (res.city || '')).toLowerCase();
        if (resLoc.includes(parsed.localityContext)) {
          confidence += 20;
          reasons.push(`Located in requested area "${parsed.localityContext}"`);
        }
      }

      // Proximity boost if customer location provided (use Number.isFinite so lon=0 at Tema is not falsy)
      if (userCoordinates && Number.isFinite(Number(userCoordinates.latitude)) && Number.isFinite(Number(userCoordinates.longitude))) {
        const distKm = haversine(userCoordinates, { latitude: res.latitude, longitude: res.longitude }) / 1000;
        if (distKm < 5) {
          confidence += 15;
          reasons.push(`Within 5km of your location`);
        } else if (distKm < 15) {
          confidence += 5;
          reasons.push(`Within 15km of your location`);
        }
      }

      // If relative description like "behind the school" was used, note that exact house cannot be inferred
      let promptConfirmation = false;
      let explanation = reasons.join('; ');

      if (parsed.relativeRelation) {
        confidence = Math.min(confidence, 78); // Cap confidence because "behind school" is not an exact building
        promptConfirmation = true;
        explanation = `Anchor landmark found: "${res.name}". Because "${parsed.relativeRelation}" indicates an informal offset, please confirm the exact pin on the map.`;
      }

      candidates.push({
        id: res.id || `gaz-${candidates.length + 1}`,
        name: res.name,
        category: res.category || 'landmark',
        locality: res.locality || parsed.localityContext || 'Greater Accra',
        city: res.city || 'Ghana',
        region: res.region || 'Greater Accra',
        latitude: res.latitude,
        longitude: res.longitude,
        confidence: Math.min(Math.max(confidence, 10), 99),
        candidateType: parsed.relativeRelation ? 'relative_offset_reference' : 'exact_landmark',
        relativeRelation: parsed.relativeRelation,
        promptConfirmation,
        explanation
      });
    }

    if (candidates.length >= limit) break;
  }

  // 2. Database Search on mapped_restaurants and spatial_landmarks (always query mapped_restaurants when db is provided)
  if (db && (parsed.coreTarget || parsed.localityContext)) {
    try {
      const targetStr = parsed.coreTarget || parsed.localityContext;
      const locPattern = parsed.localityContext ? `%${parsed.localityContext}%` : null;
      const restRes = await db.query(`
        SELECT restaurant_id, name, category, subcategory, category_group, cuisine,
               region, district, community, latitude, longitude,
               coordinate_kind, verification_status, source_name, source_license,
               is_registered_merchant, registered_merchant_id,
               GREATEST(similarity(name, $1), CASE WHEN name ILIKE $2 THEN 0.85 ELSE 0.0 END) AS sim,
               CASE WHEN $3::text IS NOT NULL AND (community ILIKE $3 OR district ILIKE $3) THEN 1 ELSE 0 END AS loc_match
        FROM mapped_restaurants
        WHERE (
          name % $1
          OR name ILIKE $2
          OR category ILIKE $2
          OR ($3::text IS NOT NULL AND (community ILIKE $3 OR district ILIKE $3))
        )
        ORDER BY loc_match DESC, sim DESC, is_registered_merchant DESC, confidence_score DESC
        LIMIT $4
      `, [targetStr, `%${targetStr}%`, locPattern, Math.max(limit, 10)]);

      for (const row of restRes.rows) {
        const key = `${Number(row.latitude).toFixed(5)}:${Number(row.longitude).toFixed(5)}`;
        let conf = Math.round(Number(row.sim || 0.45) * 65) + (row.is_registered_merchant ? 25 : 18);
        if (Number(row.loc_match) === 1) conf += 15;
        if (parsed.relativeRelation) conf = Math.min(conf, 78);

        const mappedCandidate = {
          id: row.restaurant_id,
          restaurant_id: row.restaurant_id,
          name: row.name,
          category: row.category,
          subcategory: row.subcategory,
          category_group: row.category_group || 'restaurants_and_chop_bars',
          cuisine: row.cuisine,
          locality: row.community || row.region,
          district: row.district || row.region,
          city: row.district || row.region,
          region: row.region,
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          coordinate_kind: row.coordinate_kind || 'mapped_point',
          verification_status: row.verification_status || 'source_coordinates_not_field_verified',
          source_name: row.source_name,
          source_license: row.source_license,
          confidence: Math.min(Math.max(conf, 25), 99),
          candidateType: 'mapped_restaurant',
          selectable_as_destination: true,
          is_registered_merchant: Boolean(row.is_registered_merchant),
          can_order_menu: Boolean(row.is_registered_merchant && row.registered_merchant_id),
          registered_merchant_id: row.registered_merchant_id,
          promptConfirmation: Boolean(parsed.relativeRelation),
          explanation: row.is_registered_merchant
            ? `Official Partner Restaurant: "${row.name}" (${row.community}, ${row.region})`
            : `Mapped Landmark Restaurant: "${row.name}" (${row.community}, ${row.region}) - Selectable as Delivery Reference`
        };

        const existingIdx = candidates.findIndex(
          c => `${Number(c.latitude).toFixed(5)}:${Number(c.longitude).toFixed(5)}` === key
        );
        if (existingIdx !== -1) {
          candidates[existingIdx] = {
            ...candidates[existingIdx],
            ...mappedCandidate,
            confidence: Math.max(candidates[existingIdx].confidence, mappedCandidate.confidence)
          };
          continue;
        }
        seenIds.add(key);
        candidates.push(mappedCandidate);
      }

      // Then check spatial_landmarks if more spots needed
      if (candidates.length < limit) {
        const dbRes = await db.query(`
          SELECT id, name, category, region, locality, city, latitude, longitude,
                 similarity(name, $1) AS sim
          FROM spatial_landmarks
          WHERE search_name ILIKE $2 OR similarity(name, $1) > 0.3
          ORDER BY sim DESC, popularity DESC
          LIMIT $3
        `, [parsed.coreTarget, `%${parsed.coreTarget}%`, limit - candidates.length]);

        for (const row of dbRes.rows) {
          const key = `${Number(row.latitude).toFixed(5)}:${Number(row.longitude).toFixed(5)}`;
          if (seenIds.has(key)) continue;
          seenIds.add(key);

          candidates.push({
            id: row.id,
            name: row.name,
            category: row.category,
            locality: row.locality,
            city: row.city,
            region: row.region,
            latitude: Number(row.latitude),
            longitude: Number(row.longitude),
            confidence: Math.round(Number(row.sim) * 70) + 15,
            candidateType: 'exact_landmark',
            promptConfirmation: Boolean(parsed.relativeRelation),
            explanation: `Database match for "${row.name}" (${row.locality}, ${row.region})`
          });
        }
      }
    } catch {
      // Graceful fallback to in-memory candidates
    }
  }

  // 3. Fallback: If no landmark matched, but community/locality was identified
  if (candidates.length === 0 && parsed.localityContext) {
    const locCenter = GHANA_GAZETTEER.find(g => 
      (g.locality || '').toLowerCase().includes(parsed.localityContext) || 
      (g.name || '').toLowerCase().includes(parsed.localityContext)
    );

    if (locCenter) {
      candidates.push({
        id: 'community-center-fallback',
        name: `${locCenter.name} (General Area)`,
        category: 'community_center',
        locality: locCenter.locality || parsed.localityContext,
        city: locCenter.city,
        region: locCenter.region,
        latitude: locCenter.latitude,
        longitude: locCenter.longitude,
        confidence: 35,
        candidateType: 'community_center_fallback',
        promptConfirmation: true,
        explanation: `Location not listed. Centered near ${locCenter.name}. Please select your exact delivery point on the map.`
      });
    }
  }

  // Sort candidates by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);

  return candidates.slice(0, limit);
}
