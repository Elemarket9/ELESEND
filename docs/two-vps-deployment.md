# ELESEND: isolated app VPS and map VPS

This is an **opt-in** two-VPS deployment. The existing `deploy/runtime/compose.yaml` single-server stack remains available; do not start it unchanged on both hosts.

## Architecture and isolation

- App VPS: API, payments, PostgreSQL/PostGIS, Redis, Caddy. Its storage contains no large routing graphs, tile rebuilds or map history.
- Map VPS: tile service, OSRM car and motorcycle, optional Photon, map refresh, map data on a dedicated persistent filesystem.
- One GitHub repository is fine. **Do not** run `git pull && docker compose up -d` indiscriminately on both servers. Each server uses its own pinned checkout/release and Compose command. Avoid automatic deploy-on-push until reviewed.
- A private WireGuard or equivalent VPN links the hosts. Route and Photon ports bind ONLY to the VPN interface; also firewall to the app VPS VPN address. **Never** set `MAP_PRIVATE_BIND_IP` to `0.0.0.0` or an internet-facing IP. Public map TLS is through Caddy on 443 only.
- DNS: `api.` / `app.` / `admin.` point to the app VPS; `maps.` points to the map VPS. These are examples, not actual domain records.

## Prepare the map VPS

Install Docker with Compose, set up VPN, DNS and persistent storage; configure backups/alerts and a disk quota or dedicated filesystem for the map data. Replace example hostnames/IPs below with real values.

Use an **absolute** path on a dedicated map data filesystem; never `/` and never the app database volume.

```sh
export GHANA_MAP_DATA=/srv/elesend-map-data
export MAP_PRIVATE_BIND_IP=10.100.0.2  # illustrative private VPN IP
export MAPS_HOST=maps.example.com
mkdir -p "$GHANA_MAP_DATA"
# Build validated map data first using scripts/; production boot requires existing
# ghana.mbtiles, ghana-latest.osrm* and ghana-motorcycle.osrm*.
docker compose --env-file .env.map -f deploy/runtime/compose.map-vps.yaml config -q
docker compose --env-file .env.map -f deploy/runtime/compose.map-vps.yaml up -d --build
# Photon only after the index has been prepared:
# docker compose --env-file .env.map -f deploy/runtime/compose.map-vps.yaml --profile photon up -d
```

Store these example values in a **server-local** `.env.map` rather than relying on exported shell variables when running Compose. A separate `ELESEND_ENV_FILE` can point the refresh script to it. The map VPS does **not** need app payment secrets or its PostgreSQL database.

## Prepare the app VPS

Set the existing production secrets, database volumes and app origin; use `.env.runtime` with:

```dotenv
ROUTING_OSRM_CAR_URL=http://10.100.0.2:5001
ROUTING_OSRM_MOTORCYCLE_URL=http://10.100.0.2:5002
PHOTON_URL=http://10.100.0.2:2322
MAPS_PUBLIC_ORIGIN=https://maps.example.com
```

Here the HTTP URLs are **only acceptable inside an encrypted authenticated VPN**, with firewall restrictions; do not expose them on the public internet. Omit `PHOTON_URL` if Photon is not ready.

```sh
docker compose --env-file .env.runtime \
  -f deploy/runtime/compose.yaml \
  -f deploy/runtime/compose.app-vps.yaml config -q
docker compose --env-file .env.runtime \
  -f deploy/runtime/compose.yaml \
  -f deploy/runtime/compose.app-vps.yaml up -d --build
```

IMPORTANT: In the app-vps overlay, `osrm`, `osrm-motorcycle`, `maps`, and `photon` are assigned to an inactive profile. **Never run with `--profile single-vps-map` on the app VPS**. Remove legacy map containers previously created by the single-VPS stack only after verifying that the new maps are online; use carefully scoped removal, never `docker compose down -v`. Validate the effective Compose config before starting.

## Dedicated map refresh

`deploy/runtime/refresh-map.sh` supports `MAP_REFRESH_MODE=dedicated`. It uses the map-only Compose file, does not call the app API, does not load places into the app database, and does not restart the ELESEND API.

The app VPS owns approved rider-road reports. Export them **on the app VPS** with the repo's existing `scripts/export-rider-roads.mjs`, then transfer the output securely and atomically to the map VPS via SSH/VPN. Set `MAP_REFRESH_ROADS_FILE` to the verified local export path on the map VPS. If no approved roads exist, supply a deliberately empty, valid OSM document rather than silently losing roads. Never accept arbitrary untrusted XML as map-build input.

Example systemd environment at `/etc/elesend/map-refresh.env` on **map VPS only**:

```dotenv
ELESEND_ROOT=/opt/ELESEND
ELESEND_ENV_FILE=/opt/ELESEND/.env.map
MAP_REFRESH_MODE=dedicated
GHANA_MAP_DATA=/srv/elesend-map-data
MAP_PRIVATE_BIND_IP=10.100.0.2
MAP_REFRESH_ROADS_FILE=/srv/elesend-input/rider-roads-input.osm
MAP_REFRESH_MIN_FREE_GB=30
```

The daily timer should be enabled **only** on the map VPS. Disable the previous map-refresh timer on the app VPS, otherwise its old deployment may still rebuild and restart API containers.

Map refresh uses staged data, route smoke tests, swaps and rollback. Restrict stale backups and intermediate files. Provision enough space for the live map, next build, previous version and preprocessing files; a 30 GB minimum free-space setting alone is **not** a capacity guarantee. Monitor inode usage and disk alerts, and keep off-server backups with restore drills.

**Search data caveat:** ELESEND has embedded gazetteer and DB-backed landmarks. The main API also reads `GHANA_OSM_PLACES_FILE` from its local `/map-data` mount, and may cache it in memory. The map VPS refresh **does not automatically propagate this file or newly learned locations to the app VPS**. Implement/test a small, authenticated, versioned place-data sync plus reload mechanism separately before claiming daily search updates are fully independent. Avoid syncing large tiles/graphs back to the app VPS.

## Verification and rollback

Before using live riders/payments:

1. Confirm separate Compose projects and only intended containers on each VPS; confirm no app DB/map-data cross-host mount.
2. Check VPN routing from app VPS to private OSRM/Photon; confirm OSRM/Photon are inaccessible from public IPs.
3. Validate HTTPS tiles from the phone and OSRM routes (car + motorbike) from the main API. Run existing `scripts/map-quality.mjs` with the VPN URL endpoints.
4. Simulate map refresh, forced graph failure, low-disk failure, rollback and map VPS outage. Confirm the main API is not restarted and transactional workloads remain available, while routing failures return bounded errors.
5. Confirm DNS, TLS, payment callbacks, backups and restore before any public production operation.

This change was made in GitHub source configuration only. It is **not** proof that either VPS is provisioned, that road graphs are built, or that live end-to-end connectivity has passed.
