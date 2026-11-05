import {ETA_ASSUMPTIONS,etaRange} from './stage-eta.mjs';

/**
 * Evidence classes for trip time, weakest first:
 * road_graph (empty-road model), assumed_baseline (these factors), measured (rider trips, used by the ETA service).
 * The only default rests on one Google Maps reading, Kasoa to Terminal 3 at 16:22 on 5 Nov 2026:
 * motorbike 55 min against 39, car 89 min against 40. So it applies to Accra's evening peak only.
 * Anything unmeasured stays at 1. Add readings with ETA_BASELINE_FACTORS,
 * for example {"accra":{"motorcycle":{"morning_peak":1.3}}}.
 */
const DEFAULTS = { accra: { motorcycle: { evening_peak: 1.4 }, car: { evening_peak: 2.2 } } };
const CITIES = new Set(['accra', 'kumasi', 'other']);
const VEHICLES = new Set(['motorcycle', 'car', 'van']);
const PERIODS = new Set(['morning_peak', 'midday', 'evening_peak', 'off_peak']);
const MIN_FACTOR = 0.5, MAX_FACTOR = 3;
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function etaBaselineFactors(env = process.env) {
  const out = new Map();
  const put = (city, vehicle, period, value) => out.set(`${city}:${vehicle}:${period}`, value);
  for (const [city, vehicles] of Object.entries(DEFAULTS)) for (const [vehicle, periods] of Object.entries(vehicles)) for (const [period, value] of Object.entries(periods)) put(city, vehicle, period, value);
  const raw = String(env.ETA_BASELINE_FACTORS ?? '').trim();
  if (!raw) return out;
  const parsed = JSON.parse(raw);
  if (!isPlain(parsed)) throw Error('ETA_BASELINE_FACTORS must be {"city":{"vehicle":{"period":factor}}}');
  for (const city of Object.keys(parsed)) {
    if (!CITIES.has(city) || !isPlain(parsed[city])) throw Error(`ETA_BASELINE_FACTORS has an unknown city: ${city}`);
    for (const vehicle of Object.keys(parsed[city])) {
      if (!VEHICLES.has(vehicle) || !isPlain(parsed[city][vehicle])) throw Error(`ETA_BASELINE_FACTORS has an unknown vehicle: ${vehicle}`);
      for (const period of Object.keys(parsed[city][vehicle])) {
        const value = parsed[city][vehicle][period];
        if (!PERIODS.has(period)) throw Error(`ETA_BASELINE_FACTORS has an unknown period: ${period}`);
        if (!Number.isFinite(value) || value < MIN_FACTOR || value > MAX_FACTOR) throw Error(`ETA_BASELINE_FACTORS ${city}.${vehicle}.${period} must be from ${MIN_FACTOR} to ${MAX_FACTOR}`);
        put(city, vehicle, period, value);
      }
    }
  }
  return out;
}

export function baselineFactorFor(factors, vehicle, bucket, city) {
  if (typeof factors?.get === 'function') return factors.get(`${city}:${vehicle}:${bucket}`) ?? 1;
  return factors?.[vehicle] ?? 1; // A flat factor per vehicle, as tests and older callers pass.
}

/**
 * What the customer sees at quote time. With a nearby rider's road time this covers the whole delivery,
 * using the same range as live tracking. Without one it covers only the journey, and says so.
 */
export function quotedEtaMinutes(travelSeconds, factor, { riderSeconds = null, source = null } = {}) {
 const evidence = source === 'measured' ? 'measured' : factor === 1 ? 'road_graph' : 'assumed_baseline';
 if (Number.isFinite(riderSeconds)) {
  const total = (riderSeconds + travelSeconds) * factor + ETA_ASSUMPTIONS.pickupHandoverSeconds + ETA_ASSUMPTIONS.dropoffHandoverSeconds;
  const range = etaRange(total, { confidence: 'medium' });
  return { low: range.minMinutes, high: range.maxMinutes, evidence, includesPickup: true };
 }
 const minutes = travelSeconds * factor / 60;
 return { low: Math.max(1, Math.round(minutes * 0.9)), high: Math.max(2, Math.round(minutes * 1.2)), evidence, includesPickup: false };
}
