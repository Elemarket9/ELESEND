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
    confirmedAt: new Date().toISOString()
  };
}
