import { randomUUID } from 'node:crypto';
import { check } from '../../../security.mjs';

/**
 * Manages the publication lifecycle, approval, rollback and coverage audit for EGIA (Phases 7, 13 & Priority 2).
 */
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

    return db.tx(async c => {
      const road = (await c.query(`SELECT * FROM candidate_roads WHERE id = $1 FOR UPDATE`, [roadId])).rows[0];
      check(road, 404, 'Candidate road not found');
      check(road.status !== 'PUBLISHED', 409, 'Road is already published');

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
      const validVehicles = ['motorcycle', 'bicycle', 'tricycle', 'car', 'van', 'pickup', 'truck'];
      check(allowed.length > 0 && allowed.every(v => validVehicles.includes(v)), 422, 'Candidate road must define valid vehicle accessibility');

      // Multi-rider corroboration or explicit administrator verification note requirement
      if (road.status === 'OBSERVED' && Number(road.distinct_riders) < 2) {
        check(notes && notes.trim().length >= 5, 422, 'Road with only single-rider observation requires corroboration or explicit verification notes');
      }

      const previousState = { ...road };
      const newVersion = road.version + 1;
      const versionTag = `road-pub-${road.id.slice(0, 8)}-v${newVersion}`;

      await c.query(`
        UPDATE candidate_roads 
        SET status = 'PUBLISHED', version = $2, review_notes = $3, reviewer_id = $4, updated_at = now()
        WHERE id = $1
      `, [roadId, newVersion, notes, actor.id]);

      await c.query(`
        INSERT INTO map_update_versions (
          version_tag, change_type, feature_id, previous_state, new_state, published_by
        ) VALUES ($1, 'road_publish', $2, $3, $4, $5)
      `, [
        versionTag,
        roadId,
        JSON.stringify(previousState),
        JSON.stringify({ ...road, status: 'PUBLISHED', version: newVersion }),
        actor.id
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

    return db.tx(async c => {
      const updateVer = (await c.query(`
        SELECT * FROM map_update_versions WHERE version_tag = $1 FOR UPDATE
      `, [versionTag])).rows[0];
      check(updateVer, 404, 'Map update version not found');
      check(!updateVer.rolled_back, 409, 'Update is already rolled back');

      await c.query(`
        UPDATE candidate_roads
        SET status = 'RETIRED', updated_at = now()
        WHERE id = $1
      `, [updateVer.feature_id]);

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
        message: 'Road update successfully rolled back'
      };
    });
  }

  /**
   * Approves and publishes a candidate landmark into production spatial_landmarks
   */
  async function publishLandmark(actor, landmarkId, notes = '') {
    await requireAdmin(actor);

    return db.tx(async c => {
      const cand = (await c.query(`SELECT * FROM candidate_landmarks WHERE id = $1 FOR UPDATE`, [landmarkId])).rows[0];
      check(cand, 404, 'Candidate landmark not found');
      check(cand.verification_status !== 'PUBLISHED', 409, 'Landmark is already published');
      check(!cand.is_private, 422, 'Private residence cannot be published to public map');

      const versionTag = `lmk-pub-${cand.id.slice(0, 8)}-${Date.now()}`;

      await c.query(`
        UPDATE candidate_landmarks
        SET verification_status = 'PUBLISHED', reviewer_id = $2, updated_at = now()
        WHERE id = $1
      `, [landmarkId, actor.id]);

      // Copy verified candidate to public spatial_landmarks table
      await c.query(`
        INSERT INTO spatial_landmarks (
          id, name, search_name, category, subcategory, region, locality, city,
          latitude, longitude, geom, source, source_id, license, verification_status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          ST_Y(location::geometry), ST_X(location::geometry), location,
          $9, $10, $11, 'community_verified'
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          verification_status = 'community_verified',
          updated_at = now()
      `, [
        cand.id, cand.name, cand.search_name, cand.category, cand.subcategory,
        cand.region, cand.locality, cand.city,
        cand.source, cand.source_id, cand.license
      ]);

      await c.query(`
        INSERT INTO map_update_versions (
          version_tag, change_type, feature_id, previous_state, new_state, published_by
        ) VALUES ($1, 'landmark_publish', $2, $3, $4, $5)
      `, [
        versionTag,
        landmarkId,
        JSON.stringify(cand),
        JSON.stringify({ ...cand, verification_status: 'PUBLISHED' }),
        actor.id
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

    return db.tx(async c => {
      const updateVer = (await c.query(`
        SELECT * FROM map_update_versions WHERE version_tag = $1 FOR UPDATE
      `, [versionTag])).rows[0];
      check(updateVer, 404, 'Map update version not found');
      check(!updateVer.rolled_back, 409, 'Update is already rolled back');

      await c.query(`
        UPDATE candidate_landmarks
        SET verification_status = 'RETIRED', updated_at = now()
        WHERE id = $1
      `, [updateVer.feature_id]);

      // Remove from active spatial_landmarks
      await c.query(`DELETE FROM spatial_landmarks WHERE id = $1`, [updateVer.feature_id]);

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
        message: 'Landmark update successfully rolled back'
      };
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
             is_one_way, max_speed_kmh, is_private_access,
             ST_AsGeoJSON(corridor::geometry) AS corridor_geojson
      FROM candidate_roads
      WHERE status IN ('OBSERVED', 'CORROBORATED', 'REVIEW_REQUIRED')
      ORDER BY confidence DESC, observation_count DESC
      LIMIT 20;
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

    return {
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
  async function rejectCandidate(actor, body = {}) {
    await requireAdmin(actor);
    const type = String(body?.type || '').toLowerCase();
    const id = body?.id || body?.roadId || body?.landmarkId;
    const notes = typeof body?.notes === 'string' ? body.notes.trim() : '';
    check(id && typeof id === 'string', 400, 'Candidate id required');
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
    getReviewQueue,
    getCoverageScorecard,
    getAdminGeoDashboard
  };
}
