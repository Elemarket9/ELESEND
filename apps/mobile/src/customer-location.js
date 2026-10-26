/**
 * ELESEND Customer Location Detection Service
 * Pure, testable, and secure GPS acquisition, validation and reverse-geocoding integration.
 * Strictly adheres to zero commercial API dependency (OSRM + local Ghana Geocoder only).
 */

export const GHANA_SERVICE_ENVELOPE = Object.freeze({
  minLat: 4.7,
  maxLat: 11.2,
  minLon: -3.3,
  maxLon: 1.2
});

export const ACCURACY_TIERS = Object.freeze({
  HIGH: 'high',         // <= 25m: Suitable for exact gate/entrance
  MODERATE: 'moderate', // 25m - 100m: Acceptable street level, adjustment recommended
  APPROXIMATE: 'approx' // > 100m: Wide area, manual pin adjustment required
});

/**
 * Validates raw coordinate values against mathematical constraints and Ghana service envelope.
 */
export function validateCoordinates(coords) {
  if (!coords || typeof coords !== 'object') {
    return { valid: false, reason: 'Coordinates must be an object' };
  }
  const lat = Number(coords.latitude);
  const lon = Number(coords.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { valid: false, reason: 'Coordinates must be finite numeric values' };
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { valid: false, reason: 'Coordinates out of WGS84 geodetic range' };
  }

  const inGhana = lat >= GHANA_SERVICE_ENVELOPE.minLat &&
                  lat <= GHANA_SERVICE_ENVELOPE.maxLat &&
                  lon >= GHANA_SERVICE_ENVELOPE.minLon &&
                  lon <= GHANA_SERVICE_ENVELOPE.maxLon;

  if (!inGhana) {
    return { valid: false, outsideCoverage: true, reason: 'Location is outside ELESEND Ghana service coverage' };
  }

  return { valid: true, latitude: lat, longitude: lon };
}

/**
 * Evaluates GPS accuracy and timestamp freshness.
 */
export function evaluateGpsQuality({ accuracy, timestamp, maxAgeMs = 120000 }) {
  const acc = Number.isFinite(Number(accuracy)) ? Math.max(0, Math.round(Number(accuracy))) : 50;
  
  let tier = ACCURACY_TIERS.HIGH;
  let advisory = null;

  if (acc > 100) {
    tier = ACCURACY_TIERS.APPROXIMATE;
    advisory = `Approximate location (±${acc}m). Please drag the pin to your exact building or entrance.`;
  } else if (acc > 25) {
    tier = ACCURACY_TIERS.MODERATE;
    advisory = `Good accuracy (±${acc}m). Review pin location before confirming.`;
  } else {
    advisory = `High accuracy (±${acc}m).`;
  }

  const now = Date.now();
  const isFresh = timestamp ? (now - Number(timestamp) <= maxAgeMs) : true;

  return {
    accuracyMeters: acc,
    tier,
    isFresh,
    advisory
  };
}

/**
 * Formats a user-facing label for GPS accuracy.
 */
export function formatAccuracyLabel(accuracyMeters) {
  const m = Math.max(1, Math.round(Number(accuracyMeters) || 15));
  if (m <= 25) return `±${m}m (High accuracy)`;
  if (m <= 100) return `±${m}m (Street level)`;
  return `±${m}m (Approximate)`;
}

/**
 * Orchestrates customer location detection with device permission, timeout, and reverse geocoding.
 */
