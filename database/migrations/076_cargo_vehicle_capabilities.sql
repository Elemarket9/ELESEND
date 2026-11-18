-- Cargo vehicle catalogue. The new heavy vehicle types are intentionally disabled until staff
-- configure real tariffs, review licensing requirements and explicitly enable them.
ALTER TABLE vehicle_capabilities DROP CONSTRAINT IF EXISTS vehicle_capabilities_vehicle_check;
ALTER TABLE vehicle_capabilities ADD CONSTRAINT vehicle_capabilities_vehicle_check
 CHECK(vehicle IN ('bicycle','motorcycle','tricycle','car','pickup','van','box_truck','long_vehicle','truck'));

ALTER TABLE riders DROP CONSTRAINT IF EXISTS riders_vehicle_check;
ALTER TABLE riders ADD CONSTRAINT riders_vehicle_check
 CHECK(vehicle IN ('bicycle','motorcycle','tricycle','car','pickup','van','box_truck','long_vehicle','truck'));
ALTER TABLE rider_vehicle_registrations DROP CONSTRAINT IF EXISTS rider_vehicle_registrations_vehicle_check;
ALTER TABLE rider_vehicle_registrations ADD CONSTRAINT rider_vehicle_registrations_vehicle_check
 CHECK(vehicle IN ('bicycle','motorcycle','tricycle','car','pickup','van','box_truck','long_vehicle','truck'));
ALTER TABLE pricing_policies DROP CONSTRAINT IF EXISTS pricing_policies_vehicle_check;
ALTER TABLE pricing_policies ADD CONSTRAINT pricing_policies_vehicle_check
 CHECK(vehicle IS NULL OR vehicle IN ('bicycle','motorcycle','tricycle','car','pickup','van','box_truck','long_vehicle','truck'));

ALTER TABLE vehicle_capabilities
 ADD COLUMN max_length_cm integer CHECK(max_length_cm IS NULL OR max_length_cm > 0),
 ADD COLUMN max_volume_l integer CHECK(max_volume_l IS NULL OR max_volume_l > 0),
 ADD COLUMN min_licence_class text,
 ADD COLUMN needs_manual_verification boolean NOT NULL DEFAULT false,
 ADD COLUMN customer_description text NOT NULL DEFAULT '',
 ADD COLUMN customer_example text NOT NULL DEFAULT '';

ALTER TABLE rider_vehicle_registrations
 ADD COLUMN payload_capacity_g integer CHECK(payload_capacity_g IS NULL OR payload_capacity_g > 0),
 ADD COLUMN body_type text CHECK(body_type IS NULL OR body_type IN ('open','closed','flatbed','refrigerated')),
 ADD COLUMN roadworthy_expires_on date,
 ADD COLUMN insurance_expires_on date;

-- Ghana's Road Traffic Regulations, 2026 (L.I. 2519) introduced a revised licence-class
-- framework. Minimum classes stay staff-editable; no legal class is guessed in this migration.
-- See docs/cargo-delivery.md before launch for sources and the staff verification requirement.
UPDATE vehicle_capabilities SET
 max_weight_g=CASE vehicle WHEN 'tricycle' THEN 300000 WHEN 'pickup' THEN 1000000 WHEN 'van' THEN 1500000 ELSE max_weight_g END,
 max_trip_m=CASE vehicle WHEN 'tricycle' THEN 25000 WHEN 'pickup' THEN 300000 WHEN 'van' THEN 400000 ELSE max_trip_m END,
 needs_manual_verification=vehicle NOT IN ('bicycle','motorcycle'),
 customer_description=CASE vehicle
  WHEN 'bicycle' THEN 'For small documents and light parcels.'
  WHEN 'motorcycle' THEN 'For documents, food and small parcels.'
  WHEN 'tricycle' THEN 'For market goods and sacks on short trips.'
  WHEN 'car' THEN 'For parcels that fit safely in a car.'
  WHEN 'pickup' THEN 'For building materials and appliances.'
  WHEN 'van' THEN 'For furniture and boxed goods.'
  WHEN 'truck' THEN 'For shop stock and larger loads.'
  ELSE customer_description END,
 customer_example=CASE vehicle
  WHEN 'bicycle' THEN 'Fits documents or a small parcel.'
  WHEN 'motorcycle' THEN 'Fits a backpack or food order.'
  WHEN 'tricycle' THEN 'Fits market goods or several sacks.'
  WHEN 'car' THEN 'Fits a suitcase or boxed parcel.'
  WHEN 'pickup' THEN 'Fits building materials or an appliance.'
  WHEN 'van' THEN 'Fits a fridge and a bed.'
  WHEN 'truck' THEN 'Fits shop stock or bulky goods.'
  ELSE customer_example END;

INSERT INTO vehicle_capabilities(vehicle,max_parcel_size,allowed_categories,enabled,max_weight_g,max_trip_m,
 max_length_cm,max_volume_l,min_licence_class,needs_manual_verification,customer_description,customer_example)
