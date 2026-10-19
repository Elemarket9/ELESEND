-- Preserve legacy policies/quotes; new vehicle tariffs are explicit and versioned.
ALTER TABLE pricing_policies
 ADD COLUMN vehicle text CHECK(vehicle IN ('motorcycle','car','van')),
 ADD COLUMN minimum_minor integer NOT NULL DEFAULT 0 CHECK(minimum_minor BETWEEN 0 AND 100000000),
 ADD COLUMN rush_hour_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN supply_demand_enabled boolean NOT NULL DEFAULT false;
DROP INDEX one_active_price;
CREATE UNIQUE INDEX one_active_legacy_price ON pricing_policies(active) WHERE active AND vehicle IS NULL;
CREATE UNIQUE INDEX one_active_vehicle_price ON pricing_policies(vehicle) WHERE active AND vehicle IS NOT NULL;
ALTER TABLE quotes ADD COLUMN pricing_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE FUNCTION preserve_accepted_quote_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)-'expires_at') IS DISTINCT FROM (to_jsonb(NEW)-'expires_at') OR NEW.expires_at>OLD.expires_at THEN
  RAISE EXCEPTION 'Quote terms and evidence are immutable; request a new quote' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quote_terms_and_evidence_immutable BEFORE UPDATE ON quotes
 FOR EACH ROW EXECUTE FUNCTION preserve_accepted_quote_terms();

CREATE FUNCTION preserve_pricing_policy_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)-'active') IS DISTINCT FROM (to_jsonb(NEW)-'active') THEN
  RAISE EXCEPTION 'Create a new pricing policy version; existing terms are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pricing_policy_terms_immutable BEFORE UPDATE ON pricing_policies
 FOR EACH ROW EXECUTE FUNCTION preserve_pricing_policy_terms();

CREATE FUNCTION enforce_quoted_vehicle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requested text; actual text;
BEGIN
 IF NEW.rider_id IS NOT NULL THEN
  SELECT request->>'vehicle' INTO requested FROM quotes WHERE id=NEW.quote_id;
  SELECT vehicle INTO actual FROM riders WHERE id=NEW.rider_id;
  IF requested IS NOT NULL AND requested IS DISTINCT FROM actual THEN
   RAISE EXCEPTION 'Assigned rider vehicle does not match the accepted quote' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shipment_vehicle_matches_quote BEFORE INSERT OR UPDATE ON shipments
 FOR EACH ROW EXECUTE FUNCTION enforce_quoted_vehicle();

CREATE TABLE pricing_surge_zones(
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 2 AND 80),
 center geography(Point,4326) NOT NULL, radius_m integer NOT NULL CHECK(radius_m BETWEEN 500 AND 50000),
 enabled boolean NOT NULL DEFAULT false
);
CREATE INDEX pricing_surge_zone_center ON pricing_surge_zones USING gist(center);
CREATE TABLE pricing_surge_state(
 zone_id uuid NOT NULL REFERENCES pricing_surge_zones(id),
 vehicle text NOT NULL CHECK(vehicle IN ('motorcycle','car','van')),
 multiplier_bps integer NOT NULL DEFAULT 10000 CHECK(multiplier_bps BETWEEN 10000 AND 20000),
 demand integer NOT NULL DEFAULT 0 CHECK(demand>=0), supply integer NOT NULL DEFAULT 0 CHECK(supply>=0),
 updated_at timestamptz NOT NULL DEFAULT '-infinity', PRIMARY KEY(zone_id,vehicle)
);

-- Commercial rates explicitly supplied by the owner on 19 October 2026.
-- Supply/demand remains opt-in until zone observations have been reviewed.
INSERT INTO pricing_policies(id,vehicle,base_minor,per_km_minor,per_minute_minor,minimum_minor,commission_bps,rush_hour_enabled)
 VALUES(gen_random_uuid(),'motorcycle',1200,320,25,2000,2000,true),
       (gen_random_uuid(),'car',2200,500,60,3500,2000,true),
       (gen_random_uuid(),'van',5500,850,110,7500,2000,true);
