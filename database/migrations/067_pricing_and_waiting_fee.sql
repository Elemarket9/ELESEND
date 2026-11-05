-- Pricing engine controls. Nothing here changes what a customer pays until staff turn it on:
-- no tariff values change, no toll exists, the booking fee and waiting rates stay at zero, and
-- waiting charges also need WAITING_CHARGES_ENABLED=true.
ALTER TABLE pricing_policies
  ADD COLUMN rush_hour_bps integer NOT NULL DEFAULT 14000 CHECK (rush_hour_bps BETWEEN 10000 AND 20000),
  ADD COLUMN traffic_time_pricing boolean NOT NULL DEFAULT false,
  ADD COLUMN booking_fee_bps integer NOT NULL DEFAULT 0 CHECK (booking_fee_bps BETWEEN 0 AND 3000);

-- A toll applies only where a route really passes it, on stated evidence, for a stated period.
CREATE TABLE toll_rules (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  location geography(Point, 4326) NOT NULL,
  radius_m integer NOT NULL CHECK (radius_m BETWEEN 10 AND 100),
  vehicles text[] NOT NULL CHECK (cardinality(vehicles) > 0),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  source text NOT NULL CHECK (length(trim(source)) >= 5),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  retired_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX toll_rules_location ON toll_rules USING gist(location);

CREATE TABLE shipment_waiting_charges (
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  stop text NOT NULL CHECK (stop IN ('pickup', 'delivery')),
  arrived_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  waited_seconds integer NOT NULL CHECK (waited_seconds >= 0),
  fee_minor integer NOT NULL CHECK (fee_minor > 0),
  collection text NOT NULL CHECK (collection IN ('collect_cash', 'not_collected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shipment_id, stop)
);