VALUES
 ('box_truck','large',ARRAY['general','documents','fragile'],false,7000000,600000,NULL,NULL,NULL,true,'For house moves and shop stock.','Fits a room of furniture or shop stock.'),
 ('long_vehicle','large',ARRAY['general','documents'],false,30000000,800000,1600,NULL,NULL,true,'For containers, steel and bulk goods.','Fits long steel, bulk goods or a container.')
ON CONFLICT(vehicle) DO UPDATE SET
 max_weight_g=EXCLUDED.max_weight_g,max_trip_m=EXCLUDED.max_trip_m,
 max_length_cm=EXCLUDED.max_length_cm,max_volume_l=EXCLUDED.max_volume_l,
 enabled=false,needs_manual_verification=true,customer_description=EXCLUDED.customer_description,
 customer_example=EXCLUDED.customer_example;

-- Dimension limits not provided by the owner remain unset. Staff must enter fleet-verified
-- length and volume limits before these cargo classes accept quotes.

-- Heavy vehicle policies always start disabled. Van stays disabled as before; truck is retained
-- for existing rider records but is not exposed as a new customer class.
UPDATE vehicle_capabilities SET enabled=false WHERE vehicle IN ('van','box_truck','long_vehicle','truck');

CREATE OR REPLACE FUNCTION guard_active_rider_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; r record; existing_count integer; existing_weight bigint; new_weight bigint; vc record; request_body jsonb;
BEGIN
 IF NEW.rider_id IS NULL OR NEW.state NOT IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.rider_id IS NOT DISTINCT FROM NEW.rider_id AND OLD.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED') THEN RETURN NEW; END IF;
 SELECT * INTO r FROM riders WHERE id=NEW.rider_id FOR UPDATE;
 SELECT * INTO p FROM dispatch_policy WHERE id=1;
 SELECT * INTO vc FROM vehicle_capabilities WHERE vehicle=r.vehicle AND enabled;
 SELECT count(*)::integer,coalesce(sum((q.request->>'weightG')::bigint),0)
 INTO existing_count,existing_weight FROM shipments s JOIN quotes q ON q.id=s.quote_id
 WHERE s.rider_id=NEW.rider_id AND s.id<>NEW.id
 AND s.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED');
 SELECT request,(request->>'weightG')::bigint INTO request_body,new_weight FROM quotes WHERE id=NEW.quote_id;
 IF vc.vehicle IS NULL THEN RAISE EXCEPTION 'Vehicle class disabled' USING ERRCODE='23514'; END IF;
 IF existing_count>=1 AND (NOT p.multi_stop_enabled OR NOT r.multi_stop_opt_in) THEN RAISE EXCEPTION 'Multi-parcel authorization disabled' USING ERRCODE='23514'; END IF;
 IF existing_count>=p.max_active_parcels OR existing_weight+new_weight>r.max_weight_g OR new_weight>vc.max_weight_g THEN RAISE EXCEPTION 'Rider parcel or weight limit exceeded' USING ERRCODE='23514'; END IF;
 IF vc.max_length_cm IS NOT NULL AND request_body ? 'lengthCm' AND (request_body->>'lengthCm')::integer>vc.max_length_cm THEN RAISE EXCEPTION 'Load length exceeds vehicle limit' USING ERRCODE='23514'; END IF;
 IF vc.max_volume_l IS NOT NULL AND request_body ? 'volumeL' AND (request_body->>'volumeL')::integer>vc.max_volume_l THEN RAISE EXCEPTION 'Load volume exceeds vehicle limit' USING ERRCODE='23514'; END IF;
 IF existing_count>0 AND EXISTS(SELECT 1 FROM shipments s WHERE s.rider_id=NEW.rider_id AND s.id<>NEW.id AND s.state IN ('FAILED','RETURN_REQUESTED')) THEN RAISE EXCEPTION 'Custody exception blocks new parcel' USING ERRCODE='23514'; END IF;
 IF r.vehicle NOT IN ('bicycle','motorcycle') AND NOT EXISTS(
   SELECT 1 FROM rider_vehicle_registrations v WHERE v.rider_id=r.id AND v.vehicle=r.vehicle AND v.verification_status='approved'
    AND v.payload_capacity_g>=new_weight AND v.roadworthy_expires_on>=CURRENT_DATE AND v.insurance_expires_on>=CURRENT_DATE
 ) THEN RAISE EXCEPTION 'Vehicle registration or papers not approved' USING ERRCODE='23514'; END IF;
 IF vc.min_licence_class IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM rider_licences l WHERE l.rider_id=r.id AND l.status='approved' AND l.expires_on>=CURRENT_DATE AND upper(l.licence_class)=upper(vc.min_licence_class)
 ) THEN RAISE EXCEPTION 'Driver licence class does not match vehicle policy' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
