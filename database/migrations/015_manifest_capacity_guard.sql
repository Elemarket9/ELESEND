-- Safe incremental multi-parcel capacity: validate actual ordered road stops,
-- not the incorrect sum of all jobs that will never be onboard simultaneously.
-- IMPORTANT: run PostgreSQL integration tests before enabling multi-stop in production.
-- An acceptance transaction must update shipments AND rider_dispatch_plans together.

CREATE OR REPLACE FUNCTION guard_active_rider_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; r record; existing_count integer; new_weight bigint;
BEGIN
 IF NEW.rider_id IS NULL OR NEW.state NOT IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.rider_id IS NOT DISTINCT FROM NEW.rider_id AND OLD.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED') THEN RETURN NEW; END IF;
 SELECT * INTO r FROM riders WHERE id=NEW.rider_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rider unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM dispatch_policy WHERE id=1;
 SELECT count(*)::integer INTO existing_count FROM shipments s
 WHERE s.rider_id=NEW.rider_id AND s.id<>NEW.id AND s.state IN
 ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP','FAILED','RETURN_REQUESTED');
 SELECT (request->>'weightG')::bigint INTO new_weight FROM quotes WHERE id=NEW.quote_id;
 IF new_weight IS NULL OR new_weight<=0 OR new_weight>r.max_weight_g THEN
   RAISE EXCEPTION 'Parcel exceeds vehicle capacity' USING ERRCODE='23514'; END IF;
 IF existing_count>0 AND (NOT p.multi_stop_enabled OR NOT r.multi_stop_opt_in) THEN
   RAISE EXCEPTION 'Multi-parcel authorization disabled' USING ERRCODE='23514'; END IF;
 IF existing_count>=p.max_active_parcels THEN RAISE EXCEPTION 'Active parcel count limit exceeded' USING ERRCODE='23514'; END IF;
 IF existing_count>0 AND EXISTS (SELECT 1 FROM shipments s WHERE s.rider_id=NEW.rider_id AND s.id<>NEW.id AND s.state IN ('FAILED','RETURN_REQUESTED')) THEN
   RAISE EXCEPTION 'Custody exception blocks new parcel' USING ERRCODE='23514'; END IF;
 IF r.vehicle='car' AND NOT EXISTS(SELECT 1 FROM rider_vehicle_registrations v WHERE v.rider_id=r.id AND v.vehicle='car' AND v.verification_status='approved') THEN
   RAISE EXCEPTION 'Unverified car' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION verify_rider_manifest_capacity_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE max_weight bigint; manifest jsonb; rec jsonb; shipment uuid; kind text;
        grams bigint; current_weight bigint:=0; onboard uuid[]:='{}'::uuid[];
        stop_counts jsonb:='{}'::jsonb; expected uuid[]; counted integer;
BEGIN
 IF NEW.state<>'RIDER_ASSIGNED' OR NEW.rider_id IS NULL THEN RETURN NULL; END IF;
 SELECT r.max_weight_g,p.stops INTO max_weight,manifest FROM riders r
 LEFT JOIN rider_dispatch_plans p ON p.rider_id=r.id WHERE r.id=NEW.rider_id;
 IF manifest IS NULL OR jsonb_typeof(manifest)<>'array' OR jsonb_array_length(manifest)>40 THEN
    RAISE EXCEPTION 'Missing or oversized verified parcel manifest' USING ERRCODE='23514'; END IF;
 SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO expected FROM shipments s
 WHERE s.rider_id=NEW.rider_id AND s.state IN ('RIDER_ASSIGNED','PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP');
 -- Already collected goods count as vehicle load before processing future stops.
 SELECT coalesce(array_agg(id),'{}'::uuid[]),coalesce(sum((q.request->>'weightG')::bigint),0)
 INTO onboard,current_weight FROM shipments s JOIN quotes q ON q.id=s.quote_id
 WHERE s.rider_id=NEW.rider_id AND s.state IN ('PICKUP_VERIFIED','IN_TRANSIT','AWAITING_DELIVERY_OTP');
 IF current_weight>max_weight THEN RAISE EXCEPTION 'Already onboard weight exceeds vehicle capacity' USING ERRCODE='23514'; END IF;
 FOR rec IN SELECT value FROM jsonb_array_elements(manifest) LOOP
   IF NOT (rec ? 'shipmentId' AND rec ? 'kind' AND rec ? 'weightG') THEN
      RAISE EXCEPTION 'Malformed parcel stop' USING ERRCODE='23514'; END IF;
   shipment:=(rec->>'shipmentId')::uuid;kind:=rec->>'kind';
   IF NOT shipment=ANY(expected) THEN RAISE EXCEPTION 'Manifest contains inactive/foreign shipment' USING ERRCODE='23514'; END IF;
   SELECT (q.request->>'weightG')::bigint INTO grams FROM shipments s JOIN quotes q ON q.id=s.quote_id WHERE s.id=shipment;
   IF grams IS NULL OR grams<>(rec->>'weightG')::bigint OR grams<=0 THEN RAISE EXCEPTION 'Manifest weight does not match quoted parcel' USING ERRCODE='23514'; END IF;
   IF kind='pickup' THEN
      IF shipment=ANY(onboard) OR stop_counts ? (shipment::text||':pickup') THEN RAISE EXCEPTION 'Duplicate or invalid parcel pickup' USING ERRCODE='23514'; END IF;
      onboard:=array_append(onboard,shipment);current_weight:=current_weight+grams;
   ELSIF kind='dropoff' THEN
      IF NOT shipment=ANY(onboard) OR stop_counts ? (shipment::text||':dropoff') THEN RAISE EXCEPTION 'Dropoff before pickup or duplicate dropoff' USING ERRCODE='23514'; END IF;
      onboard:=array_remove(onboard,shipment);current_weight:=current_weight-grams;
   ELSE RAISE EXCEPTION 'Invalid stop kind' USING ERRCODE='23514'; END IF;
   stop_counts:=stop_counts||jsonb_build_object(shipment::text||':'||kind,true);
   IF current_weight<0 OR current_weight>max_weight THEN RAISE EXCEPTION 'Route exceeds vehicle carrying capacity' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF cardinality(onboard)<>0 THEN RAISE EXCEPTION 'Parcel left in manifest without dropoff' USING ERRCODE='23514'; END IF;
 FOREACH shipment IN ARRAY expected LOOP
   IF NOT stop_counts ? (shipment::text||':dropoff') THEN RAISE EXCEPTION 'Missing parcel dropoff' USING ERRCODE='23514'; END IF;
   IF (SELECT state='RIDER_ASSIGNED' FROM shipments WHERE id=shipment) AND NOT stop_counts ? (shipment::text||':pickup') THEN
      RAISE EXCEPTION 'Uncollected parcel has no pickup stop' USING ERRCODE='23514'; END IF;
   IF (SELECT state<>'RIDER_ASSIGNED' FROM shipments WHERE id=shipment) AND stop_counts ? (shipment::text||':pickup') THEN
      RAISE EXCEPTION 'Already collected parcel incorrectly has pickup stop' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NULL;
END $$;

-- Deferred trigger observes the rider_dispatch_plans revision written after shipment assignment.
CREATE CONSTRAINT TRIGGER rider_manifest_capacity_commit_guard
 AFTER UPDATE ON shipments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.state='RIDER_ASSIGNED' AND NEW.rider_id IS NOT NULL)
 EXECUTE FUNCTION verify_rider_manifest_capacity_at_commit();
