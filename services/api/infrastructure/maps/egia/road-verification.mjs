/** The checks a rider-found road must pass to publish itself. Staff can undo any of them. */
const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function verificationRules(env = process.env) {
  return {
    enabled: env.MAP_AUTO_PUBLISH !== 'false',
    minRiders: number(env.MAP_AUTO_PUBLISH_MIN_RIDERS, 3),
    minRidersWithImagery: number(env.MAP_AUTO_PUBLISH_MIN_RIDERS_WITH_IMAGERY, 2),
    minSpanHours: number(env.MAP_AUTO_PUBLISH_MIN_HOURS, 24),
    minConfidence: 60,
    maxMeanAccuracyMeters: 20,
    minLengthMeters: 60,
    maxJoinMeters: 30
  };
}

/** Returns the reasons a road cannot publish. An empty list means it passed. */
export function verificationFailures(road, rules = verificationRules()) {
  const failures = [];
  const riders = Number(road.distinct_riders) || 0;
  const neededRiders = road.imagery_supported ? rules.minRidersWithImagery : rules.minRiders;
  if (road.status !== 'CORROBORATED') failures.push('not confirmed by riders');
  if (riders < neededRiders) failures.push(`needs ${neededRiders} different riders`);
  if ((Number(road.temporal_span_seconds) || 0) < rules.minSpanHours * 3600) failures.push(`needs sightings ${rules.minSpanHours} hours apart`);
  if ((Number(road.confidence) || 0) < rules.minConfidence) failures.push('confidence too low');
  if (Number(road.mean_accuracy_m ?? Infinity) > rules.maxMeanAccuracyMeters) failures.push('GPS not accurate enough');
  if ((Number(road.length_m) || 0) < rules.minLengthMeters) failures.push('too short');
  if (road.is_private_access) failures.push('private access');
  if (road.is_pedestrian_only) failures.push('pedestrian only');
  if (!road.is_valid) failures.push('invalid shape');
  if (!(Number(road.join_meters) <= rules.maxJoinMeters)) failures.push('does not join the road network');
  return failures;
}
