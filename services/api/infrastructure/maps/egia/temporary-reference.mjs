import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GHANA_BOUNDS } from '../ghana-geocoder.mjs';
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
 * This enables Method A (Current GPS), Method B (Search), and Method C (Manual Pin Drag)
 * to successfully book deliveries without requiring an established landmark.
 */
export async function createTemporaryDeliveryReference(db, actor, input) {
  check(actor && actor.id, 401, 'Authentication required');
  check(['customer', 'business', 'admin'].includes(actor.kind), 403, 'Customer account required');

  const validated = tempReferenceSchema.parse(input);
  if (validated.shipmentId) {
    const shipRes = await db.query(
      'SELECT customer_id, paid, state FROM shipments WHERE id = $1',
      [validated.shipmentId]
    );
    check(shipRes.rowCount > 0, 404, 'Shipment not found');
    const ship = shipRes.rows[0];
    check(actor.kind === 'admin' || ship.customer_id === actor.id, 403, 'Unauthorized to attach delivery reference to another customer shipment');
    check(!ship.paid && ['AWAITING_PAYMENT', 'AWAITING_ASSIGNMENT'].includes(ship.state), 409, 'Destination coordinates are immutable on paid or assigned shipments');
    const existingRef = await db.query('SELECT 1 FROM temporary_delivery_references WHERE shipment_id = $1', [validated.shipmentId]);
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
    validated.longitude,
    validated.latitude,
    validated.description,
    validated.landmarkContext || null,
    validated.entranceInstructions || null,
    validated.accuracyMeters || null,
    validated.pinConfirmed
  ];

  let res;
  try {
    res = await db.query(query, values);
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
}

/**
 * Retrieves a temporary delivery reference by ID, ensuring privacy
 */
export async function getTemporaryDeliveryReference(db, actor, refId) {
  check(actor && actor.id, 401, 'Authentication required');
  check(typeof refId === 'string' && refId.length === 36, 400, 'Valid reference ID required');

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