export async function detectCustomerLocation({
  locationApi,
  reverseGeocodeApi,
  timeoutMs = 10000
} = {}) {
  if (!locationApi) {
    throw new Error('Location API provider required');
  }

  // 1. Check if device location services are enabled
  if (typeof locationApi.hasServicesEnabledAsync === 'function') {
    try {
      const enabled = await locationApi.hasServicesEnabledAsync();
      if (!enabled) {
        return {
          ok: false,
          error: 'services_disabled',
          message: 'GPS location services are disabled on your device. Please enable location in your device settings or search manually.'
        };
      }
    } catch {
      // Continue to permission request if check is unsupported
    }
  }

  // 2. Request Foreground Permission (NEVER background permission for customers)
  let permissionResult;
  try {
    permissionResult = await locationApi.requestForegroundPermissionsAsync();
  } catch (err) {
    return {
      ok: false,
      error: 'permission_error',
      message: 'Unable to request location permission: ' + (err.message || 'Unknown error')
    };
  }

  if (permissionResult?.status !== 'granted') {
    return {
      ok: false,
      error: 'permission_denied',
      message: 'Location permission was denied. You can search places or tap on the map to set your location.'
    };
  }

  // 3. Acquire current GPS position with timeout
  let position;
  try {
    const positionPromise = locationApi.getCurrentPositionAsync({
      accuracy: locationApi.Accuracy?.High ?? 4,
      maximumAge: 30000
    });

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Location request timed out')), timeoutMs)
    );

    position = await Promise.race([positionPromise, timeoutPromise]);
  } catch (err) {
    return {
      ok: false,
      error: 'acquisition_failed',
      message: 'Could not obtain GPS position in time. Please select your location on the map or search manually.'
    };
  }

  if (!position?.coords) {
    return {
      ok: false,
      error: 'invalid_position_data',
      message: 'Device did not return valid GPS coordinates.'
    };
  }

  const { latitude, longitude, accuracy } = position.coords;
  const timestamp = position.timestamp || Date.now();

  // 4. Validate coordinates
  const validation = validateCoordinates({ latitude, longitude });
  if (!validation.valid) {
    return {
      ok: false,
      error: validation.outsideCoverage ? 'outside_coverage' : 'invalid_coordinates',
      message: validation.outsideCoverage 
        ? 'Your current GPS location appears to be outside ELESEND\'s Ghana delivery service area.'
        : 'Invalid GPS coordinates detected.'
    };
  }

  // 5. Evaluate quality
  const quality = evaluateGpsQuality({ accuracy, timestamp });

  // 6. Reverse geocode via private backend
  let addressInfo = null;
  if (typeof reverseGeocodeApi === 'function') {
    try {
      addressInfo = await reverseGeocodeApi(validation.latitude, validation.longitude);
    } catch {
      // Non-fatal: geocoder failure still allows manual confirmation of GPS coordinates
      addressInfo = null;
    }
  }

  const displayAddress = addressInfo?.address || 
                         (addressInfo?.nearestPlace ? `Near ${addressInfo.nearestPlace}` : null) ||
                         `Pin: ${validation.latitude.toFixed(4)}, ${validation.longitude.toFixed(4)}`;

  return {
    ok: true,
    coordinates: {
      latitude: validation.latitude,
      longitude: validation.longitude
    },
    accuracyMeters: quality.accuracyMeters,
    accuracyTier: quality.tier,
    accuracyLabel: formatAccuracyLabel(quality.accuracyMeters),
    advisory: quality.advisory,
    reverseGeocode: addressInfo,
    displayAddress,
    recognizedNearby: addressInfo?.nearestPlace || addressInfo?.locality || null,
    region: addressInfo?.region || null,
    detectedAt: new Date(timestamp).toISOString()
  };
}

/**
 * Builds a confirmed delivery location object ready for quote or booking.
 */
export function buildConfirmedLocation({
  coordinates,
  displayAddress,
  reverseGeocode,
  manualInstructions,
  isAdjusted = false
}) {
  const validation = validateCoordinates(coordinates);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  let finalAddress = displayAddress?.trim() || `GPS Location (${validation.latitude.toFixed(5)}, ${validation.longitude.toFixed(5)})`;
  if (manualInstructions?.trim()) {
    finalAddress += ` [Instructions: ${manualInstructions.trim()}]`;
  }

  return {
    latitude: validation.latitude,
    longitude: validation.longitude,
    address: finalAddress,
    locality: reverseGeocode?.locality || null,
    city: reverseGeocode?.city || null,
    region: reverseGeocode?.region || null,
    nearestPlace: reverseGeocode?.nearestPlace || null,
    manuallyAdjusted: Boolean(isAdjusted),
    instructions: manualInstructions?.trim() || null,
    positionKind: isAdjusted ? 'customer_pin' : 'gps',
    confidence: isAdjusted ? 'medium' : 'high',
    confirmedAt: new Date().toISOString()
  };
}

