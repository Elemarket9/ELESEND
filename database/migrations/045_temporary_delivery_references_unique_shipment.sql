-- Migration 045: Enforce single temporary delivery reference per shipment
-- Prevents concurrency race conditions from creating multiple active references for the same order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_temporary_delivery_references_shipment
  ON temporary_delivery_references(shipment_id)
  WHERE shipment_id IS NOT NULL;
