#!/bin/sh
# Adds approved rider-found roads to the Ghana map data. Run before rebuilding tiles and routing graphs.
# Usage: merge-rider-roads.sh DATA_DIR rider-roads.osm
set -eu
data=$(cd "${1:?data directory}" && pwd -P)
roads=${2:?rider roads file}
cp "$roads" "$data/rider-roads.osm"
[ -e "$data/ghana-original.osm.pbf" ] || cp "$data/ghana-latest.osm.pbf" "$data/ghana-original.osm.pbf"
docker run --rm --network bridge --mount "type=bind,source=$data,target=/data" debian:bookworm-slim sh -c \
  'apt-get update -qq && apt-get install -y -qq osmium-tool >/dev/null && osmium sort -O -o /data/rider-roads.sorted.osm.pbf /data/rider-roads.osm && osmium merge -O -o /data/ghana-merged.osm.pbf /data/ghana-original.osm.pbf /data/rider-roads.sorted.osm.pbf && chmod 644 /data/ghana-merged.osm.pbf'
mv "$data/ghana-merged.osm.pbf" "$data/ghana-latest.osm.pbf"
sum=$(sha256sum "$data/ghana-latest.osm.pbf" | cut -d' ' -f1)
node -e 'const fs=require("fs"),[f,s]=process.argv.slice(1);const m=JSON.parse(fs.readFileSync(f));m.sha256=s;fs.writeFileSync(f,JSON.stringify(m,null,2));' "$data/ghana-source.json" "$sum"
echo 'Merged. Move ghana.mbtiles and ghana-*.osrm* aside, then rebuild the tiles and routing graphs.'