const MANUAL_FIELDS = ['region', 'city', 'community', 'street', 'house', 'landmark', 'instructions'];

export function readManualFields(input) {
  const source = input && typeof input === 'object' ? input : {};
  const fields = {};
  for (const key of MANUAL_FIELDS) fields[key] = String(source[key] ?? '').replace(/\s+/g, ' ').trim();
  return fields;
}

export function composeManualAddress(fields) {
  const value = readManualFields(fields);
  const parts = [value.house, value.street, value.community, value.city, value.region].filter(Boolean);
  let text = parts.join(', ');
  if (value.landmark) text += text ? ` — near ${value.landmark}` : `Near ${value.landmark}`;
  if (value.instructions) text += text ? `. ${value.instructions}` : value.instructions;
  return text.trim();
}

export function assessManualAddress(fields) {
  const value = readManualFields(fields);
  if (value.landmark.length >= 3 || value.community.length >= 3) return {ok: true};
  if (value.city && (value.street.length >= 2 || value.house.length >= 1 || value.instructions.length >= 8)) return {ok: true};
  return {
    ok: false,
    reason: 'Add a community, landmark, or a street within a city. A region or city on its own is not enough to identify a pickup or delivery point.'
  };
}

export function positionStatus(kind) {
  switch (kind) {
    case 'verified_record': return {label: 'Verified place', tone: 'verified'};
    case 'approximate': return {label: 'Approximate location', tone: 'approximate'};
    case 'customer_pin': return {label: 'Customer-selected pin', tone: 'pin'};
    case 'gps': return {label: 'GPS position', tone: 'gps'};
    default: return {label: 'Unresolved address', tone: 'unresolved'};
  }
}

export function isQuotableLocation(loc) {
  if (!loc || !['verified_record', 'approximate', 'customer_pin', 'gps'].includes(loc.positionKind)) return false;
  return validateCoordinates(loc).valid === true && String(loc.address || '').trim().length >= 5;
}

export function locationFromSearchResult(place) {
  if (!place || !Number.isFinite(Number(place.latitude)) || !Number.isFinite(Number(place.longitude)) || place.needsConfirmation) {
    return null;
  }
  const validation = validateCoordinates(place);
  if (!validation.valid) return null;
  return {
    latitude: validation.latitude,
    longitude: validation.longitude,
    address: `${place.name}${place.label ? ` • ${place.label}` : ''}`,
    locality: place.locality || null,
    city: place.city || null,
    region: place.region || null,
    nearestPlace: place.name,
    landmark: place.name,
    matchedLandmarkId: place.id || null,
    positionKind: 'verified_record',
    confidence: 'high',
    uncertaintyNote: place.nameConflict ? 'The same name exists in more than one area. Check the city before confirming.' : null,
    needsConfirmation: Boolean(place.needsConfirmation || place.nameConflict)
  };
}

export function locationFromGps(result) {
  if (!result?.ok || !result.coordinates) return null;
  const validation = validateCoordinates(result.coordinates);
  if (!validation.valid) return null;
  return {
    latitude: validation.latitude,
    longitude: validation.longitude,
    address: result.displayAddress,
    locality: result.reverseGeocode?.locality || null,
    city: result.reverseGeocode?.city || null,
    region: result.region || result.reverseGeocode?.region || null,
    nearestPlace: result.recognizedNearby || null,
    landmark: result.recognizedNearby || null,
    accuracyMeters: result.accuracyMeters,
    accuracyLabel: result.accuracyLabel,
    positionKind: 'gps',
    confidence: result.accuracyTier === 'high' ? 'high' : 'medium',
    uncertaintyNote: result.advisory || null
  };
}

