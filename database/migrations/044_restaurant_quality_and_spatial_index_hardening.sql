-- Migration 044: Restaurant Data Quality Metadata & PostGIS GiST Index Selection Hardening
-- 1. Adds category_group, coordinate_kind, verification_status, and corroborated_sources to mapped_restaurants.
-- 2. Replaces full B-tree idx_mapped_restaurants_registered with a partial index (WHERE is_registered_merchant = TRUE)
--    so PostGIS viewport bounding-box queries with ORDER BY is_registered_merchant DESC always use idx_mapped_restaurants_geom (GiST).
-- 3. Adds GIN trigram indexes on community and district for sub-5ms locality + restaurant search.

ALTER TABLE mapped_restaurants
  ADD COLUMN IF NOT EXISTS category_group TEXT NOT NULL DEFAULT 'restaurants_and_chop_bars',
  ADD COLUMN IF NOT EXISTS coordinate_kind TEXT NOT NULL DEFAULT 'mapped_point',
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'source_coordinates_not_field_verified',
  ADD COLUMN IF NOT EXISTS corroborated_sources TEXT;

DROP INDEX IF EXISTS idx_mapped_restaurants_registered;

CREATE INDEX IF NOT EXISTS idx_mapped_restaurants_registered_true
  ON mapped_restaurants (is_registered_merchant)
  WHERE is_registered_merchant = TRUE;

CREATE INDEX IF NOT EXISTS idx_mapped_restaurants_category_group
  ON mapped_restaurants (category_group);

CREATE INDEX IF NOT EXISTS idx_mapped_restaurants_verification_status
  ON mapped_restaurants (verification_status);

CREATE INDEX IF NOT EXISTS idx_mapped_restaurants_community_trgm
  ON mapped_restaurants USING GIN (community gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_mapped_restaurants_district_trgm
  ON mapped_restaurants USING GIN (district gin_trgm_ops);
