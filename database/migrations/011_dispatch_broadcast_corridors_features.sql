-- ADDITIVE: offer fan-out; exact-one acceptance stays enforced by one_accepted_shipment_offer.
-- Activation by authorized administrators ONLY; defaults conservative.
DROP INDEX IF EXISTS one_open_shipment_offer;
CREATE UNIQUE INDEX one_open_offer_per_rider_shipment
  ON dispatch_offers(shipment_id,rider_id) WHERE status='offered';
ALTER TABLE dispatch_offers ADD COLUMN route_corridor_geojson jsonb;
ALTER TABLE dispatch_policy DROP CONSTRAINT IF EXISTS dispatch_policy_max_active_parcels_check;
ALTER TABLE dispatch_policy ADD CONSTRAINT dispatch_policy_max_active_parcels_check CHECK (max_active_parcels BETWEEN 1 AND 10);
ALTER TABLE dispatch_offers DROP CONSTRAINT IF EXISTS dispatch_offers_expected_active_check;
ALTER TABLE dispatch_offers ADD CONSTRAINT dispatch_offers_expected_active_check CHECK (expected_active BETWEEN 0 AND 9);
CREATE TABLE dispatch_algorithm_features(
 feature_key text PRIMARY KEY,
 enabled boolean NOT NULL DEFAULT false,
 updated_by uuid REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO dispatch_algorithm_features(feature_key,enabled) VALUES
 ('geospatial_discovery',true),('road_network_routing',true),('direction_matching',true),
 ('eta_dispatch_ranking',true),('multi_parcel_vrp',false),('dynamic_pickup_insertion',false),
 ('cost_based_pricing',true),('commission_exposure',true),('financial_reconciliation',true),
 ('gps_filtering',false),('eta_calibration',false),('fraud_signals',false),
 ('road_corridor_discovery',false),('multi_rider_broadcast',false),('fleet_batch_optimization',false);
-- Preserve existing deployed multi-parcel behavior during migration.
UPDATE dispatch_algorithm_features SET enabled=(SELECT multi_stop_enabled FROM dispatch_policy WHERE id=1)
 WHERE feature_key IN ('multi_parcel_vrp','dynamic_pickup_insertion');
-- Indexable road geography, never infer corridor from a straight line between endpoints.
CREATE TABLE rider_route_corridors (
 rider_id uuid PRIMARY KEY REFERENCES riders(id) ON DELETE CASCADE,
 road_path geography(LineString,4326) NOT NULL,
 plan_revision bigint NOT NULL,
 refreshed_at timestamptz NOT NULL DEFAULT now(),
 valid_until timestamptz NOT NULL
);
CREATE INDEX rider_route_corridors_path_gix ON rider_route_corridors USING gist(road_path);
CREATE INDEX rider_route_corridors_valid ON rider_route_corridors(valid_until);
CREATE TABLE service_markets(
 country_code char(2) PRIMARY KEY CHECK(country_code ~ '^[A-Z]{2}$'),
 iso_currency char(3) NOT NULL CHECK(iso_currency ~ '^[A-Z]{3}$'),
 service_enabled boolean NOT NULL DEFAULT false,
 cash_enabled boolean NOT NULL DEFAULT false,
 mo_mo_enabled boolean NOT NULL DEFAULT false,
 regulatory_verified_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO service_markets(country_code,iso_currency,service_enabled,cash_enabled,mo_mo_enabled)
 VALUES ('GH','GHS',true,true,false);
-- Quote country is pinned for historical Ghana quotes; foreign books require further auth, VAT, routing, provider readiness.
ALTER TABLE quotes ADD COLUMN market_country_code char(2) NOT NULL DEFAULT 'GH' REFERENCES service_markets(country_code);
ALTER TABLE shipments ADD COLUMN market_country_code char(2) NOT NULL DEFAULT 'GH' REFERENCES service_markets(country_code);
-- Reassignment must invalidate stale road corridor generated for the old plan.
CREATE OR REPLACE FUNCTION invalidate_route_corridor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM rider_route_corridors WHERE rider_id=NEW.rider_id AND plan_revision<>NEW.revision;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidate_route_corridor_on_plan AFTER UPDATE OF revision ON rider_dispatch_plans
 FOR EACH ROW EXECUTE FUNCTION invalidate_route_corridor();