export function locationFromMapPress(coordinate, reverse) {
  const validation = validateCoordinates(coordinate);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }
  const landmark = reverse?.nearestPlace || null;
  return {
    latitude: validation.latitude,
    longitude: validation.longitude,
    address: reverse?.address || `Selected pin (${validation.latitude.toFixed(5)}, ${validation.longitude.toFixed(5)})`,
    locality: reverse?.locality || null,
    city: reverse?.city || null,
    region: reverse?.region || null,
    nearestPlace: landmark,
    landmark,
    positionKind: 'customer_pin',
    confidence: 'medium',
    uncertaintyNote: 'You placed this pin. It is not a verified address record.'
  };
}

export function locationFromResolve(fields, resolved, pin = null) {
  const originalManual = readManualFields(fields);
  const address = composeManualAddress(originalManual);
  const base = {
    address,
    originalManual,
    locality: originalManual.community || null,
    city: originalManual.city || null,
    region: originalManual.region || null,
    landmark: originalManual.landmark || null,
    nearestPlace: originalManual.landmark || null,
    uncertaintyNote: resolved?.uncertainty || null,
    conflicts: resolved?.conflicts || []
  };
  if (pin && Number.isFinite(Number(pin.latitude)) && Number.isFinite(Number(pin.longitude))) {
    const validation = validateCoordinates(pin);
    if (!validation.valid) throw new Error(validation.reason);
    return {
      ...base,
      latitude: validation.latitude,
      longitude: validation.longitude,
      positionKind: 'customer_pin',
      confidence: 'medium',
      uncertaintyNote: 'You placed this pin. The written address is unchanged.'
    };
  }
  const suggestion = resolved?.suggestion;
  if (suggestion && Number.isFinite(Number(suggestion.latitude)) && Number.isFinite(Number(suggestion.longitude))) {
    const validation = validateCoordinates(suggestion);
    if (!validation.valid) {
      return {...base, latitude: null, longitude: null, positionKind: 'none', confidence: 'none'};
    }
    return {
      ...base,
      latitude: validation.latitude,
      longitude: validation.longitude,
      locality: suggestion.locality || base.locality,
      city: suggestion.city || base.city,
      region: suggestion.region || base.region,
      landmark: suggestion.name || base.landmark,
      nearestPlace: suggestion.name || base.nearestPlace,
      matchedLandmarkId: suggestion.id || null,
      positionKind: suggestion.positionKind,
      confidence: suggestion.confidence,
      uncertaintyNote: suggestion.uncertainty || base.uncertaintyNote
    };
  }
  return {...base, latitude: null, longitude: null, positionKind: 'none', confidence: 'none'};
}

export function buildViewportQuery(bounds, zoom) {
  if (!bounds) return null;
  const {west, south, east, north} = bounds;
  if (![west, south, east, north, zoom].every(Number.isFinite)) return null;
  const params = new URLSearchParams({
    west: String(west),
    south: String(south),
    east: String(east),
    north: String(north),
    zoom: String(Math.round(zoom * 10) / 10)
  });
  return params.toString();
}

export function boundsFromRegion(region) {
  if (!region || !Number.isFinite(region.latitude) || !Number.isFinite(region.longitude)) return null;
  const latDelta = Number(region.latitudeDelta) > 0 ? region.latitudeDelta : region.longitudeDelta;
  const lonDelta = Number(region.longitudeDelta) > 0 ? region.longitudeDelta : latDelta;
  if (!Number.isFinite(latDelta) || !Number.isFinite(lonDelta)) return null;
  return {
    west: region.longitude - lonDelta / 2,
    east: region.longitude + lonDelta / 2,
    south: region.latitude - latDelta / 2,
    north: region.latitude + latDelta / 2,
    zoom: Math.max(1, Math.min(18, Math.log2(360 / lonDelta)))
  };
}

export function createDebouncer(waitMs) {
  let timer = null;
  return fn => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, waitMs);
  };
}
