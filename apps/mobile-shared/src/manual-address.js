/**
 * ELESEND Ghanaian Manual Address & Location Resolution Service
 * 
 * Supports practical Ghanaian informal addressing conventions:
 * - Three mandatory location selection modes: GPS, Search, Manual Entry
 * - Region, Town/City, Community/Neighbourhood, Landmark, Building Description
 * - GhanaPostGPS digital address validation & parsing
 * - Separate storage of customer text, normalized components, coordinates, provenance,
 *   resolution status, confidence level, customer confirmation, and instructions.
 * - Zero fabricated coordinates: strictly requires explicit customer pin placement
 *   or verified geographic anchor before route quote calculation.
 */

export const GHANA_REGIONS = Object.freeze([
  'Greater Accra',
  'Ashanti',
  'Western',
  'Central',
  'Eastern',
  'Northern',
  'Volta',
  'Bono',
  'Bono East',
  'Ahafo',
  'Upper East',
  'Upper West',
  'Western North',
  'Oti',
  'Savannah',
  'North East'
]);

export const GHANA_REGIONAL_TOWNS = Object.freeze({
  'Greater Accra': ['Accra', 'Tema', 'Madina', 'Adenta', 'Dansoman', 'Teshie', 'Nungua', 'Spintex', 'Achimota', 'Dome', 'Kasoa', 'Ashaiman'],
  'Ashanti': ['Kumasi', 'Obuasi', 'Ejisu', 'Tafo', 'Asokwa', 'Suame', 'Bantama', 'Mampong', 'Konongo'],
  'Western': ['Takoradi', 'Sekondi', 'Tarkwa', 'Axim', 'Agona Nkwanta', 'Elubo'],
  'Central': ['Cape Coast', 'Winneba', 'Kasoa', 'Mankessim', 'Agona Swedru', 'Elmina', 'Buduburam'],
  'Eastern': ['Koforidua', 'Nkawkaw', 'Nsawam', 'Akosombo', 'Asamankese', 'Suhum'],
  'Northern': ['Tamale', 'Savelugu', 'Yendi', 'Bimbilla'],
  'Volta': ['Ho', 'Hohoe', 'Keta', 'Aflao', 'Kpando'],
  'Bono': ['Sunyani', 'Berekum', 'Dormaa Ahenkro'],
  'Bono East': ['Techiman', 'Kintampo', 'Atebubu', 'Nkoranza'],
  'Ahafo': ['Goaso', 'Duayaw Nkwanta', 'Kenyasi'],
  'Upper East': ['Bolgatanga', 'Navrongo', 'Bawku'],
  'Upper West': ['Wa', 'Nandom', 'Jirapa'],
  'Western North': ['Sefwi Wiawso', 'Bibiani'],
  'Oti': ['Dambai', 'Nkwanta', 'Jasikan'],
  'Savannah': ['Damongo', 'Bole', 'Salaga'],
  'North East': ['Nalerigu', 'Walewale']
});

export const GHANA_POST_GPS_REGEX = /^[A-Z]{2}-\d{3,4}-\d{4}$/i;

export const RESOLUTION_STATUSES = Object.freeze({
  VERIFIED: 'verified',                       // Official merchant partner or field-verified POI
  CUSTOMER_CONFIRMED: 'customer_confirmed',   // Pin placed or explicitly confirmed by customer
  APPROXIMATE: 'approximate',                 // Community or landmark candidate; gate unconfirmed
  UNRESOLVED: 'unresolved'                    // Text description with no geographic coordinates
});

export const PROVENANCE_TYPES = Object.freeze({
  GPS: 'gps',
  SEARCH_EGIA: 'search_egia',
  SEARCH_GAZETTEER: 'search_gazetteer',
  GHANAPOST_GPS: 'ghanapost_gps',
  MANUAL_PIN: 'manual_pin',
  MANUAL_UNRESOLVED: 'manual_unresolved'
});

