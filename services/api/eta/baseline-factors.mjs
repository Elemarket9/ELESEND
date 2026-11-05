/**
 * How much longer than the empty-road time a trip takes until rider data replaces these.
 * Peak values come from one Google Maps reading, Kasoa to Terminal 3 at 16:22:
 * motorbike 55 min against 39, car 89 min against 40. The other periods are unmeasured.
 */
const DEFAULTS = {
  motorcycle: { morning_peak: 1.4, evening_peak: 1.4, midday: 1, off_peak: 1 },
  car: { morning_peak: 2.2, evening_peak: 2.2, midday: 1, off_peak: 1 }
};

export function etaBaselineFactors(env = process.env) {
  const flat = String(env.ETA_MOTORCYCLE_BASELINE_FACTOR ?? '').trim();
  return flat ? { ...DEFAULTS, motorcycle: Number(flat) } : DEFAULTS;
}

export function baselineFactorFor(factors, vehicle, bucket) {
  const entry = factors?.[vehicle];
  return (typeof entry === 'object' && entry ? entry[bucket] : entry) ?? 1;
}

/** What a customer sees before booking: a range, because this is an estimate. */
export function quotedEtaMinutes(travelSeconds, factor) {
  const minutes = travelSeconds * factor / 60;
  return { low: Math.max(1, Math.round(minutes * 0.9)), high: Math.max(2, Math.round(minutes * 1.2)) };
}
