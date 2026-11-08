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
node --input-type=module -e '
import {createReadStream,readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {join} from "node:path";
const d=process.argv[1],meta=JSON.parse(readFileSync(join(d,"ghana-source.json"),"utf8"));
const h=createHash("sha256");
for await(const chunk of createReadStream(join(d,"ghana-latest.osm.pbf")))h.update(chunk);
if(h.digest("hex")!==meta.sha256)throw Error("Ghana source checksum mismatch");
' "$data"
[ ! -e "$data/ghana.mbtiles" ] || { node "$root/scripts/map-artifact-integrity.mjs" verify-tiles "$data/ghana.mbtiles"; echo 'Existing tiles verified; preserve or move aside before rebuilding.' >&2; exit 0; }
[ ! -e "$data/ghana.mbtiles.partial" ] || { echo 'Found interrupted tile generation (.partial); preserve/remove it before rebuilding' >&2; exit 1; }
java -Xmx3g -jar "$data/tools/planetiler.jar" generate-custom "--schema=$root/deploy/maps/ghana-schema.yml" "--osm-local-path=$data/ghana-latest.osm.pbf" "--output=$data/ghana.mbtiles.partial" "--tmpdir=$data/tile-temp" --threads=2 --nodemap-storage=ram --bounds=-3.4,4.5,1.4,11.4
node "$root/scripts/map-artifact-integrity.mjs" verify-tiles "$data/ghana.mbtiles.partial"
mv "$data/ghana.mbtiles.partial" "$data/ghana.mbtiles"
sha256sum "$data/ghana.mbtiles"
