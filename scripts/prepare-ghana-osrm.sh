#!/bin/sh
set -eu
# Run on a Docker host. This builds server routing data, never a mobile binary.
task_data=${1:-"$HOME/ghana-map-data"}
task_data=$(cd "$task_data" && pwd -P)
test -f "$task_data/ghana-latest.osm.pbf"
test -f "$task_data/ghana-source.json"
node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const directory=process.argv[1];
const metadata=JSON.parse(fs.readFileSync(path.join(directory,"ghana-source.json")));
const hash=crypto.createHash("sha256").update(fs.readFileSync(path.join(directory,"ghana-latest.osm.pbf"))).digest("hex");
if(hash!==metadata.sha256)throw Error("Ghana source checksum mismatch");
' "$task_data"

task_image=ghcr.io/project-osrm/osrm-backend:v26.4.0

# 1. Car Graph
if [ -f "$task_data/ghana-latest.osrm.build.json" ]; then
  node "$(cd "$(dirname "$0")/.." && pwd -P)/scripts/map-artifact-integrity.mjs" verify-osrm "$task_data" ghana-latest car
elif [ -e "$task_data/ghana-latest.osrm" ] || [ -e "$task_data/ghana-latest.osrm.partition" ]; then
  echo 'Incomplete/unverified car graph: preserve and remove old ghana-latest.osrm* files before rebuilding' >&2
  exit 1
else
  docker run --rm --network none --mount "type=bind,source=$task_data,target=/data" "$task_image" osrm-extract -p /opt/car.lua /data/ghana-latest.osm.pbf
  docker run --rm --network none --mount "type=bind,source=$task_data,target=/data" "$task_image" osrm-partition /data/ghana-latest.osrm
  docker run --rm --network none --mount "type=bind,source=$task_data,target=/data" "$task_image" osrm-customize /data/ghana-latest.osrm
  node "$(cd "$(dirname "$0")/.." && pwd -P)/scripts/map-artifact-integrity.mjs" record-osrm "$task_data" ghana-latest car
  echo 'Car graph prepared and structurally verified.'
fi

# 2. Motorcycle Graph
if [ -f "$task_data/ghana-motorcycle.osrm.build.json" ]; then
  node "$(cd "$(dirname "$0")/.." && pwd -P)/scripts/map-artifact-integrity.mjs" verify-osrm "$task_data" ghana-motorcycle motorcycle
elif [ -e "$task_data/ghana-motorcycle.osrm" ] || [ -e "$task_data/ghana-motorcycle.osrm.partition" ]; then
  echo 'Incomplete/unverified motorcycle graph: preserve and remove old ghana-motorcycle.osrm* files before rebuilding' >&2
  exit 1
else
  # deploy/maps/motorcycle.lua. Changing the profile requires removing ghana-motorcycle.osrm* and rebuilding.
  cp "$(cd "$(dirname "$0")/.." && pwd -P)/deploy/maps/motorcycle.lua" "$task_data/motorcycle.lua"
  # OSRM names its output after the input, so extract from a copy to keep the car graph intact.
  cp "$task_data/ghana-latest.osm.pbf" "$task_data/ghana-motorcycle.osm.pbf"
  docker run --rm --network none --mount "type=bind,source=$task_data,target=/data" "$task_image" osrm-extract -p /data/motorcycle.lua /data/ghana-motorcycle.osm.pbf
  rm -f "$task_data/ghana-motorcycle.osm.pbf"
  docker run --rm --network none --mount "type=bind,source=$task_data,target=/data" "$task_image" osrm-partition /data/ghana-motorcycle.osrm
  docker run --rm --network none --mount "type=bind,source=$task_data,target=/data" "$task_image" osrm-customize /data/ghana-motorcycle.osrm
  node "$(cd "$(dirname "$0")/.." && pwd -P)/scripts/map-artifact-integrity.mjs" record-osrm "$task_data" ghana-motorcycle motorcycle
  echo 'Motorcycle graph prepared and structurally verified.'
fi

echo 'Private Ghana OSRM routing graphs (car + motorcycle) prepared.'
