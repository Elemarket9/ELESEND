#!/bin/sh
# Loads the checked landmark files into spatial_landmarks. Usage: DATABASE_URL=... sh scripts/import-landmarks.sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
cd "$(dirname "$0")/.."
FILES="data/spatial_landmarks_v9_import.tsv"
[ -f data/spatial_landmarks_osm_regions.tsv ] && FILES="$FILES data/spatial_landmarks_osm_regions.tsv"
node scripts/check-landmarks.mjs $FILES
COLUMNS="id,name,search_name,category,subcategory,region,locality,city,latitude,longitude,geom,coordinate_kind,source,source_id,verification_status,aliases,entrance,popularity,street,created_at,updated_at"
# Safe to run again: existing records, including any later corrections, are left alone.
for file in $FILES; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
CREATE TEMP TABLE landmark_import (LIKE spatial_landmarks INCLUDING DEFAULTS) ON COMMIT DROP;
\\copy landmark_import ($COLUMNS) FROM '$file' WITH (FORMAT csv, DELIMITER E'\\t', QUOTE '"', NULL '\\N')
INSERT INTO spatial_landmarks ($COLUMNS) SELECT $COLUMNS FROM landmark_import ON CONFLICT (id) DO NOTHING;
COMMIT;
SQL
done
psql "$DATABASE_URL" -c "SELECT count(*) AS landmarks, count(DISTINCT region) AS regions FROM spatial_landmarks"
