import { haversine } from '../../../dispatch-geometry.mjs';

/**
 * Calculates compass cardinal direction from bearing in degrees (0 - 360)
 */
export function bearingToCardinal(deg) {
  const cardinals = [
    'North', 'North-Northeast', 'Northeast', 'East-Northeast',
    'East', 'East-Southeast', 'Southeast', 'South-Southeast',
    'South', 'South-Southwest', 'Southwest', 'West-Southwest',
    'West', 'West-Northwest', 'Northwest', 'North-Northwest'
  ];
  const index = Math.round(((deg % 360) / 22.5)) % 16;
  return cardinals[index];
}

/**
 * Calculates bearing from point A to point B in degrees
 */
export function calculateBearing(lat1, lon1, lat2, lon2) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.cos(φ1) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);

  return ((θ * 180) / Math.PI + 360) % 360;
}

/**
 * Normalizes angular difference between two bearings (-180 to +180)
 */
export function angleDifference(b1, b2) {
  let diff = (b2 - b1 + 180) % 360 - 180;
  return diff < -180 ? diff + 360 : diff;
}

/**
 * Builds composite navigation instructions for destinations in unmapped communities (Phase 10 & Priority 2).
 * Supports dual-layer graph routing: connects standard road network (OSRM) with verified
 * published candidate road corridors, handles geometry stitching, vehicle restrictions,
 * one-way enforcement, multi-segment intersections, and turn-by-turn guidance.
 */
