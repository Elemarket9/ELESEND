import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GHANA_BOUNDS } from '../ghana-geocoder.mjs';
import { haversine } from '../../../dispatch-geometry.mjs';
import { check, fail } from '../../../security.mjs';

const tempReferenceSchema = z.object({
  shipmentId: z.string().uuid().optional().nullable(),
  latitude: z.number().finite().min(GHANA_BOUNDS.minLatitude).max(GHANA_BOUNDS.maxLatitude),
  longitude: z.number().finite().min(GHANA_BOUNDS.minLongitude).max(GHANA_BOUNDS.maxLongitude),
  description: z.string().trim().min(3).max(300),
  landmarkContext: z.string().trim().max(150).optional().nullable(),
  entranceInstructions: z.string().trim().max(300).optional().nullable(),
  accuracyMeters: z.number().finite().min(0).max(1000).optional().nullable(),
  pinConfirmed: z.boolean().default(true)
}).strict();

/**
 * Creates an order-scoped Temporary Delivery Reference for an unlisted destination (Phase 4).
 * When attached to a booked shipment, locks the shipment and verifies that the reference
 * coordinates match the quoted destination so a reference can never silently override
 * the priced destination without a new quote and booking.
 */
export async function createTemporaryDeliveryReference(db, actor, input) {
  check(actor && actor.id, 401, 'Authentication required');
  check(['customer', 'business', 'admin'].includes(actor.kind), 403, 'Customer account required');

  const validated = tempReferenceSchema.parse(input);
  const runTx = typeof db.tx === 'function' ? fn => db.tx(fn) : fn => fn(db);

  return runTx(async c => {
    let boundLatitude = validated.latitude;
    let boundLongitude = validated.longitude;

    if (validated.shipmentId) {
      const shipRes = await c.query(
        `SELECT s.customer_id, s.paid, s.state, q.request AS quote_request
           FROM shipments s
           LEFT JOIN quotes q ON q.id = s.quote_id
          WHERE s.id = $1
            FOR UPDATE OF s`,
        [validated.shipmentId]
      );
      check(shipRes.rowCount > 0, 404, 'Shipment not found');
      const ship = shipRes.rows[0];
      check(actor.kind === 'admin' || ship.customer_id === actor.id, 403, 'Unauthorized to attach delivery reference to another customer shipment');
      check(['AWAITING_PAYMENT', 'AWAITING_ASSIGNMENT', 'RIDER_ASSIGNED'].includes(ship.state), 409, 'Delivery reference can only be attached before pickup custody is verified');

      const qDest = ship.quote_request?.destination || ship.quote_request?.dropoff || null;
      const qLat = Number(qDest?.latitude);
      const qLon = Number(qDest?.longitude);
      if (Number.isFinite(qLat) && Number.isFinite(qLon)) {
        const driftMeters = haversine(
          { latitude: validated.latitude, longitude: validated.longitude },
          { latitude: qLat, longitude: qLon }
        );
        check(
          driftMeters <= 5,
          409,
          'Temporary delivery reference coordinates must match the quoted destination; request a new quote and booking when the destination changes'
        );
        boundLatitude = qLat;
        boundLongitude = qLon;
      }

      const existingRef = await c.query(
        'SELECT 1 FROM temporary_delivery_references WHERE shipment_id = $1 FOR UPDATE',
        [validated.shipmentId]
      );
      check(existingRef.rowCount === 0, 409, 'Delivery reference already attached to shipment');
    }

    const refId = randomUUID();
    const query = `
      INSERT INTO temporary_delivery_references (
        id, shipment_id, customer_id, coordinates, description,
        landmark_context, entrance_instructions, accuracy_m, pin_confirmed
      ) VALUES (
        $1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6,
        $7, $8, $9, $10
      )
      RETURNING id, shipment_id, customer_id, description, landmark_context,
                entrance_instructions, accuracy_m, pin_confirmed, created_at,
                ST_Y(coordinates::geometry) AS latitude,
                ST_X(coordinates::geometry) AS longitude
    `;

    const values = [
      refId,
      validated.shipmentId || null,
      actor.id,
      boundLongitude,
      boundLatitude,
      validated.description,
      validated.landmarkContext || null,
      validated.entranceInstructions || null,
      validated.accuracyMeters || null,
      validated.pinConfirmed
    ];

    let res;
    try {
      res = await c.query(query, values);
    } catch (err) {
      if (
        err.code === '23505' ||
        err.constraint === 'idx_temporary_delivery_references_shipment' ||
        (err.message && err.message.includes('idx_temporary_delivery_references_shipment'))
      ) {
        fail(409, 'Delivery reference already attached to shipment');
      }
      throw err;
    }
    const row = res.rows[0];

    return {
      id: row.id,
      shipmentId: row.shipment_id,
      customerId: row.customer_id,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      description: row.description,
      landmarkContext: row.landmark_context,
      entranceInstructions: row.entrance_instructions,
      accuracyMeters: row.accuracy_m ? Number(row.accuracy_m) : null,
      pinConfirmed: row.pin_confirmed,
      createdAt: row.created_at,
      systemNote: 'Temporary delivery reference created. Scoped exclusively to order, not published as public landmark.'
    };
  });
}

/**
 * Retrieves a temporary delivery reference by ID, ensuring privacy
 */
export async function getTemporaryDeliveryReference(db, actor, refId) {
  check(actor && actor.id, 401, 'Authentication required');
  check(typeof refId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(refId), 400, 'Valid reference ID required');

  const res = await db.query(`
    SELECT id, shipment_id, customer_id, description, landmark_context,
           entrance_instructions, accuracy_m, pin_confirmed, created_at,
           ST_Y(coordinates::geometry) AS latitude,
           ST_X(coordinates::geometry) AS longitude
    FROM temporary_delivery_references
    WHERE id = $1
  `, [refId]);

  const row = res.rows[0];
  check(row, 404, 'Temporary delivery reference not found');

  // Privacy check: only the creating customer, an assigned rider, or an admin can access
  if (actor.kind !== 'admin' && actor.id !== row.customer_id) {
    if (row.shipment_id) {
      const shipCheck = await db.query(`
        SELECT 1 FROM shipments WHERE id = $1 AND rider_id = $2
      `, [row.shipment_id, actor.id]);
      check(shipCheck.rowCount > 0, 403, 'Unauthorized to view this delivery reference');
    } else {
      check(false, 403, 'Unauthorized to view this delivery reference');
    }
  }

  return {
    id: row.id,
    shipmentId: row.shipment_id,
    customerId: row.customer_id,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    description: row.description,
    landmarkContext: row.landmark_context,
    entranceInstructions: row.entrance_instructions,
    accuracyMeters: row.accuracy_m ? Number(row.accuracy_m) : null,
    pinConfirmed: row.pin_confirmed,
    createdAt: row.created_at
  };
}
