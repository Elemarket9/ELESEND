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
if test -e "$task_data/ghana-latest.osrm"; then
  echo 'Preserve the existing graph in a dated directory before rebuilding.' >&2
  exit 1
fi
task_image=ghcr.io/project-osrm/osrm-backend:v26.10.0
docker run --rm --network none --mount "type=bind,source=$task_data,target=/data" "$task_image" osrm-extract -p /opt/car.lua /data/ghana-latest.osm.pbf
docker run --rm --network none --mount "type=bind,source=$task_data,target=/data" "$task_image" osrm-partition /data/ghana-latest.osrm
docker run --rm --network none --mount "type=bind,source=$task_data,target=/data" "$task_image" osrm-customize /data/ghana-latest.osrm
echo 'Car graph prepared. This is not a verified motorcycle/bicycle/truck graph.'
