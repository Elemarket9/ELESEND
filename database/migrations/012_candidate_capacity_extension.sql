-- Larger fan-out is configurable, but the default stays conservative for routing API budgets.
ALTER TABLE dispatch_policy DROP CONSTRAINT IF EXISTS dispatch_policy_candidate_limit_check;
ALTER TABLE dispatch_policy ADD CONSTRAINT dispatch_policy_candidate_limit_check CHECK(candidate_limit BETWEEN 1 AND 200);
CREATE INDEX dispatch_offers_open_shipment ON dispatch_offers(shipment_id,expires_at) WHERE status='offered';
-- Faster historical, rider-verifiable pickup ETA calibration (only consumed authenticated OTPs).
CREATE INDEX challenges_pickup_verified ON challenges(shipment_id,rider_id,consumed_at)
 WHERE purpose='pickup' AND consumed_at IS NOT NULL;
