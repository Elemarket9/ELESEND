#!/bin/sh
# Builds ghana.mbtiles for the tile server. Needs Java 21+, and the extract from download-ghana.sh.
set -eu
data=${1:-"$HOME/ghana-map-data"}
root=$(cd "$(dirname "$0")/.." && pwd -P)
base=https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar
mkdir -p "$data/tools"
[ -e "$data/tools/planetiler.jar" ] || curl --fail --location --retry 2 --max-time 900 --output "$data/tools/planetiler.jar" "$base"
[ -e "$data/tools/planetiler.jar.sha256" ] || curl --fail --location --retry 2 --max-time 90 --output "$data/tools/planetiler.jar.sha256" "$base.sha256"
[ "$(sha256sum "$data/tools/planetiler.jar" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$data/tools/planetiler.jar.sha256")" ] || { echo 'Planetiler checksum mismatch' >&2; exit 1; }
[ -f "$data/ghana-latest.osm.pbf" ] || { echo 'Run scripts/download-ghana.sh first' >&2; exit 1; }
[ ! -e "$data/ghana.mbtiles" ] || { echo 'Move the existing tiles aside before rebuilding' >&2; exit 1; }
java -Xmx3g -jar "$data/tools/planetiler.jar" generate-custom --download "--schema=$root/deploy/maps/ghana-schema.yml" "--osm-local-path=$data/ghana-latest.osm.pbf" "--output=$data/ghana.mbtiles" "--tmpdir=$data/tile-temp" --threads=2 --nodemap-storage=ram --bounds=-3.4,4.5,1.4,11.4
sha256sum "$data/ghana.mbtiles"
