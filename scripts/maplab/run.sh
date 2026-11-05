#!/usr/bin/env bash
R=$PWD; O=/tmp/out; mkdir -p $O; exec > >(tee $O/log.txt) 2>&1
export GHANA_MAP_DATA=$HOME/live MAP_REFRESH_NO_RESTART=1 ELESEND_ENV_FILE=/dev/null MAP_REFRESH_ROADS_FILE=/tmp/none.osm MAP_REFRESH_MIN_FREE_GB=4
echo '<osm></osm>' > /tmp/none.osm; docker pull -q ghcr.io/project-osrm/osrm-backend:v26.4.0 >/dev/null
mkdir -p $HOME/live; echo keep > $HOME/live/marker
MAP_REFRESH_MIN_ROUTE_METERS=99999999 bash deploy/runtime/refresh-map.sh 2>&1 | tail -2; echo "exit=${PIPESTATUS[0]}"; cat $HOME/live/marker; test -e $HOME/live.next && echo NEXT-LEFT; ls $HOME | tr '\n' ' '; true
