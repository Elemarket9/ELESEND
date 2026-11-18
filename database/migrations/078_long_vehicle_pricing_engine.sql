CREATE TABLE long_vehicle_pricing_policies (
  id uuid PRIMARY KEY,
  vehicle text NOT NULL DEFAULT 'long_vehicle' CHECK (vehicle='long_vehicle'),
  base_minor integer CHECK (base_minor IS NULL OR base_minor >= 0),
  per_km_minor integer CHECK (per_km_minor IS NULL OR per_km_minor >= 0),
  per_tonne_km_minor integer CHECK (per_tonne_km_minor IS NULL OR per_tonne_km_minor >= 0),
  minimum_minor integer CHECK (minimum_minor IS NULL OR minimum_minor >= 0),
  commission_bps integer CHECK (commission_bps IS NULL OR commission_bps BETWEEN 0 AND 10000),
  return_leg_bps integer CHECK (return_leg_bps IS NULL OR return_leg_bps BETWEEN 0 AND 10000),
  per_helper_minor integer CHECK (per_helper_minor IS NULL OR per_helper_minor >= 0),
  per_floor_minor integer CHECK (per_floor_minor IS NULL OR per_floor_minor >= 0),
  per_extra_stop_minor integer CHECK (per_extra_stop_minor IS NULL OR per_extra_stop_minor >= 0),
  booking_fee_bps integer CHECK (booking_fee_bps IS NULL OR booking_fee_bps BETWEEN 0 AND 3000),
  wait_per_minute_minor integer CHECK (wait_per_minute_minor IS NULL OR wait_per_minute_minor >= 0),
  free_loading_minutes integer CHECK (free_loading_minutes IS NULL OR free_loading_minutes BETWEEN 0 AND 240),
  is_placeholder boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (is_placeholder OR (
    base_minor IS NOT NULL AND per_km_minor IS NOT NULL AND per_tonne_km_minor IS NOT NULL
    AND minimum_minor IS NOT NULL AND commission_bps IS NOT NULL AND return_leg_bps IS NOT NULL
    AND per_helper_minor IS NOT NULL AND per_floor_minor IS NOT NULL AND per_extra_stop_minor IS NOT NULL
    AND booking_fee_bps IS NOT NULL AND wait_per_minute_minor IS NOT NULL AND free_loading_minutes IS NOT NULL
  ))
);
CREATE UNIQUE INDEX long_vehicle_pricing_one_active ON long_vehicle_pricing_policies(active) WHERE active;
INSERT INTO long_vehicle_pricing_policies(id,is_placeholder,active)
VALUES ('07800000-0000-4000-8000-000000000001',true,true);

ALTER TABLE quotes
  ADD COLUMN long_vehicle_policy_id uuid REFERENCES long_vehicle_pricing_policies(id);
