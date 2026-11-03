#!/bin/sh
# Downloads the Ghana OpenStreetMap extract and records its checksum for the build scripts.
set -eu
data=${1:-"$HOME/ghana-map-data"}
mkdir -p "$data"
source_url=https://download.geofabrik.de/africa/ghana-latest.osm.pbf
curl --fail --location --retry 3 --connect-timeout 20 --max-time 90 --output "$data/ghana-latest.osm.pbf.md5" "$source_url.md5"
expected=$(cut -d' ' -f1 "$data/ghana-latest.osm.pbf.md5")
if [ -e "$data/ghana-latest.osm.pbf" ]; then
  [ "$(md5sum "$data/ghana-latest.osm.pbf" | cut -d' ' -f1)" = "$expected" ] || { echo 'Existing Ghana extract differs; move it aside before downloading' >&2; exit 1; }
else
  curl --fail --location --retry 3 --connect-timeout 20 --max-time 1800 --output "$data/ghana-latest.osm.pbf.partial" "$source_url"
  [ "$(md5sum "$data/ghana-latest.osm.pbf.partial" | cut -d' ' -f1)" = "$expected" ] || { echo 'Ghana extract checksum mismatch' >&2; exit 1; }
  mv "$data/ghana-latest.osm.pbf.partial" "$data/ghana-latest.osm.pbf"
fi
sha=$(sha256sum "$data/ghana-latest.osm.pbf" | cut -d' ' -f1)
printf '{"source":"%s","downloadedAtUtc":"%s","sha256":"%s"}\n' "$source_url" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sha" > "$data/ghana-source.json"
cat "$data/ghana-source.json"
