#!/bin/sh
# Loads the checked landmark files into spatial_landmarks. Usage: DATABASE_URL=... sh scripts/import-landmarks.sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
cd "$(dirname "$0")/.."
FILES="data/spatial_landmarks_v9_import.tsv"
[ -f data/spatial_landmarks_osm_regions.tsv ] && FILES="$FILES data/spatial_landmarks_osm_regions.tsv"
node scripts/check-landmarks.mjs $FILES
COLUMNS="id,name,search_name,category,subcategory,region,locality,city,latitude,longitude,geom,coordinate_kind,source,source_id,verification_status,aliases,entrance,popularity,street,created_at,updated_at"
for file in $FILES; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\\copy spatial_landmarks ($COLUMNS) FROM '$file' WITH (FORMAT csv, DELIMITER E'\\t', QUOTE '\"', NULL '\\N')"
done
psql "$DATABASE_URL" -c "SELECT count(*) AS landmarks, count(DISTINCT region) AS regions FROM spatial_landmarks"
