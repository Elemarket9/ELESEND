#!/bin/sh
# Builds a private Photon index for Ghana. Photon is Apache-2.0. Do not point this at a public Nominatim server.
# The owner runs this on the map server. It is not part of application startup.
# 1. Download the Photon jar from https://github.com/komoot/photon/releases (Apache-2.0) into $GHANA_MAP_DATA/photon/photon.jar
# 2. sh scripts/download-ghana.sh "$GHANA_MAP_DATA"
# 3. sh scripts/photon-ghana.sh "$GHANA_MAP_DATA"
# 4. docker compose --profile photon up -d photon
# 5. Set PHOTON_URL=http://photon:2322 on the API. If Photon is down, search continues without it.
set -eu
data=${1:-"$HOME/ghana-map-data"}
test -f "$data/photon/photon.jar" || { echo 'Place the Photon jar at '"$data"'/photon/photon.jar' >&2; exit 1; }
test -f "$data/ghana-latest.osm.pbf" || { echo 'Run scripts/download-ghana.sh first' >&2; exit 1; }
mkdir -p "$data/photon/data"
java -jar "$data/photon/photon.jar" import -osm-file "$data/ghana-latest.osm.pbf" -data-dir "$data/photon/data"
echo 'Photon index is ready. Start it with: docker compose --profile photon up -d photon'
