#!/usr/bin/env bash
D=$HOME/ghana-map-data; mkdir -p $D; IMG=ghcr.io/project-osrm/osrm-backend:v26.4.0
npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
sh scripts/download-ghana.sh $D >/dev/null 2>&1; docker pull -q $IMG >/dev/null
sh scripts/prepare-ghana-osrm.sh $D 2>&1 | tail -2
docker run -d --name car -p 5000:5000 -v $D:/data $IMG osrm-routed --algorithm mld /data/ghana-latest.osrm >/dev/null
docker run -d --name moto -p 5001:5000 -v $D:/data $IMG osrm-routed --algorithm mld /data/ghana-motorcycle.osrm >/dev/null
sleep 15
NODE_ENV=test node scripts/route-check/check.mjs
