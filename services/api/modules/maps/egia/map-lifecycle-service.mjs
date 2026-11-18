import { verificationFailures, verificationRules } from './road-verification.mjs';
import { randomUUID } from 'node:crypto';
import { check } from '../../../shared/security.mjs';
import { isLikelyPrivateResidence } from './deduplicator.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireId = id => check(typeof id === 'string' && UUID_PATTERN.test(id), 400, 'Valid candidate id required');

async function lockVersionForRollback(c, versionTag, changeType, wrongTypeMessage) {
  const updateVer = (await c.query(`
    SELECT * FROM map_update_versions WHERE version_tag = $1 FOR UPDATE
  `, [versionTag])).rows[0];
  check(updateVer, 404, 'Map update version not found');
  check(updateVer.change_type === changeType, 409, wrongTypeMessage);
  check(!updateVer.rolled_back, 409, 'Update is already rolled back');
  return updateVer;
}

async function finishRollback(c, actor, updateVer, versionTag, label) {
  await c.query(`
    UPDATE map_update_versions
    SET rolled_back = true, rolled_back_at = now(), rolled_back_by = $1
    WHERE id = $2
  `, [actor.id, updateVer.id]);
  return {
    success: true,
    versionTag,
    featureId: updateVer.feature_id,
    status: 'RETIRED',
    rolledBack: true,
    message: `${label} update successfully rolled back`
  };
}

/**
 * Manages the publication lifecycle, approval, rollback and coverage audit for EGIA (Phases 7, 13 & Priority 2).
 */
const ROAD_VEHICLES = ['motorcycle', 'bicycle', 'tricycle', 'car', 'van', 'pickup', 'truck'];
const ALREADY_MAPPED_METERS = 15;

