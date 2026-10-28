import { sanitizeTrajectory, extractCandidateRoadCorridor } from './gps-quality-filter.mjs';
import { validatePublicLandmarkCandidate, deduplicateLandmark } from './deduplicator.mjs';
import { calculateBearing, angleDifference } from './unmapped-navigation.mjs';
import { randomUUID } from 'node:crypto';

/**
 * Continuous Geographic Learning Runner (EGIA Phase 11 & Priority 1 & 3).
 * Executes periodically without blocking customer orders or payments.
 * Connects rider GPS trajectories, multi-factor corroboration (provenance, temporal spread,
 * bidirectional flow, mean accuracy), and evidence-based candidate road/landmark promotion.
 */
export async function runGeographicLearningCycle(db) {
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
    LIMIT 10;
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
        const dedup = await deduplicateLandmark(db, candidateObj);
        if (!dedup.isDuplicate) {
          await db.query(`
            INSERT INTO candidate_landmarks (
              id, name, search_name, category, region, locality, city,
              location, confidence, source, verification_status
            ) VALUES (
              $1, $2, $3, $4, 'Greater Accra', 'Discovered', 'Ghana',
              ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, 65, 'rider_corroboration', 'CORROBORATED'
            )
            ON CONFLICT DO NOTHING
          `, [
            randomUUID(),
            candidateObj.name,
            candidateObj.name.toLowerCase(),
            val.category,
            candidateObj.longitude,
            candidateObj.latitude
          ]);

          result.landmarksCorroborated++;
        }
      }
    } else if (rep.report_type === 'missing_road' && rep.road_geojson) {
      // Missing road reported by multiple independent riders
      const roadId = randomUUID();
      const insertRoad = await db.query(`
        INSERT INTO candidate_roads (
          id, name, corridor, status, confidence, observation_count, distinct_riders, source
        ) VALUES (
          $1, 'Rider Reported Road', ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)::geography,
          'CORROBORATED', 65, 2, 2, 'rider_corroborated_report'
        )
        ON CONFLICT DO NOTHING
      `, [roadId, rep.road_geojson]);
      if (insertRoad.rowCount > 0) {
        result.roadsCorroborated++;
      }
    }

    await db.query(`UPDATE rider_map_reports SET status = 'corroborated' WHERE id = $1`, [rep.id]);
    result.reportsProcessed++;
  }

  // 2. Discover and corroborate candidate roads from off-road rider trajectories (Priority 3 Hardened)
  const riderSamples = await db.query(`
    SELECT rider_id, array_agg(jsonb_build_object(
      'latitude', ST_Y(position::geometry),
      'longitude', ST_X(position::geometry),
      'accuracyMeters', accuracy_m,
      'observedAt', observed_at
    ) ORDER BY observed_at ASC) AS samples
    FROM rider_location_samples
    WHERE observed_at > now() - interval '6 hours'
    GROUP BY rider_id
    HAVING count(*) >= 4
    ORDER BY max(observed_at) DESC
    LIMIT 20;
  `);

  for (const row of riderSamples.rows) {
    const clean = sanitizeTrajectory(row.samples);
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

      // Check if an existing candidate road exists within 35 meters
      const existingRoad = await db.query(`
        SELECT id, status, confidence, observation_count, distinct_riders,
               created_at, updated_at, temporal_span_seconds, bidirectional,
               mean_accuracy_m, is_private_access,
               ST_AsGeoJSON(corridor::geometry) AS existing_geojson
        FROM candidate_roads
        WHERE ST_DWithin(corridor, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, 35)
        ORDER BY ST_Distance(corridor, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography) ASC
        LIMIT 1;
      `, [lineGeoJson]);

      if (existingRoad.rows.length > 0) {
        const cur = existingRoad.rows[0];

        // Temporal separation check: Time elapsed between previous observations and current
        const lastUpdated = new Date(cur.updated_at || cur.created_at).getTime();
        const timeDeltaSeconds = Math.max(1, Math.round(Math.abs(latestObsTime - lastUpdated) / 1000));
        const cumulativeSpan = (cur.temporal_span_seconds || 0) + timeDeltaSeconds;

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
        const combinedMeanAcc = ((cur.mean_accuracy_m || 10) + meanAcc) / 2;

        // Multi-Factor Evidence-Based Confidence Scoring (Priority 3)
        let calcConfidence = 30 + (newDistinctRiders * 15) + (Math.min(corridor.pointCount, 10) * 2);
        if (isBidirectional) calcConfidence += 15;
        if (combinedMeanAcc > 15.0) calcConfidence -= 10;
        const newConfidence = Math.min(95, Math.max(30, calcConfidence));

        // Corroboration threshold: Requires distinct riders, reasonable accuracy, and non-private status
        const canCorroborate = newDistinctRiders >= 2 &&
                               combinedMeanAcc <= 20.0 &&
                               !cur.is_private_access &&
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
              updated_at = now()
          WHERE id = $1
        `, [cur.id, newObsCount, newDistinctRiders, newConfidence, newStatus, cumulativeSpan, isBidirectional, combinedMeanAcc]);

        if (newStatus === 'CORROBORATED' && cur.status !== 'CORROBORATED') {
          result.roadsCorroborated++;
        }
      } else {
        // First observation of an unmapped corridor
        const roadId = randomUUID();
        await db.query(`
          INSERT INTO candidate_roads (
            id, name, corridor, status, confidence, observation_count, distinct_riders,
            mean_accuracy_m, source
          ) VALUES (
            $1, 'Discovered Road Segment', ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)::geography,
            'OBSERVED', 35, $3, 1, $4, 'rider_gps_cluster'
          )
          ON CONFLICT DO NOTHING
        `, [roadId, lineGeoJson, corridor.pointCount, meanAcc]);

        result.roadsDiscovered++;
      }
    }
  }

  return result;
}
