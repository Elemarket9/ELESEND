#!/bin/sh
# Named drivable roads customers can search. The point is the road midpoint, never a house number.
# Usage: sh scripts/build-ghana-roads.sh [map-data-dir] [output-file]
set -eu
data=${1:-"$HOME/ghana-map-data"}
root=$(cd "$(dirname "$0")/.." && pwd -P)
out=${2:-"$root/services/api/modules/maps/ghana-osm-roads.json"}
test -f "$data/ghana-latest.osm.pbf" || { echo "Run scripts/download-ghana.sh $data first" >&2; exit 1; }
command -v osmium >/dev/null || { echo 'Install osmium-tool (apt install osmium-tool)' >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
osmium tags-filter "$data/ghana-latest.osm.pbf" \
  w/highway=motorway,trunk,primary,secondary,tertiary,unclassified,residential,living_street,pedestrian,service \
  -o "$work/roads.pbf"
osmium tags-filter "$work/roads.pbf" w/name -o "$work/named.pbf"
osmium export "$work/named.pbf" -f geojsonseq --add-unique-id=type_id -o "$work/named.geojsonseq"
node "$root/scripts/build-ghana-roads.mjs" "$work/named.geojsonseq" "$out"
