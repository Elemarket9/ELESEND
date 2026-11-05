-- Rush-hour rate per vehicle, new motorbike rates, and a waiting fee for long stops.
ALTER TABLE pricing_policies ADD COLUMN rush_hour_bps integer NOT NULL DEFAULT 14000 CHECK (rush_hour_bps BETWEEN 10000 AND 30000);
CREATE TEMP TABLE new_motorcycle_policy ON COMMIT DROP AS SELECT * FROM pricing_policies WHERE active AND vehicle = 'motorcycle';
UPDATE new_motorcycle_policy SET id = gen_random_uuid(), per_km_minor = 220, rush_hour_bps = 13000, wait_per_minute_minor = 56;
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
