import { haversine } from '../../../dispatch-geometry.mjs';
import { GHANA_BOUNDS } from '../ghana-geocoder.mjs';

/**
 * Validates a single GPS observation against strict physical plausibility rules (Phase 6).
 */
export function filterGpsObservation(sample, previousSample = null) {
  if (!sample) return { valid: false, reason: 'missing_sample' };

  const { latitude, longitude, accuracyMeters, speedMps, observedAt } = sample;

  // 1. Geographic bounds check
  if (
    typeof latitude !== 'number' || typeof longitude !== 'number' ||
    latitude < GHANA_BOUNDS.minLatitude || latitude > GHANA_BOUNDS.maxLatitude ||
    longitude < GHANA_BOUNDS.minLongitude || longitude > GHANA_BOUNDS.maxLongitude
  ) {
    return { valid: false, reason: 'out_of_ghana_bounds' };
  }

  // 2. Horizontal Accuracy filter (< 25m required for road learning)
  if (typeof accuracyMeters !== 'number' || accuracyMeters > 25) {
    return { valid: false, reason: 'inaccurate_gps_reading', accuracyMeters };
  }

  // 3. Plausible instantaneous speed (< 35 m/s ≈ 126 km/h)
  if (speedMps !== undefined && speedMps !== null && (speedMps < 0 || speedMps > 35)) {
    return { valid: false, reason: 'implausible_speed', speedMps };
  }

  // 4. Sequential ordering and drift against previous sample
  if (previousSample) {
    const timeDeltaSec = (new Date(observedAt).getTime() - new Date(previousSample.observedAt).getTime()) / 1000;
    
    // Out-of-order or duplicate timestamp
    if (timeDeltaSec <= 0) {
      return { valid: false, reason: 'out_of_order_sample' };
    }

    const distMeters = haversine(
      { latitude: previousSample.latitude, longitude: previousSample.longitude },
      { latitude, longitude }
    );

    // Stationary jitter: < 3 meters movement in 5 seconds is sensor noise
    if (distMeters < 3 && timeDeltaSec <= 15) {
      return { valid: false, reason: 'stationary_noise' };
    }

    // Impossible teleport jump (speed > 40 m/s between readings)
    const effectiveSpeed = distMeters / timeDeltaSec;
    if (effectiveSpeed > 40) {
      return { valid: false, reason: 'impossible_teleport_jump', effectiveSpeed };
    }
  }

  return { valid: true, reason: 'valid_observation' };
}

/**
 * Filters a raw sequence of rider GPS samples, removing drift, jitter and jumps.
 */
export function sanitizeTrajectory(rawSamples) {
  if (!Array.isArray(rawSamples) || rawSamples.length === 0) return [];

  const valid = [];
  let prev = null;

  for (const s of rawSamples) {
    const check = filterGpsObservation(s, prev);
    if (check.valid) {
      valid.push(s);
      prev = s;
    }
  }

  return valid;
}

/**
 * Analyzes clean off-road trajectories and detects potential missing road corridors.
 * If multiple sequential points deviate from known roads with consistent trajectory,
 * extracts a candidate LineString corridor.
 */
export function extractCandidateRoadCorridor(cleanSamples, minPoints = 3) {
  if (!Array.isArray(cleanSamples) || cleanSamples.length < minPoints) return null;

  // Compute total displacement
  const start = cleanSamples[0];
  const end = cleanSamples[cleanSamples.length - 1];
  const totalDist = haversine(
    { latitude: start.latitude, longitude: start.longitude },
    { latitude: end.latitude, longitude: end.longitude }
  );

  // Must represent meaningful movement (at least 60 meters)
  if (totalDist < 60) return null;

  // Format as GeoJSON LineString coordinates [[lon, lat], ...]
  const coordinates = cleanSamples.map(s => [
    Number(s.longitude.toFixed(6)),
    Number(s.latitude.toFixed(6))
  ]);

  return {
    coordinates,
    pointCount: cleanSamples.length,
    distanceMeters: Math.round(totalDist),
    startPoint: { latitude: start.latitude, longitude: start.longitude },
    endPoint: { latitude: end.latitude, longitude: end.longitude }
  };
}
