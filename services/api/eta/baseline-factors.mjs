/**
 * Evidence classes for trip time, weakest first:
 * road_graph (empty-road model), assumed_baseline (these factors), measured (rider trips, used by the ETA service).
 * The peak defaults rest on one Google Maps reading, Kasoa to Terminal 3 at 16:22 on 5 Nov 2026:
 * motorbike 55 min against 39, car 89 min against 40. Every other period is unmeasured and stays at 1.
 * Override with ETA_BASELINE_FACTORS, for example {"motorcycle":{"evening_peak":1.3}}.
 */
const DEFAULTS = {
  motorcycle: { morning_peak: 1.4, evening_peak: 1.4, midday: 1, off_peak: 1 },
  car: { morning_peak: 2.2, evening_peak: 2.2, midday: 1, off_peak: 1 }
};
const MIN_FACTOR = 0.5, MAX_FACTOR = 3;
const valid = value => Number.isFinite(value) && value >= MIN_FACTOR && value <= MAX_FACTOR;

export function etaBaselineFactors(env = process.env) {
  const out = { motorcycle: { ...DEFAULTS.motorcycle }, car: { ...DEFAULTS.car } };
  const raw = String(env.ETA_BASELINE_FACTORS ?? '').trim();
  if (!raw) return out;
  const parsed = JSON.parse(raw);
  for (const [vehicle, periods] of Object.entries(parsed)) {
    for (const [period, value] of Object.entries(periods)) {
      if (!valid(value)) throw Error(`ETA_BASELINE_FACTORS ${vehicle}.${period} must be from ${MIN_FACTOR} to ${MAX_FACTOR}`);
      (out[vehicle] ??= {})[period] = value;
    }
  }
  return out;
}

export function baselineFactorFor(factors, vehicle, bucket) {
  const entry = factors?.[vehicle];
  return (typeof entry === 'object' && entry ? entry[bucket] : entry) ?? 1;
}

/** A range, because this is an estimate. Journey only: reaching the pickup is separate. */
export function quotedEtaMinutes(travelSeconds, factor) {
  const minutes = travelSeconds * factor / 60;
  return { low: Math.max(1, Math.round(minutes * 0.9)), high: Math.max(2, Math.round(minutes * 1.2)), evidence: factor === 1 ? 'road_graph' : 'assumed_baseline' };
}