/**
 * Validates GhanaPostGPS digital address format (e.g. GA-183-9022, AK-039-5028)
 */
export function isValidGhanaPostGps(code) {
  if (!code || typeof code !== 'string') return false;
  return GHANA_POST_GPS_REGEX.test(code.trim());
}

/**
 * Normalizes user-entered address text
 */
export function normalizeGhanaAddressText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/^,|,$/g, '');
}

/**
 * Builds a professional human-readable address summary string according to Ghanaian conventions.
 */
export function formatGhanaAddressSummary(components) {
  if (!components || typeof components !== 'object') {
    return 'Unspecified Location';
  }

  const parts = [];

  // GhanaPostGPS code prefix if available
  const gpsCode = components.ghanaPostGps ? components.ghanaPostGps.trim().toUpperCase() : null;
  if (gpsCode && isValidGhanaPostGps(gpsCode)) {
    parts.push(gpsCode);
  }

  // Locality hierarchy
  const community = components.community?.trim();
  const city = components.city?.trim();
  const region = components.region?.trim();

  let placeHeader = '';
  if (community && city && community.toLowerCase() !== city.toLowerCase()) {
    placeHeader = `${community}, ${city}`;
  } else if (community) {
    placeHeader = community;
  } else if (city) {
    placeHeader = city;
  }

  if (region && placeHeader) {
    placeHeader += ` (${region})`;
  } else if (region) {
    placeHeader = region;
  }

  if (placeHeader) parts.push(placeHeader);

  // Landmark
  const landmark = components.landmark?.trim();
  if (landmark) {
    parts.push(`Near ${landmark.replace(/^near\s+/i, '')}`);
  }

  // Building or gate description
  const building = components.buildingDescription?.trim();
  if (building) {
    parts.push(building);
  }

  // Street or house number if provided
  const street = components.street?.trim();
  const houseNum = components.houseNumber?.trim();
  if (street || houseNum) {
    const streetPart = [houseNum, street].filter(Boolean).join(' ');
    parts.push(streetPart);
  }

  return parts.length > 0 ? parts.join(' — ') : 'Unspecified Location';
}

/**
 * Parses informal Ghanaian address strings into structured components
 */
export function parseGhanaInformalAddress(text) {
  if (!text || typeof text !== 'string') {
    return { community: '', landmark: '', city: '', region: '', description: '' };
  }

  const clean = normalizeGhanaAddressText(text);

  // Check for GhanaPostGPS
  const gpsMatch = clean.match(/\b([A-Z]{2}-\d{3,4}-\d{4})\b/i);
  const ghanaPostGps = gpsMatch ? gpsMatch[1].toUpperCase() : '';

  // Detect Town / City & Infer Region from prominent towns
  let matchedCity = '';
  let matchedRegion = '';
  for (const [reg, towns] of Object.entries(GHANA_REGIONAL_TOWNS)) {
    for (const t of towns) {
      if (new RegExp(`\\b${t}\\b`, 'i').test(clean)) {
        matchedCity = t;
        matchedRegion = reg;
        break;
      }
    }
    if (matchedCity) break;
  }

  // Check explicit region match in text (overrides inferred if explicitly written)
  for (const reg of GHANA_REGIONS) {
    if (new RegExp(`\\b${reg}\\b`, 'i').test(clean)) {
      matchedRegion = reg;
      break;
    }
  }

  // Split segments by em-dash, en-dash, double dash
  const segments = clean.split(/\s*(?:—|–|--)\s*/).map(s => s.trim()).filter(Boolean);

  let landmark = '';
  let buildingDescription = '';
  let community = '';

  for (const seg of segments) {
    if (!landmark && /^(?:near|opposite|behind|adjacent to|next to|close to|in front of|beside|around|off)\b/i.test(seg)) {
      landmark = seg;
    } else if (!buildingDescription && /(?:gate|house|building|wall|container|shop|store|junction|floor|flat|kiosk|compound|storey)\b/i.test(seg)) {
      buildingDescription = seg;
    } else if (!landmark && /(?:near|opposite|behind|adjacent to|next to|close to)\b/i.test(seg)) {
      landmark = seg;
    } else if (!community && seg !== matchedCity && seg !== matchedRegion && !/^[A-Z]{2}-\d{3,4}-\d{4}$/i.test(seg)) {
      const subParts = seg.split(',').map(s => s.trim()).filter(Boolean);
      community = subParts[0] || seg;
    }
  }

  if (!landmark) {
    const lmMatch = clean.match(/\b(?:near|opposite|behind|adjacent to|next to|close to|in front of|beside)\s+[^,—]+/i);
    if (lmMatch) {
      landmark = lmMatch[0].trim();
    }
  }

  if (!buildingDescription) {
    const descMatch = clean.match(/(?:[a-z0-9\s]+)?(?:gate|house|building|wall|container|shop|store|junction|kiosk|compound|storey)[^,—]*/i);
    if (descMatch && descMatch[0].trim() !== landmark) {
      buildingDescription = descMatch[0].trim();
    }
  }

  if (!community && segments.length > 0) {
    community = segments[0].split(',')[0].trim();
  }

  return {
    region: matchedRegion,
    city: matchedCity,
    community: community || '',
    landmark: landmark || '',
    buildingDescription: buildingDescription || '',
    ghanaPostGps: ghanaPostGps || '',
    rawInput: text
  };
}

