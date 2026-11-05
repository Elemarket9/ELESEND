import { sanitizeTrajectory, extractCandidateRoadCorridor, offRoadSegments } from './gps-quality-filter.mjs';
import { validatePublicLandmarkCandidate, deduplicateLandmark } from './deduplicator.mjs';
import { calculateBearing, angleDifference } from './unmapped-navigation.mjs';
import { randomUUID } from 'node:crypto';
import { ghanaReverseGeocode } from '../ghana-geocoder.mjs';
import { createMapLifecycleService } from './map-lifecycle-service.mjs';

// Learning may advance a road under review, but never reverses an administrator's decision.
const OVERLAP_MINUTES = 10; // A trip crossing two reads is still seen whole.
const WINDOW_MINUTES = 30;
const FIRST_READ_HOURS = 6;
const SAME_ROAD_METERS = 35;
const SAME_ROAD_SHARE = 0.7;
const LONGER_TRACE_RATIO = 1.2;
const MIN_SECONDS_BETWEEN_SIGHTINGS = 1800; // Two riders travelling together are not two sightings.
// Bicycles use paths motor vehicles cannot, so their trips would teach the wrong roads.
const NOT_LEARNED_FROM = new Set(['bicycle']);
const retentionDays = () => {
  const days = Number(process.env.MAP_CANDIDATE_RETENTION_DAYS);
  return Number.isInteger(days) && days > 0 ? days : 90;
};
// Roads already known that this line follows, even when one trip is longer than the other.
const FIND_SAME_ROAD = `
  WITH trace AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS line)
  SELECT r.id, r.status, r.confidence, r.observation_count, r.distinct_riders,
         r.created_at, r.updated_at, r.temporal_span_seconds, r.bidirectional,
         r.mean_accuracy_m, r.is_private_access, r.contributor_rider_ids, r.allowed_vehicles,
         ST_AsGeoJSON(r.corridor::geometry) AS existing_geojson,
         ST_Length(r.corridor) AS existing_m,
         ST_Length(t.line::geography) AS trace_m
  FROM candidate_roads r, trace t
  WHERE ST_DWithin(r.corridor, t.line::geography, ${SAME_ROAD_METERS})
    AND ST_Length(ST_Intersection(t.line, ST_Buffer(r.corridor, ${SAME_ROAD_METERS})::geometry)::geography)
        >= ${SAME_ROAD_SHARE} * LEAST(ST_Length(t.line::geography), ST_Length(r.corridor))
  ORDER BY ST_Distance(r.corridor, t.line::geography) ASC
  LIMIT 1`;
const LOCKED_ROAD_STATUSES = new Set(['VERIFIED', 'PUBLISHED', 'REJECTED', 'RETIRED']);

/**
 * Continuous Geographic Learning Runner (EGIA Phase 11 & Priority 1 & 3).
 * Executes periodically without blocking customer orders or payments.
 * Connects rider GPS trajectories, multi-factor corroboration (provenance, temporal spread,
 * bidirectional flow, mean accuracy), and evidence-based candidate road/landmark promotion.
 */
