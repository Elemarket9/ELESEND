#!/bin/sh
# Rebuilds the OpenStreetMap places customers can search. Needs osmium-tool and node.
# Usage: sh scripts/build-ghana-places.sh [map-data-dir] [output-file]   (run scripts/download-ghana.sh first)
# The output defaults to services/api/infrastructure/maps/ghana-osm-places.json.
set -eu
data=${1:-"$HOME/ghana-map-data"}
root=$(cd "$(dirname "$0")/.." && pwd -P)
out=${2:-"$root/services/api/infrastructure/maps/ghana-osm-places.json"}
test -f "$data/ghana-latest.osm.pbf" || { echo "Run scripts/download-ghana.sh $data first" >&2; exit 1; }
command -v osmium >/dev/null || { echo 'Install osmium-tool (apt install osmium-tool)' >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
osmium tags-filter "$data/ghana-latest.osm.pbf" \
  nwr/amenity nwr/shop nwr/office nwr/craft nwr/tourism nwr/healthcare nwr/aeroway nwr/public_transport nwr/railway=station \
  nwr/leisure=stadium,park,sports_centre nwr/building=commercial,retail,hospital,school,university,hotel \
  -o "$work/places.pbf"
osmium tags-filter "$work/places.pbf" nwr/name -o "$work/named.pbf"
osmium export "$work/named.pbf" -f geojsonseq --add-unique-id=type_id -o "$work/named.geojsonseq"
node "$root/scripts/build-ghana-places.mjs" "$work/named.geojsonseq" "$out"
