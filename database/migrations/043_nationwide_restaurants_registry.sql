-- Migration 043: Nationwide Restaurant Coordinate Registry & Map Integration
-- Creates mapped_restaurants table preserving strict separation between
-- mapped geographic references and approved ELESEND ordering partners.

CREATE TABLE IF NOT EXISTS mapped_restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  alternative_names TEXT[] NOT NULL DEFAULT '{}',
  category TEXT NOT NULL,
  subcategory TEXT,
  cuisine TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  country TEXT NOT NULL DEFAULT 'Ghana',
  region TEXT NOT NULL,
  district TEXT,
  community TEXT,
  street_address TEXT,
  phone_number TEXT,
  opening_hours TEXT,
  price_level TEXT,
  seating_type TEXT,
  operating_status TEXT NOT NULL DEFAULT 'active',
  source_name TEXT NOT NULL,
  source_license TEXT NOT NULL,
  source_record_id TEXT,
  confidence_score NUMERIC(4,3) NOT NULL DEFAULT 0.850,
  is_registered_merchant BOOLEAN NOT NULL DEFAULT FALSE,
  registered_merchant_id UUID REFERENCES restaurants(id) ON DELETE SET NULL,
  geom GEOMETRY(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mapped_restaurants_geom 
  ON mapped_restaurants USING GIST (geom);

CREATE INDEX IF NOT EXISTS idx_mapped_restaurants_region 
  ON mapped_restaurants (region);

CREATE INDEX IF NOT EXISTS idx_mapped_restaurants_category 
  ON mapped_restaurants (category);

CREATE INDEX IF NOT EXISTS idx_mapped_restaurants_name_trgm 
  ON mapped_restaurants USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_mapped_restaurants_source 
  ON mapped_restaurants (source_name);

CREATE INDEX IF NOT EXISTS idx_mapped_restaurants_registered 
  ON mapped_restaurants (is_registered_merchant);

COMMENT ON TABLE mapped_restaurants IS 'Nationwide geographic POI registry for restaurants, chop bars, cafes and food services across Ghana for map navigation, informal directions and search. Independent from merchant ordering accounts.';
