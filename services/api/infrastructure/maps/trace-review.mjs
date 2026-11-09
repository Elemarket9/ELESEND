// Rider GPS is used only to flag gaps and to propose speeds. Nothing here changes a fare,
// a commission, a settlement, or rider earnings, and nothing is applied until a person reviews it.
import {randomUUID} from 'node:crypto';
import {haversine} from '../../dispatch-geometry.mjs';
import {priorityArea} from '../../../../scripts/place-import.mjs';

const MIN_GAP_METERS = 80, MAX_ACCURACY_METERS = 30, MIN_SAMPLES = 20, MIN_KMH = 8, MAX_KMH = 90;

export function missingLinkFlags(points) {
  const flags = [];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1], current = points[index];
    if (previous.matched !== false || current.matched !== false) continue;
    if (!(previous.accuracyMeters <= MAX_ACCURACY_METERS && current.accuracyMeters <= MAX_ACCURACY_METERS)) continue;
    const length = haversine(previous, current);
    if (length < MIN_GAP_METERS) continue;
    const latitude = (Number(previous.latitude) + Number(current.latitude)) / 2;
    const longitude = (Number(previous.longitude) + Number(current.longitude)) / 2;
    const area = priorityArea(latitude, longitude);
    if (area === 'other') continue;
    flags.push({
      id: randomUUID(),
      status: 'REVIEW_REQUIRED',
      area,
      lengthM: Math.round(length),
      latitude,
      longitude,
      reason: 'GPS trace is not on the road graph. The point is the midpoint of two observed fixes, not a guessed address.'
    });
  }
  return flags;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function speedProposals(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const area = priorityArea(sample.latitude, sample.longitude);
    if (area !== 'greater_accra' && area !== 'kumasi') continue;
    if (!['car', 'motorcycle'].includes(sample.vehicle)) continue;
    if (!(sample.speedKmh >= MIN_KMH && sample.speedKmh <= MAX_KMH)) continue;
    const key = `${area}:${sample.vehicle}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample.speedKmh);
  }
  return [...groups.entries()].flatMap(([key, speeds]) => {
    if (speeds.length < MIN_SAMPLES) return [];
    const [area, vehicle] = key.split(':');
    return [{
      id: randomUUID(),
      status: 'pending',
      area,
      vehicle,
      proposedKmh: Number(median(speeds).toFixed(1)),
      samples: speeds.length,
      source: 'rider_gps'
    }];
  });
}

export async function storeTraceReview(db, {flags, proposals}) {
  if (flags?.length) {
    await db.query(`INSERT INTO road_gap_flags (id, status, area, length_m, latitude, longitude, reason)
      SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::int[], $5::float8[], $6::float8[], $7::text[])`, [
      flags.map(flag => flag.id), flags.map(flag => flag.status), flags.map(flag => flag.area), flags.map(flag => flag.lengthM),
      flags.map(flag => flag.latitude), flags.map(flag => flag.longitude), flags.map(flag => flag.reason)
    ]);
  }
  if (proposals?.length) {
    await db.query(`INSERT INTO profile_speed_proposals (id, status, area, vehicle, proposed_kmh, samples, source)
      SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::float4[], $6::int[], $7::text[])`, [
      proposals.map(row => row.id), proposals.map(row => row.status), proposals.map(row => row.area), proposals.map(row => row.vehicle),
      proposals.map(row => row.proposedKmh), proposals.map(row => row.samples), proposals.map(row => row.source)
    ]);
  }
}

export async function reviewSpeedProposal(db, id, status) {
  if (!['approved', 'rejected'].includes(status)) throw Error('Review must approve or reject the proposal');
  const result = await db.query(`UPDATE profile_speed_proposals SET status = $2, reviewed_at = now()
    WHERE id = $1 AND status = 'pending' RETURNING id, status, area, vehicle, proposed_kmh, samples`, [id, status]);
  return result.rows[0] || null;
}
