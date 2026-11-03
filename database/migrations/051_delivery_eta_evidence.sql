-- Auditable delivery timeline and ETA records, so estimates can be measured against real trips.
CREATE TABLE IF NOT EXISTS delivery_milestones (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  milestone text NOT NULL CHECK (milestone IN (
    'order_created','offer_sent','offer_accepted','rider_assigned','arrived_pickup',
    'food_ready','picked_up','arrived_customer','otp_completed'
  )),
  rider_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
-- A reassigned order can record the same milestone once for each rider.
CREATE UNIQUE INDEX IF NOT EXISTS delivery_milestones_once
  ON delivery_milestones(shipment_id, milestone, COALESCE(rider_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS delivery_milestones_time ON delivery_milestones(milestone, occurred_at DESC);

CREATE OR REPLACE FUNCTION record_delivery_milestone(p_shipment uuid, p_milestone text, p_rider uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO delivery_milestones(shipment_id, milestone, rider_id) VALUES (p_shipment, p_milestone, p_rider)
  ON CONFLICT DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION shipment_milestones() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM record_delivery_milestone(NEW.id, 'order_created', NULL);
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state = 'RIDER_ASSIGNED' THEN PERFORM record_delivery_milestone(NEW.id, 'rider_assigned', NEW.rider_id);
    ELSIF NEW.state = 'PICKUP_VERIFIED' THEN PERFORM record_delivery_milestone(NEW.id, 'picked_up', NEW.rider_id);
    ELSIF NEW.state = 'COMPLETED' THEN PERFORM record_delivery_milestone(NEW.id, 'otp_completed', NEW.rider_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipments_record_milestones AFTER INSERT OR UPDATE OF state ON shipments
  FOR EACH ROW EXECUTE FUNCTION shipment_milestones();

CREATE OR REPLACE FUNCTION offer_milestones() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM record_delivery_milestone(NEW.shipment_id, 'offer_sent', NEW.rider_id);
  ELSIF NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted' THEN
    PERFORM record_delivery_milestone(NEW.shipment_id, 'offer_accepted', NEW.rider_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dispatch_offers_record_milestones AFTER INSERT OR UPDATE OF status ON dispatch_offers
  FOR EACH ROW EXECUTE FUNCTION offer_milestones();

CREATE OR REPLACE FUNCTION food_milestones() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'READY_FOR_PICKUP' AND OLD.state IS DISTINCT FROM 'READY_FOR_PICKUP' AND NEW.shipment_id IS NOT NULL THEN
    PERFORM record_delivery_milestone(NEW.shipment_id, 'food_ready', NULL);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER food_orders_record_milestones AFTER UPDATE OF state ON food_orders
  FOR EACH ROW EXECUTE FUNCTION food_milestones();

-- Latest route and displayed estimate per shipment, so reads need few routing calls.
CREATE TABLE IF NOT EXISTS shipment_eta_state (
  shipment_id uuid PRIMARY KEY REFERENCES shipments(id),
  stage text NOT NULL,
  route_rider_id uuid,
  route_duration_seconds double precision,
  route_distance_meters double precision,
  route_geometry jsonb,
  route_computed_at timestamptz,
  pickup_to_dropoff_seconds double precision,
  displayed_arrival_at timestamptz,
  displayed_stage text,
  last_change_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- First estimate per stage: the record later compared with what actually happened.
CREATE TABLE IF NOT EXISTS eta_predictions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  stage text NOT NULL,
  rider_id uuid,
  vehicle text,
  delivery_type text NOT NULL CHECK (delivery_type IN ('food','parcel')),
  city text NOT NULL,
  time_bucket text NOT NULL,
  routing_label text NOT NULL,
  road_seconds double precision,
  adjusted_seconds double precision,
  predicted_remaining_seconds integer NOT NULL,
  adjustment_source text NOT NULL,
  gps_quality text,
  confidence text NOT NULL,
  predicted_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS eta_predictions_once
  ON eta_predictions(shipment_id, stage, COALESCE(rider_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS eta_predictions_lookup ON eta_predictions(vehicle, delivery_type, city, time_bucket, predicted_at DESC);
