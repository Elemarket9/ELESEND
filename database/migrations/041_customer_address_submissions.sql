-- Migration 041: customer-written addresses kept outside the authoritative gazetteer.
-- Additive only. Does not alter spatial_landmarks, national_businesses, quotes,
-- shipments, payments, commissions, settlements, or rider earnings.
-- Unresolved rows have no coordinates. Resolved coordinates are either an existing
-- EGIE record or a point the customer (or their GPS) explicitly selected.

CREATE TABLE customer_address_submissions (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('pickup', 'destination', 'food_delivery')),
  original jsonb NOT NULL,
  normalized_text text NOT NULL,
  composed_address text NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('unresolved', 'matched_record', 'approximate', 'customer_pin', 'gps')),
  confidence text NOT NULL CHECK (confidence IN ('none', 'low', 'medium', 'high')),
  matched_landmark_id text,
  latitude double precision,
  longitude double precision,
  position_kind text NOT NULL CHECK (position_kind IN ('none', 'verified_record', 'approximate', 'customer_pin', 'gps')),
  uncertainty_note text,
  conflict_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (latitude IS NULL OR latitude BETWEEN 4.5 AND 11.5),
  CHECK (longitude IS NULL OR longitude BETWEEN -3.5 AND 1.5),
  CHECK (
    (position_kind = 'none' AND resolution = 'unresolved' AND latitude IS NULL AND longitude IS NULL)
    OR (position_kind = 'verified_record' AND resolution = 'matched_record' AND latitude IS NOT NULL AND longitude IS NOT NULL)
    OR (position_kind = 'approximate' AND resolution = 'approximate' AND latitude IS NOT NULL AND longitude IS NOT NULL)
    OR (position_kind = 'customer_pin' AND resolution = 'customer_pin' AND latitude IS NOT NULL AND longitude IS NOT NULL)
    OR (position_kind = 'gps' AND resolution = 'gps' AND latitude IS NOT NULL AND longitude IS NOT NULL)
  )
);

CREATE INDEX customer_address_submissions_customer_idx
  ON customer_address_submissions(customer_id, created_at DESC);

CREATE TRIGGER customer_address_submissions_immutable
  BEFORE UPDATE OR DELETE ON customer_address_submissions
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
