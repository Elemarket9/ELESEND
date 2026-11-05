#!/usr/bin/env bash
R=$PWD; D=$HOME/ghana-map-data; O=/tmp/out; mkdir -p $O/screens $D; exec > >(tee $O/log.txt) 2>&1
IMG=ghcr.io/project-osrm/osrm-backend:v26.4.0
npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1; echo deps $?
sh scripts/download-ghana.sh $D >/dev/null 2>&1; sh scripts/build-ghana-tiles.sh $D >/dev/null 2>&1; docker pull -q $IMG >/dev/null; sh scripts/prepare-ghana-osrm.sh $D 2>&1 | tail -1
docker run -d --name car -p 5000:5000 -v $D:/data $IMG osrm-routed --algorithm mld /data/ghana-latest.osrm >/dev/null
docker run -d --name moto -p 5001:5000 -v $D:/data $IMG osrm-routed --algorithm mld /data/ghana-motorcycle.osrm >/dev/null
docker run -d --name pg -p 5432:5432 -e POSTGRES_PASSWORD=t -e POSTGRES_USER=elesend -e POSTGRES_DB=elesend_test_lab postgis/postgis:18-3.6 >/dev/null
GHANA_MBTILES=$D/ghana.mbtiles MAP_PORT=3145 node services/maps/tile-server.mjs >/dev/null 2>&1 &
sleep 20
mkdir -p /tmp/ui && cd /tmp/ui && npm init -y >/dev/null
npm i --silent react@19.1.0 react-dom@19.1.0 react-native-web@0.21.1 esbuild@0.25 playwright@1.48 maplibre-gl@4.7.1 >/dev/null 2>&1
npx playwright install --with-deps chromium >/dev/null 2>&1
ln -sfn /tmp/ui/node_modules "$R/apps/node_modules"
EXPO_PUBLIC_ELESEND_API_BASE_URL=https://ui.test NODE_PATH=/tmp/ui/node_modules ROOT="$R" node "$R/scripts/kasoa/build.cjs" 2>&1 | tail -6; ls -la /tmp/ui/*.js | cut -c24-
cd $R; TEST_DATABASE_URL=postgres://elesend:t@127.0.0.1:5432/elesend_test_lab NODE_PATH=/tmp/ui/node_modules node scripts/kasoa/journey.mjs 2>&1 | tee $O/journey.txt
pkill -f tile-server || true
docker rm -f car moto pg >/dev/null 2>&1 || true
