-- Migration 027: Production-Grade Spatial Landmarks & POI Registry for Ghana
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE IF NOT EXISTS spatial_landmarks (
  id text PRIMARY KEY,
  name text NOT NULL,
  search_name text NOT NULL,
  category text NOT NULL,
  subcategory text NOT NULL,
  region text NOT NULL,
  locality text NOT NULL,
  city text NOT NULL,
  latitude double precision NOT NULL CHECK(latitude BETWEEN 4.5 AND 11.5),
  longitude double precision NOT NULL CHECK(longitude BETWEEN -3.5 AND 1.5),
  geom geography(Point, 4326) NOT NULL,
  coordinate_kind text NOT NULL DEFAULT 'mapped_point',
  source text NOT NULL,
  source_id text,
  license text NOT NULL DEFAULT 'ODbL 1.0',
  verification_status text NOT NULL DEFAULT 'source_verified',
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  entrance jsonb,
  popularity integer NOT NULL DEFAULT 50 CHECK(popularity BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spatial_landmarks_geom_gix ON spatial_landmarks USING gist(geom);
CREATE INDEX IF NOT EXISTS spatial_landmarks_trgm_idx ON spatial_landmarks USING gin(search_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS spatial_landmarks_name_trgm_idx ON spatial_landmarks USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS spatial_landmarks_fts_idx ON spatial_landmarks USING gin(to_tsvector('simple', search_name));
CREATE INDEX IF NOT EXISTS spatial_landmarks_region_idx ON spatial_landmarks(region, category);
CREATE INDEX IF NOT EXISTS spatial_landmarks_locality_idx ON spatial_landmarks(locality);
