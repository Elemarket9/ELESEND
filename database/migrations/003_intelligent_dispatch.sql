-- Required extension: PostGIS installed by database operator before migrations.
CREATE EXTENSION IF NOT EXISTS postgis;
ALTER TABLE riders ADD COLUMN current_position geography(Point,4326),
 ADD COLUMN position_at timestamptz,
 ADD COLUMN position_accuracy_m double precision CHECK(position_accuracy_m BETWEEN 0 AND 1000),
 ADD COLUMN observed_heading_deg double precision CHECK(observed_heading_deg >= 0 AND observed_heading_deg < 360),
 ADD COLUMN observed_speed_mps double precision CHECK(observed_speed_mps BETWEEN 0 AND 80);
CREATE INDEX riders_position_gix ON riders USING gist(current_position) WHERE online AND status='approved';
CREATE TABLE rider_location_samples (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 rider_id uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
 position geography(Point,4326) NOT NULL,
 observed_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 accuracy_m double precision NOT NULL CHECK(accuracy_m BETWEEN 0 AND 1000)
);
CREATE INDEX rider_samples_recent ON rider_location_samples(rider_id,observed_at DESC);
CREATE TABLE dispatch_policy (
 id integer PRIMARY KEY DEFAULT 1 CHECK(id=1),
 search_radii_m integer[] NOT NULL DEFAULT ARRAY[2000,5000,10000] CHECK(array_length(search_radii_m,1) BETWEEN 1 AND 8),
 candidate_limit integer NOT NULL DEFAULT 10 CHECK(candidate_limit BETWEEN 1 AND 30),
 fresh_seconds integer NOT NULL DEFAULT 75 CHECK(fresh_seconds BETWEEN 10 AND 300),
 max_sample_age_seconds integer NOT NULL DEFAULT 120 CHECK(max_sample_age_seconds BETWEEN 15 AND 600),
 max_accuracy_m integer NOT NULL DEFAULT 100 CHECK(max_accuracy_m BETWEEN 5 AND 1000),
 max_speed_mps integer NOT NULL DEFAULT 55 CHECK(max_speed_mps BETWEEN 2 AND 100),
 offer_seconds integer NOT NULL DEFAULT 30 CHECK(offer_seconds BETWEEN 10 AND 180),
 retry_seconds integer NOT NULL DEFAULT 30 CHECK(retry_seconds BETWEEN 10 AND 900),
 max_attempts integer NOT NULL DEFAULT 15 CHECK(max_attempts BETWEEN 1 AND 100),
 multi_stop_enabled boolean NOT NULL DEFAULT false CHECK(multi_stop_enabled=false),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO dispatch_policy(id) VALUES(1);
ALTER TABLE shipments ADD COLUMN next_dispatch_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN dispatch_attempts integer NOT NULL DEFAULT 0 CHECK(dispatch_attempts >= 0);
CREATE TABLE dispatch_offers (
 id uuid PRIMARY KEY,
 shipment_id uuid NOT NULL REFERENCES shipments(id),
 rider_id uuid NOT NULL REFERENCES riders(id),
 status text NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','accepted','declined','expired','invalidated')),
 pickup_eta_seconds integer NOT NULL CHECK(pickup_eta_seconds >= 0),
 pickup_road_meters integer NOT NULL CHECK(pickup_road_meters >= 0),
 direction text NOT NULL CHECK(direction IN ('approaching','moving_away','stationary','unknown')),
 quoted_entitlement_minor integer NOT NULL CHECK(quoted_entitlement_minor>=0),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 accepted_at timestamptz
);
CREATE UNIQUE INDEX one_open_shipment_offer ON dispatch_offers(shipment_id) WHERE status='offered';
CREATE UNIQUE INDEX one_accepted_shipment_offer ON dispatch_offers(shipment_id) WHERE status='accepted';
CREATE INDEX dispatch_offers_rider ON dispatch_offers(rider_id,status,expires_at);
CREATE INDEX dispatch_due ON shipments(next_dispatch_at,created_at) WHERE state='AWAITING_ASSIGNMENT';
