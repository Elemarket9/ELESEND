import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { check } from '../../../security.mjs';
import { GHANA_BOUNDS } from '../ghana-geocoder.mjs';
import { haversine } from '../../../dispatch-geometry.mjs';

const reportSchema = z.object({
  shipmentId: z.string().uuid().optional().nullable(),
  reportType: z.enum([
    'missing_road', 'missing_landmark', 'wrong_coordinates', 'missing_junction',
    'incorrect_access', 'missing_community', 'incorrect_entrance', 'road_blocked',
    'temporary_reference_correction'
  ]),
  latitude: z.number().finite().min(GHANA_BOUNDS.minLatitude).max(GHANA_BOUNDS.maxLatitude),
  longitude: z.number().finite().min(GHANA_BOUNDS.minLongitude).max(GHANA_BOUNDS.maxLongitude),
  roadPathCoordinates: z.array(
    z.tuple([
      z.number().finite().min(GHANA_BOUNDS.minLongitude).max(GHANA_BOUNDS.maxLongitude),
      z.number().finite().min(GHANA_BOUNDS.minLatitude).max(GHANA_BOUNDS.maxLatitude)
    ])
  ).min(2).max(100).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  currentSpeedMps: z.number().finite().min(0).max(100).optional().nullable()
}).strict();

/**
 * Handles rider submission for "HELP IMPROVE ELESEND MAP" (Phase 5).
 * Enforces road motion safety: rider must be stationary (speed < 1.0 m/s) or report after delivery.
 * Server-side verified against actual GPS telemetry to prevent forged speed bypass.
 */
export async function submitRiderMapReport(db, actor, input) {
  check(actor && actor.id, 401, 'Rider authentication required');
  check(actor.kind === 'rider', 403, 'Rider account required');

  const validated = reportSchema.parse(input);

  // 1. Client-supplied speed check (fast rejection)
  if (validated.currentSpeedMps !== undefined && validated.currentSpeedMps !== null) {
    check(validated.currentSpeedMps < 1.0, 422, 'Cannot submit map reports while in motion. Please pull over safely.');
  }

  // 2. Server-side telemetry verification: prevents forged client speed bypass (Priority 4)
  if (db) {
    const riderState = await db.query(`
      SELECT status, observed_speed_mps, position_at FROM riders WHERE id = $1
    `, [actor.id]);

    check(riderState.rowCount > 0 && riderState.rows[0].status === 'approved', 403, 'Approved rider account required to submit map reports');

    if (validated.shipmentId) {
      const shipCheck = await db.query('SELECT rider_id FROM shipments WHERE id = $1', [validated.shipmentId]);
      check(shipCheck.rowCount > 0 && shipCheck.rows[0].rider_id === actor.id, 403, 'Rider is not assigned to the specified shipment');
    }

    if (riderState.rows.length > 0) {
      const { observed_speed_mps, position_at } = riderState.rows[0];
      const ageSeconds = position_at ? (Date.now() - new Date(position_at).getTime()) / 1000 : Infinity;
      if (ageSeconds >= 0 && ageSeconds < 45 && observed_speed_mps !== null && Number(observed_speed_mps) >= 1.0) {
        check(false, 422, 'Cannot submit map reports while in motion. Server telemetry indicates movement. Please pull over safely.');
      }
    }

    // Check recent location samples (within last 60 seconds) to compute independent speed
    const recentSamples = await db.query(`
      SELECT ST_Y(position::geometry) AS latitude,
             ST_X(position::geometry) AS longitude,
             observed_at
      FROM rider_location_samples
      WHERE rider_id = $1 AND observed_at > now() - interval '60 seconds'
      ORDER BY observed_at DESC
      LIMIT 2;
    `, [actor.id]);

    if (recentSamples.rows.length >= 2) {
      const pLatest = recentSamples.rows[0];
      const pPrev = recentSamples.rows[1];
      const elapsedSeconds = Math.max(1, (new Date(pLatest.observed_at).getTime() - new Date(pPrev.observed_at).getTime()) / 1000);
      const distMeters = haversine(
        { latitude: Number(pPrev.latitude), longitude: Number(pPrev.longitude) },
        { latitude: Number(pLatest.latitude), longitude: Number(pLatest.longitude) }
      );
      const serverSpeedMps = distMeters / elapsedSeconds;
      if (serverSpeedMps >= 1.0) {
        check(false, 422, 'Cannot submit map reports while in motion. Server telemetry indicates movement. Please pull over safely.');
      }
    }
  }

  // Rate limiting: max 10 reports per rider per 24h to prevent spam/abuse
  const countRecent = await db.query(`
    SELECT count(*)::int AS cnt
    FROM rider_map_reports
    WHERE rider_id = $1 AND created_at > now() - interval '24 hours'
  `, [actor.id]);

  check((countRecent.rows[0]?.cnt || 0) < 10, 429, 'Daily map feedback report limit reached. Thank you for contributing.');

  const reportId = randomUUID();

  // If a road path was traced by the rider, create LineString geography
  let lineGeoJson = null;
  if (validated.roadPathCoordinates && validated.roadPathCoordinates.length >= 2) {
    lineGeoJson = JSON.stringify({
      type: 'LineString',
      coordinates: validated.roadPathCoordinates
    });
  }

  const query = `
    INSERT INTO rider_map_reports (
      id, rider_id, shipment_id, report_type, location,
      road_geometry, notes, status
    ) VALUES (
      $1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography,
      CASE WHEN $7::text IS NOT NULL THEN ST_SetSRID(ST_GeomFromGeoJSON($7), 4326)::geography ELSE NULL END,
      $8, 'pending'
    )
    RETURNING id, rider_id, shipment_id, report_type, status, created_at,
              ST_Y(location::geometry) AS latitude,
              ST_X(location::geometry) AS longitude
  `;

  const values = [
    reportId,
    actor.id,
    validated.shipmentId || null,
    validated.reportType,
    validated.longitude,
    validated.latitude,
    lineGeoJson,
    validated.notes || null
  ];

  const res = await db.query(query, values);
  const row = res.rows[0];

  return {
    id: row.id,
    riderId: row.rider_id,
    shipmentId: row.shipment_id,
    reportType: row.report_type,
    status: row.status,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    createdAt: row.created_at,
    message: 'Report submitted successfully. Thank you for helping improve ELESEND maps!'
  };
}

/**
 * Returns available feedback categories for the mobile UI
 */
export function getRiderMapFeedbackCategories() {
  return [
    { key: 'missing_road', label: 'Missing Road / Street', icon: 'road' },
    { key: 'missing_landmark', label: 'Missing Business or Landmark', icon: 'map-marker-plus' },
    { key: 'wrong_coordinates', label: 'Incorrect Pin Location', icon: 'map-marker-alert' },
    { key: 'missing_junction', label: 'Unmapped Junction or Turn', icon: 'source-branch' },
    { key: 'incorrect_access', label: 'Gated / Blocked Access', icon: 'gate' },
    { key: 'missing_community', label: 'Missing Community or Neighborhood', icon: 'home-group' },
    { key: 'road_blocked', label: 'Road Temporarily Inaccessible', icon: 'barrier' }
  ];
}
