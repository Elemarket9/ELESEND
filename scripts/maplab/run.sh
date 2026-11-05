#!/usr/bin/env bash
R=$PWD; O=/tmp/out; mkdir -p $O; exec > >(tee $O/log.txt) 2>&1
npm install --package-lock-only --ignore-scripts --no-audit --no-fund 2>&1 | tail -2; cp package-lock.json $O/package-lock.json; npm view geotiff version; npm view proj4 version
npm ci --ignore-scripts --no-audit --no-fund 2>&1 | tail -1
echo SCAN; node scripts/maplab/scan.mjs
echo REFRESH1; export GHANA_MAP_DATA=$HOME/live MAP_REFRESH_NO_RESTART=1 ELESEND_ENV_FILE=/dev/null MAP_REFRESH_ROADS_FILE=/tmp/none.osm MAP_REFRESH_MIN_FREE_GB=4
echo '<osm></osm>' > /tmp/none.osm
docker pull -q ghcr.io/project-osrm/osrm-backend:v26.4.0 >/dev/null
bash deploy/runtime/refresh-map.sh 2>&1 | tail -5; echo exit=$?; ls -la $HOME/live | head -8 | cut -c24-; du -sh $HOME/live
echo FAILCASE; MAP_REFRESH_SMOKE_TO=-1.6240,70.0 MAP_REFRESH_SMOKE_FROM=-1.6240,71.0 bash deploy/runtime/refresh-map.sh 2>&1 | tail -3; echo "exit=${PIPESTATUS[0]}"; ls $HOME/ | tr '\n' ' '; test -e $HOME/live/ghana.mbtiles && echo live-intact; test -e $HOME/live.next && echo NEXT-LEFT
