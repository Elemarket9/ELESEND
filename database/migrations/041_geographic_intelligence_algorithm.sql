-- Migration 041: ELESEND Geographic Intelligence Algorithm (EGIA)
-- Self-improving Ghana delivery map, unmapped community navigation, rider observations,
-- candidate road discovery, and verified landmark lifecycle.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Temporary Delivery References (Order-scoped location for unlisted destinations)
CREATE TABLE IF NOT EXISTS temporary_delivery_references (
  id uuid PRIMARY KEY,
  shipment_id uuid REFERENCES shipments(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES users(id),
  coordinates geography(Point, 4326) NOT NULL,
  description text NOT NULL,
  landmark_context text,
  entrance_instructions text,
  accuracy_m double precision CHECK(accuracy_m IS NULL OR accuracy_m BETWEEN 0 AND 1000),
  pin_confirmed boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_temp_delivery_coords ON temporary_delivery_references USING gist(coordinates);
CREATE INDEX IF NOT EXISTS idx_temp_delivery_shipment ON temporary_delivery_references(shipment_id);

-- 2. Rider Map Improvement Reports (Stationary/post-delivery verified reports)
CREATE TABLE IF NOT EXISTS rider_map_reports (
  id uuid PRIMARY KEY,
  rider_id uuid NOT NULL REFERENCES riders(id),
  shipment_id uuid REFERENCES shipments(id),
  report_type text NOT NULL CHECK(report_type IN (
    'missing_road', 'missing_landmark', 'wrong_coordinates', 'missing_junction',
    'incorrect_access', 'missing_community', 'incorrect_entrance', 'road_blocked',
    'temporary_reference_correction'
  )),
  location geography(Point, 4326) NOT NULL,
  road_geometry geography(LineString, 4326),
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending', 'investigating', 'corroborated', 'verified', 'rejected', 'published', 'resolved'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rider_reports_loc ON rider_map_reports USING gist(location);
CREATE INDEX IF NOT EXISTS idx_rider_reports_rider ON rider_map_reports(rider_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rider_reports_status ON rider_map_reports(status);

-- 3. Candidate Unmapped Road Corridors (Learned from GPS observations and rider feedback)
CREATE TABLE IF NOT EXISTS candidate_roads (
  id uuid PRIMARY KEY,
  name text,
  corridor geography(LineString, 4326) NOT NULL,
  status text NOT NULL DEFAULT 'OBSERVED' CHECK(status IN (
    'OBSERVED', 'CANDIDATE', 'CORROBORATED', 'REVIEW_REQUIRED', 'VERIFIED', 'PUBLISHED', 'REJECTED', 'RETIRED'
  )),
  confidence integer NOT NULL DEFAULT 30 CHECK(confidence BETWEEN 0 AND 100),
  observation_count integer NOT NULL DEFAULT 1,
  distinct_riders integer NOT NULL DEFAULT 1,
  allowed_vehicles text[] NOT NULL DEFAULT ARRAY['motorcycle'],
  surface_type text NOT NULL DEFAULT 'unpaved',
  source text NOT NULL DEFAULT 'rider_gps_cluster',
  region text NOT NULL DEFAULT 'Greater Accra',
  locality text NOT NULL DEFAULT 'Unknown',
  review_notes text,
  reviewer_id uuid REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidate_roads_geom ON candidate_roads USING gist(corridor);
CREATE INDEX IF NOT EXISTS idx_candidate_roads_status ON candidate_roads(status, confidence DESC);

-- 4. Candidate Public Landmarks (Learned from rider submissions, merchant listings & unlisted deliveries)
CREATE TABLE IF NOT EXISTS candidate_landmarks (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  search_name text NOT NULL,
  category text NOT NULL,
  subcategory text NOT NULL DEFAULT 'general',
  region text NOT NULL,
  locality text NOT NULL,
  city text NOT NULL,
  location geography(Point, 4326) NOT NULL,
  confidence integer NOT NULL DEFAULT 40 CHECK(confidence BETWEEN 0 AND 100),
  source text NOT NULL,
  source_id text,
  license text NOT NULL DEFAULT 'Proprietary ELESEND / Community Verified',
  verification_status text NOT NULL DEFAULT 'OBSERVED' CHECK(verification_status IN (
    'OBSERVED', 'CANDIDATE', 'CORROBORATED', 'REVIEW_REQUIRED', 'VERIFIED', 'PUBLISHED', 'REJECTED', 'RETIRED'
  )),
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_private boolean NOT NULL DEFAULT false,
  reviewer_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cand_landmarks_loc ON candidate_landmarks USING gist(location);
CREATE INDEX IF NOT EXISTS idx_cand_landmarks_search ON candidate_landmarks USING gin(search_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cand_landmarks_status ON candidate_landmarks(verification_status);

-- 5. Versioned Map Updates & Audit Trail (Enables 1-click rollback)
CREATE TABLE IF NOT EXISTS map_update_versions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_tag text NOT NULL UNIQUE,
  change_type text NOT NULL CHECK(change_type IN ('road_publish', 'road_retire', 'landmark_publish', 'landmark_retire')),
  feature_id uuid NOT NULL,
  previous_state jsonb,
  new_state jsonb NOT NULL,
  published_by uuid REFERENCES users(id),
  rolled_back boolean NOT NULL DEFAULT false,
  rolled_back_at timestamptz,
  rolled_back_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_map_updates_tag ON map_update_versions(version_tag);
CREATE INDEX IF NOT EXISTS idx_map_updates_feature ON map_update_versions(feature_id);

-- 6. Insert Admin permissions for Geographic Intelligence Management
INSERT INTO permissions(user_id, permission)
SELECT id, 'maps:manage' FROM users WHERE kind = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO permissions(user_id, permission)
SELECT id, 'maps:review' FROM users WHERE kind = 'admin'
ON CONFLICT DO NOTHING;