export function createMapLifecycleService(db) {

  async function requireAdmin(actor) {
    check(actor && actor.id, 401, 'Authentication required');
    check(actor.kind === 'admin', 403, 'Administrator access required');
    const perm = await db.query(`
      SELECT 1 FROM permissions 
      WHERE user_id = $1 AND permission IN ('maps:manage', 'maps:review', 'admin')
    `, [actor.id]);
    check(perm.rowCount > 0, 403, 'Map review permission required');
  }

  /**
   * Promotes an observed/corroborated road to PUBLISHED status with strict topology checks
   * and version audit trail (Priority 2).
   */
  async function publishRoad(actor, roadId, notes = '') {
    await requireAdmin(actor);
    requireId(roadId);
    return applyRoadPublish(roadId, { actorId: actor.id, notes });
  }

  /** actorId is null when the road passed automatic verification. */
  async function applyRoadPublish(roadId, { actorId, notes = '', automatic = false }) {
    return db.tx(async c => {
      const road = (await c.query(`SELECT * FROM candidate_roads WHERE id = $1 FOR UPDATE`, [roadId])).rows[0];
      check(road, 404, 'Candidate road not found');
      check(road.status !== 'PUBLISHED', 409, 'Road is already published');
      check(!['REJECTED', 'RETIRED'].includes(road.status), 409, 'Rejected or retired roads cannot be published');

      // Topology & geometry validation checks (Priority 2)
      const topo = (await c.query(`
        SELECT ST_IsValid(corridor::geometry) AS is_valid,
               ST_NPoints(corridor::geometry) AS num_points,
               ST_Length(corridor) AS length_m
        FROM candidate_roads WHERE id = $1
      `, [roadId])).rows[0];

      check(topo && topo.is_valid, 422, 'Topology error: Candidate road corridor geometry is invalid');
      check(Number(topo.num_points) >= 2, 422, 'Topology error: Candidate road requires at least 2 coordinate points');
      check(Number(topo.length_m) >= 20, 422, 'Topology error: Candidate road must be at least 20 meters long');

      // Vehicle accessibility validation
      const allowed = Array.isArray(road.allowed_vehicles) ? road.allowed_vehicles : ['motorcycle'];
      const validVehicles = ROAD_VEHICLES;
      check(allowed.length > 0 && allowed.every(v => validVehicles.includes(v)), 422, 'Candidate road must define valid vehicle accessibility');

      // Multi-rider corroboration or explicit administrator verification note requirement
      if (road.status === 'OBSERVED' && Number(road.distinct_riders) < 2) {
        check(notes && notes.trim().length >= 5, 422, 'Road with only single-rider observation requires corroboration or explicit verification notes');
      }

      // Keep nothing here that identifies the riders who found the road.
      const { contributor_rider_ids: _riders, ...publicRoad } = road;
      const previousState = { ...publicRoad };
      const newVersion = road.version + 1;
      const versionTag = `road-pub-${road.id.slice(0, 8)}-v${newVersion}`;

      await c.query(`
        UPDATE candidate_roads 
        SET status = 'PUBLISHED', version = $2, review_notes = $3, reviewer_id = $4, published_automatically = $5,
            contributor_rider_ids = '{}', updated_at = now()
        WHERE id = $1
      `, [roadId, newVersion, notes, actorId, automatic]);

      await c.query(`
        INSERT INTO map_update_versions (
          version_tag, change_type, feature_id, previous_state, new_state, published_by
        ) VALUES ($1, 'road_publish', $2, $3, $4, $5)
      `, [
        versionTag,
        roadId,
        JSON.stringify(previousState),
        JSON.stringify({ ...publicRoad, status: 'PUBLISHED', version: newVersion, published_automatically: automatic }),
        actorId
      ]);

      return {
        success: true,
        versionTag,
        roadId,
        status: 'PUBLISHED',
        version: newVersion,
        message: 'Road published successfully to routing network'
      };
    });
  }

  /**
   * Rolls back a published road change to RETIRED state atomically (Priority 2)
   */
  async function rollbackRoad(actor, versionTag) {
    await requireAdmin(actor);
    check(typeof versionTag === 'string' && versionTag.length > 0, 400, 'Version tag required');

    return db.tx(async c => {
      const updateVer = await lockVersionForRollback(c, versionTag, 'road_publish', 'This version is not a road update');

      await c.query(`
        UPDATE candidate_roads
        SET status = 'RETIRED', updated_at = now()
        WHERE id = $1
      `, [updateVer.feature_id]);

      return finishRollback(c, actor, updateVer, versionTag, 'Road');
    });
  }

  /**
   * Approves and publishes a candidate landmark into production spatial_landmarks
   */
  async function publishLandmark(actor, landmarkId, notes = '') {
    await requireAdmin(actor);
    requireId(landmarkId);
    return applyLandmarkPublish(landmarkId, { actorId: actor.id });
  }

  async function applyLandmarkPublish(landmarkId, { actorId, automatic = false }) {
    return db.tx(async c => {
      const cand = (await c.query(`SELECT * FROM candidate_landmarks WHERE id = $1 FOR UPDATE`, [landmarkId])).rows[0];
      check(cand, 404, 'Candidate landmark not found');
      check(cand.verification_status !== 'PUBLISHED', 409, 'Landmark is already published');
      check(!['REJECTED', 'RETIRED'].includes(cand.verification_status), 409, 'Rejected or retired landmarks cannot be published');
      check(!cand.is_private && !isLikelyPrivateResidence(cand.name), 422, 'Private residence cannot be published to public map');

      const versionTag = `lmk-pub-${cand.id.slice(0, 8)}-${Date.now()}`;

      await c.query(`
        UPDATE candidate_landmarks
        SET verification_status = 'PUBLISHED', reviewer_id = $2, published_automatically = $3, updated_at = now()
        WHERE id = $1
      `, [landmarkId, actorId, automatic]);

      // Copy verified candidate to public spatial_landmarks table
      await c.query(`
        INSERT INTO spatial_landmarks (
          id, name, search_name, category, subcategory, region, locality, city,
          latitude, longitude, geom, source, source_id, license, verification_status
        )
        SELECT id::text, name, search_name, category, subcategory, region, locality, city,
               ST_Y(location::geometry), ST_X(location::geometry), location,
               source, source_id, license, 'community_verified'
        FROM candidate_landmarks
        WHERE id = $1
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          verification_status = 'community_verified',
          updated_at = now()
      `, [landmarkId]);

      await c.query(`
        INSERT INTO map_update_versions (
          version_tag, change_type, feature_id, previous_state, new_state, published_by
        ) VALUES ($1, 'landmark_publish', $2, $3, $4, $5)
      `, [
        versionTag,
        landmarkId,
        JSON.stringify(cand),
        JSON.stringify({ ...cand, verification_status: 'PUBLISHED', published_automatically: automatic }),
        actorId
      ]);

      return {
        success: true,
        versionTag,
        landmarkId,
        verificationStatus: 'PUBLISHED',
        message: 'Landmark approved and published to public map'
      };
    });
  }

  /**
   * Rolls back a published landmark change
   */
  async function rollbackLandmark(actor, versionTag) {
    await requireAdmin(actor);
    check(typeof versionTag === 'string' && versionTag.length > 0, 400, 'Version tag required');

    return db.tx(async c => {
      const updateVer = await lockVersionForRollback(c, versionTag, 'landmark_publish', 'This version is not a landmark update');

      await c.query(`
        UPDATE candidate_landmarks
        SET verification_status = 'RETIRED', updated_at = now()
        WHERE id = $1
      `, [updateVer.feature_id]);

      // Remove from active spatial_landmarks
      await c.query(`DELETE FROM spatial_landmarks WHERE id = $1`, [updateVer.feature_id]);

      return finishRollback(c, actor, updateVer, versionTag, 'Landmark');
    });
  }

  /**
   * Retrieves review queue for administrators
   */
  async function getReviewQueue(actor) {
    await requireAdmin(actor);

    const pendingRoads = await db.query(`
      SELECT id, name, status, confidence, observation_count, distinct_riders,
             allowed_vehicles, surface_type, created_at,
             temporal_span_seconds, bidirectional, mean_accuracy_m,
             is_one_way, max_speed_kmh, is_private_access, is_pedestrian_only, imagery_supported,
             ST_Length(corridor) AS length_m,
             ST_AsGeoJSON(corridor::geometry) AS corridor_geojson
      FROM candidate_roads
      WHERE status IN ('OBSERVED', 'CORROBORATED', 'REVIEW_REQUIRED')
      ORDER BY status = 'CORROBORATED' DESC, imagery_supported DESC, confidence DESC, observation_count DESC
      LIMIT 50;
    `);
    const recentlyPublished = await db.query(`
      SELECT v.version_tag, v.change_type, v.feature_id, v.created_at,
             v.new_state->>'name' AS name,
             COALESCE((v.new_state->>'published_automatically')::boolean, false) AS automatic
      FROM map_update_versions v
      WHERE v.change_type IN ('road_publish', 'landmark_publish') AND v.rolled_back = false
      ORDER BY v.created_at DESC
      LIMIT 30;
    `);
    const changeAreas = await db.query(`
      SELECT s.area_name, s.scanned_at, s.outcome, s.changed_cells FROM map_change_scans s ORDER BY s.area_name
    `);

    const pendingLandmarks = await db.query(`
      SELECT id, name, category, region, locality, city, confidence,
             verification_status, source, created_at,
             ST_Y(location::geometry) AS latitude,
             ST_X(location::geometry) AS longitude
      FROM candidate_landmarks
      WHERE verification_status IN ('OBSERVED', 'CORROBORATED', 'REVIEW_REQUIRED')
      ORDER BY confidence DESC
      LIMIT 20;
    `);

    const recentReports = await db.query(`
      SELECT id, rider_id, report_type, notes, status, created_at,
             ST_Y(location::geometry) AS latitude,
             ST_X(location::geometry) AS longitude
      FROM rider_map_reports
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT 20;
    `);

    const rules = verificationRules();
    return {
      autoPublish: rules,
      recentlyPublished: recentlyPublished.rows,
      imageryScans: changeAreas.rows,
      candidateRoads: pendingRoads.rows,
      candidateLandmarks: pendingLandmarks.rows,
      pendingReports: recentReports.rows
    };
  }

  /**
   * Generates a 16-region geographic coverage scorecard
   */
  async function getCoverageScorecard(actor) {
    await requireAdmin(actor);

    const GHANA_16_REGIONS = [
      'Greater Accra', 'Ashanti', 'Central', 'Eastern', 'Ahafo', 'Bono',
      'Bono East', 'Northern', 'Savannah', 'North East', 'Upper East', 'Upper West',
      'Volta', 'Oti', 'Western', 'Western North'
    ];

    // Query both spatial_landmarks and national_businesses via searchable view
    let dbRows = [];
    try {
      const res = await db.query(`
        SELECT region, count(*)::int AS landmark_count
        FROM searchable_landmarks_v9
        GROUP BY region
      `);
      dbRows = res.rows;
    } catch {
      const res = await db.query(`
        SELECT region, count(*)::int AS landmark_count
        FROM spatial_landmarks
        GROUP BY region
      `);
      dbRows = res.rows;
    }

    const counts = {};
    for (const r of dbRows) {
      counts[r.region] = r.landmark_count;
    }

    const scorecard = GHANA_16_REGIONS.map(reg => {
      const count = counts[reg] || 0;
      let coverageTier = 'Sparse';
      if (count > 5000) coverageTier = 'Dense (Urban Prime)';
      else if (count > 1000) coverageTier = 'Established (Regional Hub)';
      else if (count > 50) coverageTier = 'Developing';

      return {
        region: reg,
        landmarksCount: count,
        coverageTier,
        informalGeocodingActive: true,
        riderFeedbackActive: true
      };
    });

    const totalCount = scorecard.reduce((sum, s) => sum + s.landmarksCount, 0);

    return {
      totalMappedLocations: totalCount,
      regionsTracked: 16,
      scorecard
    };
  }

  /**
   * Returns comprehensive admin dashboard payload with summary and regional scorecard
   */
  async function getAdminGeoDashboard(actor) {
    await requireAdmin(actor);
    const res = await getCoverageScorecard(actor);
    return {
      summary: {
        totalMappedLocations: res.totalMappedLocations,
        regionsTracked: res.regionsTracked
      },
      regionalScorecard: res.scorecard
    };
  }

  /**
   * Rejects a candidate road or landmark so it cannot be published without re-review.
   * Body: { type: 'road'|'landmark', id: uuid, notes?: string }
   */
  /** Details only people can judge. A private or pedestrian road never publishes itself. */
  async function updateRoadDetails(actor, body = {}) {
    await requireAdmin(actor);
    const id = body?.roadId;
    requireId(id);
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : null;
    const vehicles = Array.isArray(body.allowedVehicles) ? body.allowedVehicles : null;
    if (vehicles) check(vehicles.length > 0 && vehicles.every(v => ROAD_VEHICLES.includes(v)), 422, 'Choose valid vehicles');
    const updated = await db.query(`
      UPDATE candidate_roads SET
        name = COALESCE(NULLIF($2, ''), name),
        is_private_access = COALESCE($3, is_private_access),
        is_pedestrian_only = COALESCE($4, is_pedestrian_only),
        is_one_way = COALESCE($5, is_one_way),
        allowed_vehicles = COALESCE($6, allowed_vehicles),
        updated_at = now()
      WHERE id = $1 AND status NOT IN ('PUBLISHED', 'REJECTED', 'RETIRED')
    `, [id, name, typeof body.isPrivateAccess === 'boolean' ? body.isPrivateAccess : null, typeof body.isPedestrianOnly === 'boolean' ? body.isPedestrianOnly : null, typeof body.isOneWay === 'boolean' ? body.isOneWay : null, vehicles]);
    check(updated.rowCount > 0, 409, 'This road can no longer be changed');
    return { success: true, roadId: id };
  }

  /** Publishes confirmed roads that pass every check, and retires ones the base map now has. */
  async function autoPublishVerified({ routing = null, rules = verificationRules() } = {}) {
    const outcome = { roadsPublished: 0, roadsAlreadyMapped: 0, landmarksPublished: 0 };
    if (!rules.enabled) return outcome;
    if (typeof routing?.nearestRoadMeters === 'function') {
      const roads = (await db.query(`
        SELECT id, name, status, confidence, distinct_riders, temporal_span_seconds, mean_accuracy_m, is_private_access,
               is_pedestrian_only, imagery_supported, allowed_vehicles,
               ST_IsValid(corridor::geometry) AS is_valid, ST_Length(corridor) AS length_m,
               ST_Y(ST_StartPoint(corridor::geometry)) AS start_lat, ST_X(ST_StartPoint(corridor::geometry)) AS start_lon,
               ST_Y(ST_EndPoint(corridor::geometry)) AS end_lat, ST_X(ST_EndPoint(corridor::geometry)) AS end_lon,
               ST_Y(ST_LineInterpolatePoint(corridor::geometry, 0.5)) AS mid_lat, ST_X(ST_LineInterpolatePoint(corridor::geometry, 0.5)) AS mid_lon
        FROM candidate_roads WHERE status = 'CORROBORATED' ORDER BY confidence DESC LIMIT 100
      `)).rows.filter(road => road.status === 'CORROBORATED');
      for (const road of roads) {
        const vehicle = (road.allowed_vehicles || []).includes('motorcycle') ? 'motorcycle' : road.allowed_vehicles?.[0];
        let distances;
        try {
          distances = [];
          for (const [latitude, longitude] of [[road.start_lat, road.start_lon], [road.mid_lat, road.mid_lon], [road.end_lat, road.end_lon]]) {
            distances.push(await routing.nearestRoadMeters({ latitude: Number(latitude), longitude: Number(longitude) }, { vehicle }));
          }
        } catch {
          continue; // Road data unavailable: decide next time.
        }
        if (Math.max(...distances) <= ALREADY_MAPPED_METERS) {
          await db.query(`UPDATE candidate_roads SET status = 'RETIRED', review_notes = 'Now on the base map', contributor_rider_ids = '{}', updated_at = now() WHERE id = $1 AND status = 'CORROBORATED'`, [road.id]);
          outcome.roadsAlreadyMapped += 1;
          continue;
        }
        const failures = verificationFailures({ ...road, join_meters: Math.min(distances[0], distances[2]) }, rules);
        if (failures.length) continue;
        try {
          await applyRoadPublish(road.id, { actorId: null, automatic: true, notes: 'Published automatically after passing verification' });
          outcome.roadsPublished += 1;
        } catch {
          // One road that cannot publish must not hold up the others. It stays in map review.
        }
      }
    }
    // A name stays private until three different riders independently give the same one at the same place.
    const landmarks = (await db.query(`
      SELECT c.id FROM candidate_landmarks c
      WHERE c.verification_status = 'CORROBORATED' AND c.source = 'rider_corroboration' AND COALESCE(c.is_private, false) = false
        AND (SELECT count(DISTINCT r.rider_id) FROM rider_map_reports r
             WHERE r.report_type = 'missing_landmark' AND lower(trim(r.notes)) = lower(trim(c.name)) AND ST_DWithin(r.location, c.location, 50)) >= $1
      LIMIT 50
    `, [rules.minRiders])).rows;
    for (const { id } of landmarks) {
      try {
        await applyLandmarkPublish(id, { actorId: null, automatic: true });
        outcome.landmarksPublished += 1;
      } catch {
        // It stays in map review.
      }
    }
    return outcome;
  }

  async function rejectCandidate(actor, body = {}) {
    await requireAdmin(actor);
    const type = String(body?.type || '').toLowerCase();
    const id = body?.id || body?.roadId || body?.landmarkId;
    const notes = typeof body?.notes === 'string' ? body.notes.trim() : '';
    requireId(id);
    check(type === 'road' || type === 'landmark', 400, 'type must be road or landmark');

    return db.tx(async c => {
      if (type === 'road') {
        const road = (await c.query(`SELECT * FROM candidate_roads WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        check(road, 404, 'Candidate road not found');
        check(road.status !== 'PUBLISHED', 409, 'Published roads must be rolled back, not rejected');
        check(road.status !== 'REJECTED', 409, 'Road is already rejected');
        await c.query(`
          UPDATE candidate_roads
          SET status = 'REJECTED', review_notes = $2, reviewer_id = $3, updated_at = now()
          WHERE id = $1
        `, [id, notes || 'Rejected by administrator', actor.id]);
        return { success: true, type: 'road', id, status: 'REJECTED' };
      }

      const cand = (await c.query(`SELECT * FROM candidate_landmarks WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      check(cand, 404, 'Candidate landmark not found');
      check(cand.verification_status !== 'PUBLISHED', 409, 'Published landmarks must be rolled back, not rejected');
      check(cand.verification_status !== 'REJECTED', 409, 'Landmark is already rejected');
      await c.query(`
        UPDATE candidate_landmarks
        SET verification_status = 'REJECTED', reviewer_id = $2, updated_at = now()
        WHERE id = $1
      `, [id, actor.id]);
      return { success: true, type: 'landmark', id, status: 'REJECTED' };
    });
  }

  return {
    publishRoad,
    rollbackRoad,
    publishLandmark,
    rollbackLandmark,
    rejectCandidate,
    updateRoadDetails,
    autoPublishVerified,
    getReviewQueue,
    getCoverageScorecard,
    getAdminGeoDashboard
  };
}
