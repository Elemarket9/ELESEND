#!/usr/bin/env bash
D=$HOME/ghana-map-data; mkdir -p $D; IMG=ghcr.io/project-osrm/osrm-backend:v26.4.0
npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
sh scripts/download-ghana.sh $D >/dev/null 2>&1; docker pull -q $IMG >/dev/null
sh scripts/prepare-ghana-osrm.sh $D 2>&1 | tail -1
docker run -d --name car -p 5000:5000 -v $D:/data $IMG osrm-routed --algorithm mld /data/ghana-latest.osrm >/dev/null
docker run -d --name moto -p 5001:5000 -v $D:/data $IMG osrm-routed --algorithm mld /data/ghana-motorcycle.osrm >/dev/null
docker run -d --name pg -p 5432:5432 -e POSTGRES_PASSWORD=t -e POSTGRES_USER=elesend -e POSTGRES_DB=elesend_test_lab postgis/postgis:18-3.6 >/dev/null
sleep 25
NODE_ENV=production TEST_DATABASE_URL=postgres://elesend:t@127.0.0.1:5432/elesend_test_lab DATABASE_URL=postgres://elesend:t@127.0.0.1:5432/elesend_test_lab DATABASE_SSL=false node scripts/order-test/order.mjs 2>&1 | tail -60
