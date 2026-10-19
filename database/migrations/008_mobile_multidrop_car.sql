-- Mobile-first ELESEND, verified car onboarding and explicit, bounded multi-parcel custody.
-- Never change earlier migration checksums. A first-release safety cap of 3 jobs is deliberate.
ALTER TABLE dispatch_policy DROP CONSTRAINT IF EXISTS dispatch_policy_multi_stop_enabled_check;
ALTER TABLE dispatch_policy ADD COLUMN max_active_parcels integer NOT NULL DEFAULT 2 CHECK(max_active_parcels BETWEEN 1 AND 3),
 ADD COLUMN max_detour_seconds integer NOT NULL DEFAULT 480 CHECK(max_detour_seconds BETWEEN 0 AND 1800),
 ADD COLUMN delivery_slack_seconds integer NOT NULL DEFAULT 1200 CHECK(delivery_slack_seconds BETWEEN 120 AND 7200),
 ADD COLUMN max_pickup_eta_seconds integer NOT NULL DEFAULT 1800 CHECK(max_pickup_eta_seconds BETWEEN 120 AND 7200),
 ADD COLUMN max_offer_movement_m integer NOT NULL DEFAULT 300 CHECK(max_offer_movement_m BETWEEN 20 AND 2000);
ALTER TABLE riders ADD COLUMN multi_stop_opt_in boolean NOT NULL DEFAULT false;
CREATE TABLE rider_vehicle_registrations (
 rider_id uuid PRIMARY KEY REFERENCES riders(id),
 vehicle text NOT NULL CHECK(vehicle IN ('bicycle','motorcycle','tricycle','car','pickup','van','truck')),
 registration_plate text,
 make text,
 model text,
 color text,
 verification_status text NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending','approved','rejected','suspended')),
 submitted_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz,
 reviewer_id uuid REFERENCES users(id),
 CHECK(vehicle<>'car' OR (registration_plate IS NOT NULL AND make IS NOT NULL AND model IS NOT NULL))
);
CREATE UNIQUE INDEX car_unique_plate ON rider_vehicle_registrations(upper(regexp_replace(registration_plate,'[^A-Za-z0-9]','','g'))) WHERE vehicle='car' AND verification_status IN ('pending','approved');
-- Existing legacy car riders are NOT grandfathered into approved status.
INSERT INTO rider_vehicle_registrations(rider_id,vehicle,verification_status)
 SELECT id,vehicle,'pending' FROM riders WHERE vehicle='car';
CREATE TABLE rider_dispatch_plans (
 rider_id uuid PRIMARY KEY REFERENCES riders(id),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 stops jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(stops)='array'),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dispatch_commitments (
 shipment_id uuid PRIMARY KEY REFERENCES shipments(id),
 rider_id uuid NOT NULL REFERENCES riders(id),
 promised_delivery_before timestamptz NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispatch_commitments_rider ON dispatch_commitments(rider_id);
ALTER TABLE dispatch_offers ADD COLUMN plan_revision bigint,
 ADD COLUMN proposed_stops jsonb CHECK(proposed_stops IS NULL OR jsonb_typeof(proposed_stops)='array'),
 ADD COLUMN anchor_lat double precision,
 ADD COLUMN anchor_lon double precision,
 ADD COLUMN expected_active integer NOT NULL DEFAULT 0 CHECK(expected_active BETWEEN 0 AND 2),
 ADD COLUMN planned_dropoff_seconds integer;
-- The previous exclusive-rider index must be replaced with transactional capacity checks.
DROP INDEX IF EXISTS rider_one_active_assignment;
-- Serialized on the rider row. This is a second defense even against accidental direct SQL.
CREATE FUNCTION guard_active_rider_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; r record; existing_count integer; existing_weight bigint; new_weight bigint;
BEGIN
 IF NEW.rider_id IS NULL OR NEW.state NOT IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.rider_id IS NOT DISTINCT FROM NEW.rider_id AND OLD.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED') THEN RETURN NEW; END IF;
 SELECT * INTO r FROM riders WHERE id=NEW.rider_id FOR UPDATE;
 SELECT * INTO p FROM dispatch_policy WHERE id=1;
 SELECT count(*)::integer,coalesce(sum((q.request->>'weightG')::bigint),0)
 INTO existing_count,existing_weight FROM shipments s JOIN quotes q ON q.id=s.quote_id
 WHERE s.rider_id=NEW.rider_id AND s.id<>NEW.id
 AND s.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED');
 SELECT (request->>'weightG')::bigint INTO new_weight FROM quotes WHERE id=NEW.quote_id;
 IF existing_count>=1 AND (NOT p.multi_stop_enabled OR NOT r.multi_stop_opt_in) THEN RAISE EXCEPTION 'Multi-parcel authorization disabled' USING ERRCODE='23514'; END IF;
 IF existing_count>=p.max_active_parcels OR existing_weight+new_weight>r.max_weight_g THEN RAISE EXCEPTION 'Rider parcel or weight limit exceeded' USING ERRCODE='23514'; END IF;
 IF existing_count>0 AND EXISTS(SELECT 1 FROM shipments s WHERE s.rider_id=NEW.rider_id AND s.id<>NEW.id AND s.state IN ('FAILED','RETURN_REQUESTED')) THEN RAISE EXCEPTION 'Custody exception blocks new parcel' USING ERRCODE='23514'; END IF;
 IF r.vehicle='car' AND NOT EXISTS(SELECT 1 FROM rider_vehicle_registrations vr WHERE vr.rider_id=r.id AND vr.vehicle='car' AND vr.verification_status='approved') THEN RAISE EXCEPTION 'Car registration not verified' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rider_capacity_guard BEFORE INSERT OR UPDATE OF rider_id,state ON shipments FOR EACH ROW EXECUTE FUNCTION guard_active_rider_capacity();
CREATE INDEX active_rider_shipments ON shipments(rider_id,state) WHERE rider_id IS NOT NULL AND state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED');
