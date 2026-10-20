# Private Ghana map setup

ELESEND's map display uses MapLibre Native with a vector tile set generated from the Ghana OpenStreetMap extract. The app requests tiles only from the URL configured in `EXPO_PUBLIC_ELESEND_VECTOR_TILE_URL`. The backend serves the generated MBTiles file at `/tiles/{z}/{x}/{y}.pbf`; it does not use public OpenStreetMap tile servers or Google map tiles.

The Ghana source and generated tile package are already available outside this repository in `C:\Users\sonofjacob\ghana-map-data`:

- `ghana-latest.osm.pbf` is the Geofabrik Ghana extract with publisher checksum and SHA-256 provenance in `ghana-source.json`.
- `ghana.mbtiles` is the generated vector map, covering zoom levels 0–14.
- `ghana-latest.osrm` (car) and `ghana-motorcycle.osrm` (motorcycle) are created from the same source for the OSRM services.

Do not commit these large data files to the application repository. Keep the source data, MBTiles and OSRM graphs on the map server and mount them read-only into the services. OpenStreetMap data is under ODbL 1.0 and requires attribution to OpenStreetMap contributors. Geofabrik provides the extract download; it is not a map hosting service.

## Generate or refresh data

On Windows PowerShell, `scripts/download-ghana.ps1` downloads the latest Geofabrik extract and validates the publisher MD5 before recording SHA-256 provenance. `scripts/build-ghana-tiles.ps1` uses the pinned Planetiler 0.10.2 release and `deploy/maps/ghana-schema.yml` to build the vector tiles. It refuses to overwrite an existing extract or MBTiles file; preserve dated copies before intentionally refreshing either.

Prepare road routing with Docker Desktop after Docker is installed and running:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-ghana-osrm.ps1
```

The script extracts both `car` and `motorcycle` profiles, preparing `ghana-latest.osrm` and `ghana-motorcycle.osrm`.

## Run the private services

Set `GHANA_MAP_DATA` to the absolute data directory in the deployment environment. Start the normal services with the private map overlay:

```powershell
docker compose -f compose.yaml -f compose.private-maps.yaml up -d --build
```

The vector tile service binds to `127.0.0.1:3145`; put an HTTPS reverse proxy under a domain you control for physical phones. For local Android emulator development, set `EXPO_PUBLIC_ELESEND_VECTOR_TILE_URL=http://10.0.2.2:3145/tiles/{z}/{x}/{y}.pbf` in `apps/mobile/.env`. The app permits HTTP only for local emulator development. Map tiles require HTTPS on real devices.

`ROUTING_PROVIDER_PRIORITY` is locked to `osrm`. Multi-vehicle routing (`ROUTING_OSRM_VEHICLES_JSON`) routes car and motorcycle traffic through their dedicated self-hosted OSRM services.

## Current map & dispatch capabilities

- **Vector Tiles & Font Glyphs**: Draws roads, inland water, land-use areas, buildings and settlements. Font glyphs are served at `/fonts/{fontstack}/{range}.pbf` by the map server for street and locality labels.
- **Full-Text Place Search & Autocomplete**: `/api/v1/maps/search?q=...` searches indexed Ghanaian neighborhoods, markets, transit points, and landmarks (e.g. Accra Mall, East Legon, Kejetia, Circle).
- **Reverse Geocoding**: `/api/v1/maps/reverse?lat=...&lon=...` converts coordinates into human-readable street and locality names with proximity indicators.
- **Turn-by-Turn Rider Navigation**: Riders can launch native turn-by-turn navigation (Google Maps, Waze, Apple Maps) directly from active deliveries with one tap.
- **Public Web Tracking Link**: Senders and recipients can track live delivery progress without the app via `/track/:shipmentId`, featuring real-time map and courier telemetry updates.
- **GhanaPostGPS**: Optional digital address lookup (`AK-484-9321`) validates and locates addresses across Ghana.