export async function buildUnmappedCommunityRoute({
  routingAdapter,
  riderPosition,
  confirmedDestination,
  vehicle = 'motorcycle',
  db = null
}) {
  const destPoint = {
    latitude: Number(confirmedDestination.latitude),
    longitude: Number(confirmedDestination.longitude)
  };

  // 1. Calculate road route using existing routing adapter
  let roadRoute = null;
  if (routingAdapter) {
    try {
      roadRoute = await routingAdapter.route(
        riderPosition,
        destPoint,
        { vehicle }
      );
    } catch (err) {
      // Direct routing failed (e.g. point off road network)
      roadRoute = null;
    }
  }

  // 2. Extract road network endpoint and geometry
  let roadEndpoint = destPoint;
  let roadDistanceMeters = 0;
  let roadDurationSeconds = 0;
  let baseCoordinates = [];

  if (roadRoute && roadRoute.distanceMeters !== undefined) {
    roadDistanceMeters = roadRoute.distanceMeters;
    roadDurationSeconds = roadRoute.durationSeconds;
    
    if (roadRoute.geometry && Array.isArray(roadRoute.geometry.coordinates) && roadRoute.geometry.coordinates.length > 0) {
      baseCoordinates = roadRoute.geometry.coordinates;
      const lastCoord = baseCoordinates[baseCoordinates.length - 1];
      roadEndpoint = {
        latitude: lastCoord[1],
        longitude: lastCoord[0]
      };
    }
  }

  // 3. Dual-Layer Graph Routing: Discover and stitch published candidate roads from PostgreSQL
  const candidateSegmentsUsed = [];
  let effectiveRoadEndpoint = roadEndpoint;
  let totalCandidateRoadMeters = 0;
  let totalCandidateRoadSeconds = 0;
  const stitchedCoordinates = [...baseCoordinates];
  const turnInstructions = [];

  if (roadRoute && roadDistanceMeters > 0) {
    turnInstructions.push({
      step: 1,
      type: 'follow_mapped_road',
      text: `Follow mapped road network to terminus (${roadDistanceMeters}m)`,
      distanceMeters: roadDistanceMeters,
      durationSeconds: roadDurationSeconds
    });
  }

  if (db) {
    try {
      // Find candidate roads that either:
      // a) Connect to the mapped road network terminus (<= 50m)
      // b) Are near the destination (<= 200m)
      const pubRoads = await db.query(`
        SELECT id, name, allowed_vehicles, is_one_way, one_way_bearing, max_speed_kmh,
               is_pedestrian_only, is_private_access, surface_type,
               ST_Length(corridor) AS length_m,
               ST_Distance(corridor, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS dist_from_endpoint_m,
               ST_Distance(corridor, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) AS dist_to_dest_m,
               ST_AsGeoJSON(corridor::geometry) AS geojson
        FROM candidate_roads
        WHERE status = 'PUBLISHED'
          AND is_private_access = false
          AND (
            ST_DWithin(corridor, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 50)
            OR ST_DWithin(corridor, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 200)
          )
        ORDER BY dist_to_dest_m ASC
        LIMIT 5;
      `, [roadEndpoint.longitude, roadEndpoint.latitude, destPoint.longitude, destPoint.latitude]);

      for (const r of pubRoads.rows) {
        // Vehicle restriction enforcement
        const allowedVehicles = Array.isArray(r.allowed_vehicles) ? r.allowed_vehicles : ['motorcycle'];
        if (!allowedVehicles.includes(vehicle)) {
          continue; // Incompatible vehicle type (e.g. car on motorcycle-only path)
        }
        if (r.is_pedestrian_only && vehicle !== 'foot') {
          continue; // Pedestrian only path
        }

        const geo = JSON.parse(r.geojson);
        const coords = geo.coordinates; // [[lon, lat], ...]
        if (!Array.isArray(coords) || coords.length < 2) continue;

        const firstPt = { latitude: coords[0][1], longitude: coords[0][0] };
        const lastPt = { latitude: coords[coords.length - 1][1], longitude: coords[coords.length - 1][0] };

        // Determine traversal direction: start from whichever point is closer to current road endpoint
        const distFromFirst = haversine(effectiveRoadEndpoint, firstPt);
        const distFromLast = haversine(effectiveRoadEndpoint, lastPt);
        const forward = distFromFirst <= distFromLast;

        const entryPt = forward ? firstPt : lastPt;
        const exitPt = forward ? lastPt : firstPt;

        // Snapping / continuity validation: Must connect within 50m of current endpoint
        const snapDist = Math.min(distFromFirst, distFromLast);
        if (snapDist > 50 && candidateSegmentsUsed.length === 0) {
          // Disconnected floating line cannot be traversed from road network
          continue;
        }

        // One-way direction check
        if (r.is_one_way && r.one_way_bearing !== null) {
          const traversalBearing = calculateBearing(entryPt.latitude, entryPt.longitude, exitPt.latitude, exitPt.longitude);
          const angleDiff = Math.abs(angleDifference(traversalBearing, Number(r.one_way_bearing)));
          if (angleDiff > 90) {
            continue; // Traversing opposite to one-way flow
          }
        }

        // Order coordinates in traversal direction
        const orderedCoords = forward ? [...coords] : [...coords].reverse();

        const lengthM = Math.round(Number(r.length_m));
        const speedKmh = r.max_speed_kmh || 30;
        const speedMps = (speedKmh * 1000) / 3600;
        const durationSec = Math.max(1, Math.round(lengthM / speedMps));

        totalCandidateRoadMeters += lengthM;
        totalCandidateRoadSeconds += durationSec;
        effectiveRoadEndpoint = exitPt;

        candidateSegmentsUsed.push({
          id: r.id,
          name: r.name || 'Verified Community Road',
          lengthMeters: lengthM,
          surfaceType: r.surface_type || 'unpaved',
          maxSpeedKmh: speedKmh,
          allowedVehicles,
          snapDistanceMeters: Math.round(snapDist),
          entryPoint: entryPt,
          exitPoint: exitPt
        });

        // Append to stitched route geometry
        for (const pt of orderedCoords) {
          stitchedCoordinates.push(pt);
        }

        turnInstructions.push({
          step: turnInstructions.length + 1,
          type: 'turn_onto_candidate_road',
          text: `Turn onto verified corridor '${r.name || 'Community Road'}' (${r.surface_type || 'unpaved'}, max ${speedKmh} km/h, ${lengthM}m)`,
          roadId: r.id,
          distanceMeters: lengthM,
          durationSeconds: durationSec
        });
      }
    } catch {
      // Continue if DB spatial query fails
    }
  }

  // 4. Compute final straight-line unmapped segment from exit point to customer pin
  const finalGapMeters = Math.round(haversine(effectiveRoadEndpoint, destPoint));
  const isUnmappedApproach = finalGapMeters > 30; // More than 30m away from road exit point

  const bearing = calculateBearing(
    effectiveRoadEndpoint.latitude, effectiveRoadEndpoint.longitude,
    destPoint.latitude, destPoint.longitude
  );
  const cardinal = bearingToCardinal(bearing);

  const walkingDurationSec = Math.round(finalGapMeters / 1.4); // Walking/foot pace ~1.4 m/s

  if (isUnmappedApproach) {
    turnInstructions.push({
      step: turnInstructions.length + 1,
      type: 'final_unmapped_approach',
      text: `Depart road terminus heading approximately ${finalGapMeters}m ${cardinal} via compound entrance/pathway. Tap 'Call Customer' if gate is not visible.`,
      distanceMeters: finalGapMeters,
      durationSeconds: walkingDurationSec,
      bearingDegrees: Math.round(bearing),
      cardinalDirection: cardinal
    });
  } else {
    turnInstructions.push({
      step: turnInstructions.length + 1,
      type: 'arrival',
      text: 'Destination is directly accessible from road.',
      distanceMeters: finalGapMeters,
      durationSeconds: 0
    });
  }

  const totalDistanceMeters = roadDistanceMeters + totalCandidateRoadMeters + finalGapMeters;
  const estimatedDurationSeconds = roadDurationSeconds + totalCandidateRoadSeconds + walkingDurationSec;

  // Stitched GeoJSON geometry with coordinates
  const fullGeometry = {
    type: 'LineString',
    coordinates: stitchedCoordinates.length > 0 ? stitchedCoordinates : [
      [riderPosition.longitude, riderPosition.latitude],
      [destPoint.longitude, destPoint.latitude]
    ]
  };

  return {
    roadRouteAvailable: Boolean(roadRoute || candidateSegmentsUsed.length > 0),
    totalDistanceMeters,
    estimatedDurationSeconds,
    roadEndpoint: effectiveRoadEndpoint,
    confirmedDestination: destPoint,
    candidateSegmentsUsed,
    publishedRoadUsed: candidateSegmentsUsed[0] || null,
    hasCandidateRoadCorridors: candidateSegmentsUsed.length > 0,
    geometry: fullGeometry,
    turnInstructions,
    unmappedFinalSegment: {
      isUnmapped: isUnmappedApproach,
      distanceMeters: finalGapMeters,
      bearingDegrees: Math.round(bearing),
      cardinalDirection: cardinal,
      guidanceText: isUnmappedApproach
        ? candidateSegmentsUsed.length > 0
          ? `Proceed along verified road '${candidateSegmentsUsed[0].name}'. Final approach: ${finalGapMeters}m ${cardinal} to destination pin.`
          : `Navigate to mapped road terminus. Then proceed approximately ${finalGapMeters}m ${cardinal} via pathway/compound entrance. Tap 'Call Customer' if entrance is unclear.`
        : 'Destination is directly accessible from road.'
    },
    requiresFinalApproachGuidance: isUnmappedApproach,
    customerCallAssistanceAvailable: true
  };
}
