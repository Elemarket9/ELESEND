-- Rush-hour rate per vehicle, cost-based motorbike rates, and a waiting fee for long stops.
-- Motorbike rates cover a rider's real costs at 20% commission (November 2026):
-- GH¢1.20 running cost per paid km (petrol at GH¢16.38/L, about 35 km/L, upkeep, wear, empty riding),
-- GH¢0.71 per trip minute (a net GH¢6,000 a month over 26 days of 9 hours, about 60% of it on trips),
-- and about GH¢5.40 to reach each pickup. Traffic is paid through real trip minutes, not a multiplier.
ALTER TABLE pricing_policies ADD COLUMN rush_hour_bps integer NOT NULL DEFAULT 14000 CHECK (rush_hour_bps BETWEEN 10000 AND 30000);
CREATE TEMP TABLE new_motorcycle_policy ON COMMIT DROP AS SELECT * FROM pricing_policies WHERE active AND vehicle = 'motorcycle';
UPDATE new_motorcycle_policy SET id = gen_random_uuid(), base_minor = 700, per_km_minor = 150, per_minute_minor = 89, rush_hour_enabled = false, rush_hour_bps = 10000, wait_per_minute_minor = 56;
CREATE TEMP TABLE new_car_policy ON COMMIT DROP AS SELECT * FROM pricing_policies WHERE active AND vehicle = 'car';
UPDATE new_car_policy SET id = gen_random_uuid(), wait_per_minute_minor = 56;
UPDATE pricing_policies SET active = false WHERE active AND vehicle IN ('motorcycle', 'car');
INSERT INTO pricing_policies SELECT * FROM new_motorcycle_policy;
INSERT INTO pricing_policies SELECT * FROM new_car_policy;
CREATE TABLE shipment_waiting_charges (
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  stop text NOT NULL CHECK (stop IN ('pickup', 'delivery')),
  waited_seconds integer NOT NULL CHECK (waited_seconds >= 0),
  fee_minor integer NOT NULL CHECK (fee_minor > 0),
  collection text NOT NULL CHECK (collection IN ('collect_cash', 'not_collected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shipment_id, stop)
);