export async function runGeographicLearningCycle(db, { routing = null, riderVehicles = null, now = Date.now() } = {}) {
  const result = {
    roadsDiscovered: 0,
    roadsCorroborated: 0,
    landmarksCorroborated: 0,
    reportsProcessed: 0
  };

  // 1. Process recent rider map reports with independent corroboration (different riders, same area <= 50m)
  const corroboratedReports = await db.query(`
    SELECT r1.id, r1.rider_id, r1.report_type, r1.notes,
           ST_Y(r1.location::geometry) AS latitude,
           ST_X(r1.location::geometry) AS longitude,
           ST_AsGeoJSON(r1.road_geometry::geometry) AS road_geojson,
           count(r2.id)::int AS corroboration_count
    FROM rider_map_reports r1
    JOIN rider_map_reports r2 ON r1.rider_id <> r2.rider_id 
      AND r1.report_type = r2.report_type
      AND ST_DWithin(r1.location, r2.location, 50)
    WHERE r1.status = 'pending'
    GROUP BY r1.id, r1.rider_id, r1.report_type, r1.notes, r1.location, r1.road_geometry
    HAVING count(r2.id) >= 1
    LIMIT 50;
  `);

  for (const rep of corroboratedReports.rows) {
    if (rep.report_type === 'missing_landmark' && rep.notes) {
      const candidateObj = {
        name: rep.notes.slice(0, 80),
        category: 'commerce',
        latitude: Number(rep.latitude),
        longitude: Number(rep.longitude)
      };

      const val = validatePublicLandmarkCandidate(candidateObj);
      if (val.eligible) {
        const place = ghanaReverseGeocode(candidateObj.latitude, candidateObj.longitude);
        const dedup = await deduplicateLandmark(db, candidateObj);
        if (!dedup.isDuplicate) {
          await db.query(`
            INSERT INTO candidate_landmarks (
              id, name, search_name, category, region, locality, city,
              location, confidence, source, verification_status
            ) VALUES (
              $1, $2, $3, $4, $7, $8, $9,
              ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, 65, 'rider_corroboration', 'CORROBORATED'
            )
            ON CONFLICT DO NOTHING
          `, [
            randomUUID(),
            candidateObj.name,
            candidateObj.name.toLowerCase(),
            val.category,
            candidateObj.longitude,
            candidateObj.latitude,
            place.region || 'Unknown',
            place.locality || 'Unknown',
            place.city || 'Unknown'
          ]);

          result.landmarksCorroborated++;
        }
      }
    } else if (rep.report_type === 'missing_road' && rep.road_geojson) {
      // Missing road reported by multiple independent riders. One road, however many reports.
      const known = await db.query(FIND_SAME_ROAD, [rep.road_geojson]);
      if (known.rows.length === 0) {
        const insertRoad = await db.query(`
          INSERT INTO candidate_roads (
            id, name, corridor, status, confidence, observation_count, distinct_riders, source, contributor_rider_ids
          )
          SELECT $1, 'Rider Reported Road', ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)::geography,
                 'CORROBORATED', 65, count(DISTINCT rider_id), count(DISTINCT rider_id), 'rider_corroborated_report', array_agg(DISTINCT rider_id)
          FROM rider_map_reports
          WHERE report_type = 'missing_road' AND status = 'pending'
            AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 50)
          ON CONFLICT DO NOTHING
        `, [randomUUID(), rep.road_geojson, Number(rep.longitude), Number(rep.latitude)]);
        if (insertRoad.rowCount > 0) {
          result.roadsCorroborated++;
        }
      }
    }

    // The matching reports were used together, so they must not produce another entry.
    await db.query(`
      UPDATE rider_map_reports SET status = 'corroborated'
      WHERE status = 'pending' AND report_type = $2
        AND (id = $1 OR ST_DWithin(location, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 50))
    `, [rep.id, rep.report_type, Number(rep.longitude), Number(rep.latitude)]);
    result.reportsProcessed++;
  }

  await cleanUpOldCandidates(db);

  // Without road data every trip would look like a new road, so discovery waits for routing.
  if (typeof routing?.nearestRoadMeters !== 'function') return result;

  // 2. Discover and corroborate candidate roads from off-road rider trajectories (Priority 3 Hardened)
  const window = await nextWindow(db, now);
  const riderSamples = await db.query(`
    SELECT rider_id, array_agg(jsonb_build_object(
      'latitude', ST_Y(position::geometry),
      'longitude', ST_X(position::geometry),
      'accuracyMeters', accuracy_m,
      'observedAt', observed_at
    ) ORDER BY observed_at ASC) AS samples
    FROM rider_location_samples
    WHERE observed_at > $1 AND observed_at <= $2
    GROUP BY rider_id
    HAVING count(*) >= 4
  `, [window.from, window.until]);
  const vehicles = riderVehicles ? await riderVehicles(riderSamples.rows.map(row => row.rider_id)) : new Map();

  let roadChecksFailed = 0, ridersChecked = 0;
  for (const row of riderSamples.rows) {
    const vehicle = vehicles.get(row.rider_id) || 'motorcycle';
    if (NOT_LEARNED_FROM.has(vehicle)) continue;
    ridersChecked++;
    const recent = sanitizeTrajectory(row.samples);
    let roadDistances;
    try {
      roadDistances = [];
      for (const sample of recent) roadDistances.push(await routing.nearestRoadMeters(sample, { vehicle }));
    } catch {
      roadChecksFailed++;
      continue; // Road data unavailable: learn nothing from this rider in this cycle.
    }

    for (const clean of offRoadSegments(recent, roadDistances)) {
    const corridor = extractCandidateRoadCorridor(clean);

    if (corridor) {
      const lineGeoJson = JSON.stringify({
        type: 'LineString',
        coordinates: corridor.coordinates
      });

      // Calculate trajectory metrics
      const meanAcc = clean.reduce((sum, s) => sum + (s.accuracyMeters || 10), 0) / clean.length;
      const latestObsTime = new Date(clean[clean.length - 1].observedAt).getTime();
      const earliestObsTime = new Date(clean[0].observedAt).getTime();
      const trajBearing = calculateBearing(
        corridor.startPoint.latitude, corridor.startPoint.longitude,
        corridor.endPoint.latitude, corridor.endPoint.longitude
      );

      const existingRoad = await db.query(FIND_SAME_ROAD, [lineGeoJson]);

      if (existingRoad.rows.length > 0) {
        const cur = existingRoad.rows[0];
        if (LOCKED_ROAD_STATUSES.has(cur.status)) continue;
        // The learning window overlaps between cycles, so the same rider is seen again and again.
        if ((cur.contributor_rider_ids || []).includes(row.rider_id)) continue;

        // How long the road has been seen for, from its first sighting.
        const firstSeen = new Date(cur.created_at).getTime();
        const cumulativeSpan = Math.max(cur.temporal_span_seconds || 0, Math.round((latestObsTime - firstSeen) / 1000));

        // Check directional consistency and bidirectional flow
        let isBidirectional = cur.bidirectional;
        if (cur.existing_geojson) {
          const exCoords = JSON.parse(cur.existing_geojson).coordinates;
          if (exCoords.length >= 2) {
            const exBearing = calculateBearing(exCoords[0][1], exCoords[0][0], exCoords[exCoords.length - 1][1], exCoords[exCoords.length - 1][0]);
            const bearingDiff = Math.abs(angleDifference(trajBearing, exBearing));
            if (bearingDiff > 120 && bearingDiff < 240) {
              isBidirectional = true; // Observed in reverse direction: strong proof of public thoroughfare
            }
          }
        }

        const newDistinctRiders = cur.distinct_riders + 1;
        const newObsCount = cur.observation_count + 1;
        const combinedMeanAcc = ((cur.mean_accuracy_m || 10) * cur.distinct_riders + meanAcc) / newDistinctRiders;

        // Multi-Factor Evidence-Based Confidence Scoring (Priority 3)
        let calcConfidence = 30 + (newDistinctRiders * 15) + (Math.min(corridor.pointCount, 10) * 2);
        if (isBidirectional) calcConfidence += 15;
        if (combinedMeanAcc > 15.0) calcConfidence -= 10;
        const newConfidence = Math.min(95, Math.max(30, calcConfidence));

        // Corroboration threshold: Requires distinct riders, reasonable accuracy, and non-private status
        const canCorroborate = newDistinctRiders >= 2 &&
                               combinedMeanAcc <= 20.0 &&
                               !cur.is_private_access &&
                               cumulativeSpan >= MIN_SECONDS_BETWEEN_SIGHTINGS &&
                               newConfidence >= 60;

        const newStatus = canCorroborate ? 'CORROBORATED' : cur.status;

        await db.query(`
          UPDATE candidate_roads
          SET observation_count = $2,
              distinct_riders = $3,
              confidence = $4,
              status = $5,
              temporal_span_seconds = $6,
              bidirectional = $7,
              mean_accuracy_m = $8,
              contributor_rider_ids = array_append(contributor_rider_ids, $9::uuid),
              allowed_vehicles = CASE WHEN $10 = ANY(allowed_vehicles) THEN allowed_vehicles ELSE array_append(allowed_vehicles, $10) END,
              corridor = CASE WHEN $11::text IS NULL THEN corridor ELSE ST_SetSRID(ST_GeomFromGeoJSON($11), 4326)::geography END,
              updated_at = now()
          WHERE id = $1
        `, [cur.id, newObsCount, newDistinctRiders, newConfidence, newStatus, cumulativeSpan, isBidirectional, combinedMeanAcc, row.rider_id, vehicle, Number(cur.trace_m) > Number(cur.existing_m) * LONGER_TRACE_RATIO ? lineGeoJson : null]);

        if (newStatus === 'CORROBORATED' && cur.status !== 'CORROBORATED') {
          result.roadsCorroborated++;
        }
      } else {
        // First observation of an unmapped corridor
        const roadId = randomUUID();
        await db.query(`
          INSERT INTO candidate_roads (
            id, name, corridor, status, confidence, observation_count, distinct_riders,
            mean_accuracy_m, source, contributor_rider_ids, allowed_vehicles
          ) VALUES (
            $1, 'Discovered Road Segment', ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)::geography,
            'OBSERVED', 35, $3, 1, $4, 'rider_gps_cluster', ARRAY[$5::uuid], ARRAY[$6]
          )
          ON CONFLICT DO NOTHING
        `, [roadId, lineGeoJson, corridor.pointCount, meanAcc, row.rider_id, vehicle]);

        result.roadsDiscovered++;
      }
    }
    }
  }

  // If road data was down for everyone, read these trips again next time.
  if (!(ridersChecked > 0 && roadChecksFailed === ridersChecked)) {
    await db.query(
      `INSERT INTO geo_learning_state (id, processed_until) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET processed_until = EXCLUDED.processed_until`,
      [window.until]
    );
  }

  await db.query(`
    UPDATE candidate_roads r SET imagery_supported = true
    WHERE r.imagery_supported = false AND r.status NOT IN ('PUBLISHED', 'REJECTED', 'RETIRED')
      AND EXISTS (SELECT 1 FROM map_change_areas a WHERE ST_DWithin(a.cell, r.corridor, 0))
  `);

  Object.assign(result, await createMapLifecycleService(db).autoPublishVerified({ routing }));
  return result;
}

async function nextWindow(db, now) {
  const saved = (await db.query('SELECT processed_until FROM geo_learning_state WHERE id = 1')).rows[0]?.processed_until;
  const from = saved ? new Date(new Date(saved).getTime() - OVERLAP_MINUTES * 60000) : new Date(now - FIRST_READ_HOURS * 3600000);
  return { from, until: new Date(Math.min(now, from.getTime() + (WINDOW_MINUTES + OVERLAP_MINUTES) * 60000)) };
}

/** Suggestions that never gained support, and old reports, do not stay forever. */
async function cleanUpOldCandidates(db) {
  const days = retentionDays();
  await db.query(`DELETE FROM candidate_roads WHERE status IN ('OBSERVED', 'CANDIDATE') AND updated_at < now() - make_interval(days => $1)`, [days]);
  await db.query(`DELETE FROM rider_map_reports WHERE status <> 'pending' AND created_at < now() - make_interval(days => $1)`, [days]);
  await db.query(`DELETE FROM rider_map_reports WHERE status = 'pending' AND created_at < now() - make_interval(days => $1)`, [days * 2]);
}
