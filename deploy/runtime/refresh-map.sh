#!/usr/bin/env bash
# Rebuilds the map from fresh OpenStreetMap data and approved rider roads, tests it, then swaps it in.
# The live map keeps running during the build. If anything fails, it is left untouched.
# Needs Docker, Java 21+, Node and curl; osmium-tool for searchable places. Runs daily: see deploy/runtime/elesend-map-refresh.timer.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
map_mode=${MAP_REFRESH_MODE:-combined}
case "$map_mode" in
  combined) compose_file="$root/deploy/runtime/compose.yaml" ;;
  dedicated) compose_file="$root/deploy/runtime/compose.map-vps.yaml" ;;
  *) echo "Unsupported MAP_REFRESH_MODE: $map_mode" >&2; exit 2 ;;
esac
env_file=${ELESEND_ENV_FILE:-"$root/.env"}
if [ "$map_mode" = dedicated ] && [ -z "${GHANA_MAP_DATA:-}" ]; then
  echo "Dedicated map refresh requires GHANA_MAP_DATA (absolute path)" >&2; exit 2
fi
live=$(realpath -m "${GHANA_MAP_DATA:-$root/deploy/runtime/map-data}")
if [ "$map_mode" = dedicated ]; then
  case "$live" in
    /*) ;;
    *) echo "Map data path must be absolute" >&2; exit 2 ;;
  esac
  [ "$live" != / ] || { echo "Refusing root map data path" >&2; exit 2; }
fi
next="$live.next"
previous="$live.previous"
image=ghcr.io/project-osrm/osrm-backend:v26.4.0
min_free_gb=${MAP_REFRESH_MIN_FREE_GB:-6}
dc() { docker compose --env-file "$env_file" -f "$compose_file" "$@"; }
say() { echo "[map refresh] $*"; }

mkdir -p "$(dirname "$live")"
exec 9>"$live.lock"
flock -n 9 || { say 'Already running'; exit 0; }
free_gb=$(df -BG --output=avail "$(dirname "$live")" | tail -1 | tr -dc 0-9)
[ "$free_gb" -ge "$min_free_gb" ] || { say "Stopped: ${free_gb} GB free, needs ${min_free_gb} GB"; exit 1; }

rm -rf "$next"; mkdir -p "$next"
trap 'docker rm -f elesend-map-smoke >/dev/null 2>&1 || true; rm -rf "$next"' EXIT
[ -d "$live/tools" ] && cp -r "$live/tools" "$next/tools"

sh "$root/scripts/download-ghana.sh" "$next"

roads_file=${MAP_REFRESH_ROADS_FILE:-}
if [ -z "$roads_file" ]; then
  roads_file="$next/rider-roads-input.osm"
  if [ "$map_mode" = dedicated ]; then
    say "Dedicated map refresh needs MAP_REFRESH_ROADS_FILE exported securely from the app VPS (or an explicit trusted empty OSM input)"; exit 2
  fi
  dc exec -T -e OSRM_URL=http://osrm-motorcycle:5000 api node scripts/export-rider-roads.mjs - > "$roads_file"
fi
if grep -q '<way ' "$roads_file"; then
  sh "$root/scripts/merge-rider-roads.sh" "$next" "$roads_file"
fi

sh "$root/scripts/build-ghana-tiles.sh" "$next"
sh "$root/scripts/prepare-ghana-osrm.sh" "$next"

# Searchable places. Never stops the road refresh: if the build or its checks fail, yesterday's places are kept.
keep_old_places() { if [ -f "$live/ghana-osm-places.json" ]; then cp "$live/ghana-osm-places.json" "$next/ghana-osm-places.json"; fi; }
if ! command -v osmium >/dev/null; then
  say 'osmium-tool is not installed, so searchable places were not rebuilt (apt install osmium-tool)'; keep_old_places
elif ! sh "$root/scripts/build-ghana-places.sh" "$next" "$next/ghana-osm-places.json"; then
  say 'Building searchable places failed. Keeping the previous places'; rm -f "$next/ghana-osm-places.json"; keep_old_places
elif ! GHANA_OSM_PLACES_FILE="$next/ghana-osm-places.json" node "$root/scripts/map-quality.mjs"; then
  say 'New places failed the search checks in config/map-quality.json. Keeping the previous places'; rm -f "$next/ghana-osm-places.json"; keep_old_places
fi
if command -v osmium >/dev/null && [ -f "$next/ghana-latest.osm.pbf" ]; then
  sh "$root/scripts/build-ghana-roads.sh" "$next" "$next/ghana-osm-roads.json" || say 'Named roads were not rebuilt. Search keeps working without the new road index'
fi
if [ "$map_mode" != dedicated ] && [ -n "${DATABASE_URL:-}" ] && [ -f "$next/ghana-osm-places.json" ]; then
  files=("$next/ghana-osm-places.json")
  [ -f "$next/ghana-osm-roads.json" ] && files+=("$next/ghana-osm-roads.json")
  node "$root/scripts/load-search-places.mjs" "${files[@]}" || say 'Database place load failed. Curated search is unchanged'
fi

# Test the new map before anyone uses it.
smoke_point_a=${MAP_REFRESH_SMOKE_FROM:--0.1825,5.5560}
smoke_point_b=${MAP_REFRESH_SMOKE_TO:--1.6240,6.6960}
min_route_m=${MAP_REFRESH_MIN_ROUTE_METERS:-100000} # A broken road network cannot connect Accra to Kumasi.
for graph in ghana-latest ghana-motorcycle; do
  docker rm -f elesend-map-smoke >/dev/null 2>&1 || true
  docker run -d --name elesend-map-smoke --network bridge -p 127.0.0.1:5999:5000 --mount "type=bind,source=$next,target=/data,readonly" "$image" osrm-routed --algorithm mld "/data/$graph.osrm" >/dev/null
  routed=
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "http://127.0.0.1:5999/route/v1/driving/$smoke_point_a;$smoke_point_b?overview=false" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);process.exit(b.code==='Ok'&&b.routes[0].distance>=$min_route_m?0:1)})"; then routed=yes; break; fi
    sleep 2
  done
  docker rm -f elesend-map-smoke >/dev/null
  [ "$routed" = yes ] || { say "Stopped: test route failed on $graph. Live map unchanged"; exit 1; }
done
if [ -e "$live/ghana.mbtiles" ]; then
  old=$(stat -c %s "$live/ghana.mbtiles"); new=$(stat -c %s "$next/ghana.mbtiles")
  [ $((new * 100)) -ge $((old * 80)) ] || { say "Stopped: new map is much smaller than the live one. Live map unchanged"; exit 1; }
fi

restart_map() {
  [ "${MAP_REFRESH_NO_RESTART:-}" = 1 ] && return 0
  dc up -d --no-deps --force-recreate osrm osrm-motorcycle maps
  if [ "$map_mode" = combined ]; then
    # Legacy combined-host flow: the API reads places from this local folder.
    dc up -d --no-deps --force-recreate api
  fi
}
live_map_healthy() {
  [ "${MAP_REFRESH_NO_RESTART:-}" = 1 ] && return 0
  for _ in $(seq 1 30); do
    if [ "$map_mode" = dedicated ]; then
      # OSRM ports are bound only to the map VPS VPN/private interface.
      if curl -fsS --max-time 5 "http://${MAP_PRIVATE_BIND_IP:?Set MAP_PRIVATE_BIND_IP}:5002/route/v1/driving/$smoke_point_a;$smoke_point_b?overview=false" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.exit(JSON.parse(s).code==='Ok'?0:1)}catch{process.exit(1)}})" 2>/dev/null; then return 0; fi
    elif dc exec -T api node -e "fetch('http://osrm-motorcycle:5000/route/v1/driving/$smoke_point_a;$smoke_point_b?overview=false').then(r=>r.json()).then(b=>process.exit(b.code==='Ok'?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then return 0; fi
    sleep 4
  done
  return 1
}

rm -rf "$previous"
[ -e "$live" ] && mv "$live" "$previous"
mv "$next" "$live"
if ! { restart_map && live_map_healthy; }; then
  say 'New map did not come up. Going back to the previous map'
  if [ -e "$previous" ]; then
    rm -rf "$live"; mv "$previous" "$live"; restart_map
  else
    say 'There is no previous map, so the new one stays in place'
  fi
  exit 1
fi
say 'New map is live. The previous one is kept for one more refresh'