/**
 * Constructs an authoritative, separated location record.
 * Strictly avoids treating unverified text as GPS coordinates or defaulting region to Accra.
 */
export function buildLocationRecord({
  components = {},
  coordinates = null,
  provenance = PROVENANCE_TYPES.MANUAL_UNRESOLVED,
  resolutionStatus = RESOLUTION_STATUSES.UNRESOLVED,
  confidenceLevel = 0,
  customerConfirmed = false,
  deliveryInstructions = '',
  rawCustomerInput = ''
}) {
  const normComponents = {
    region: components.region?.trim() || '',
    city: components.city?.trim() || '',
    district: components.district?.trim() || '',
    community: components.community?.trim() || '',
    street: components.street?.trim() || '',
    houseNumber: components.houseNumber?.trim() || '',
    buildingDescription: components.buildingDescription?.trim() || '',
    landmark: components.landmark?.trim() || '',
    ghanaPostGps: components.ghanaPostGps?.trim().toUpperCase() || '',
    deliveryInstructions: (deliveryInstructions || components.deliveryInstructions || '').trim(),
    rawCustomerInput: (rawCustomerInput || components.rawCustomerInput || '').trim()
  };

  const addressSummary = formatGhanaAddressSummary(normComponents);

  const hasCoords = coordinates &&
                    Number.isFinite(Number(coordinates.latitude)) &&
                    Number.isFinite(Number(coordinates.longitude));

  const validLatitude = hasCoords ? Number(coordinates.latitude) : null;
  const validLongitude = hasCoords ? Number(coordinates.longitude) : null;

  let finalStatus = resolutionStatus;
  if (!hasCoords) {
    finalStatus = RESOLUTION_STATUSES.UNRESOLVED;
  } else if (customerConfirmed) {
    finalStatus = RESOLUTION_STATUSES.CUSTOMER_CONFIRMED;
  }

  return {
    address: addressSummary,
    manualComponents: normComponents,
    coordinates: hasCoords ? { latitude: validLatitude, longitude: validLongitude } : null,
    latitude: validLatitude,
    longitude: validLongitude,
    provenance,
    resolutionStatus: finalStatus,
    confidenceLevel: Math.min(100, Math.max(0, Math.round(confidenceLevel))),
    customerConfirmed: Boolean(customerConfirmed),
    deliveryInstructions: normComponents.deliveryInstructions,
    requiresConfirmation: finalStatus !== RESOLUTION_STATUSES.VERIFIED && !customerConfirmed
  };
}
