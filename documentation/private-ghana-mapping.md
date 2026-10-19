# Private Ghana map setup

ELESEND's map display uses MapLibre Native with a vector tile set generated from the Ghana OpenStreetMap extract. The app requests tiles only from the URL configured in `EXPO_PUBLIC_ELESEND_VECTOR_TILE_URL`. The backend serves the generated MBTiles file at `/tiles/{z}/{x}/{y}.pbf`; it does not use public OpenStreetMap tile servers or Google map tiles.

The Ghana source and generated tile package are already available outside this repository in `C:\Users\sonofjacob\ghana-map-data`:

- `ghana-latest.osm.pbf` is the Geofabrik Ghana extract with publisher checksum and SHA-256 provenance in `ghana-source.json`.
- `ghana.mbtiles` is the generated vector map, covering zoom levels 0–14.
- `ghana-latest.osrm` is created separately from the same source before enabling the OSRM service.

Do not commit these large data files to the application repository. Keep the source data, MBTiles and OSRM graph on the map server and mount them read-only into the services. OpenStreetMap data is under ODbL 1.0 and requires attribution to OpenStreetMap contributors. Geofabrik provides the extract download; it is not a map hosting service.

## Generate or refresh data

On Windows PowerShell, `scripts/download-ghana.ps1` downloads the latest Geofabrik extract and validates the publisher MD5 before recording SHA-256 provenance. `scripts/build-ghana-tiles.ps1` uses the pinned Planetiler 0.10.2 release and `deploy/maps/ghana-schema.yml` to build the vector tiles. It refuses to overwrite an existing extract or MBTiles file; preserve dated copies before intentionally refreshing either.

Prepare road routing with Docker Desktop after Docker is installed and running:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-ghana-osrm.ps1
```

The OSRM graph uses `car.lua`. Motorcycle, bicycle, van and truck routes have not been verified and are not configured in the private overlay.

## Run the private services

Set `GHANA_MAP_DATA` to the absolute data directory in the deployment environment. Start the normal services with the private map overlay:

```powershell
docker compose -f compose.yaml -f compose.private-maps.yaml up -d --build
```

The vector tile service binds to `127.0.0.1:3145`; put an HTTPS reverse proxy under a domain you control for physical phones. For local Android emulator development, set `EXPO_PUBLIC_ELESEND_VECTOR_TILE_URL=http://10.0.2.2:3145/tiles/{z}/{x}/{y}.pbf` in `apps/mobile/.env`. The app permits HTTP only for local emulator development. Map tiles require HTTPS on real devices.

`ROUTING_PROVIDER_PRIORITY` is locked to `osrm`. The server does not register the Google Routes adapter, even if an old `GOOGLE_ROUTES_API_KEY` is present. The overlay configures only the car profile. Requests requiring an unavailable vehicle profile fail closed instead of becoming straight-line estimates.

## Current map coverage

The vector style draws roads, inland water, land-use areas, buildings and settlement points. Settlement names exist in tile data but text labels are not drawn because this package has no glyph server. The package contains no satellite imagery, live traffic, geocoder, address search or worldwide coverage. The GhanaPostGPS lookup is a separate optional address-to-coordinate service and stays disabled until configured.

The Ghana PBF and Planetiler tool are free downloads. MapLibre, Planetiler and OSRM are open source. A self-hosted map has no per-tile or per-route API charge; compute, storage, bandwidth, TLS/domain and operations still have hosting costs. The GhanaPostGPS wrapper repository documents a public endpoint but does not state an unlimited free-use grant. Keep that integration disabled until the service operator's usage terms and capacity are confirmed.

## Verification limits

The MBTiles package was previously built from the recorded Ghana extract and checked with real Accra, Kumasi and Tamale vector tiles. Those results apply to the generated package in `C:\Users\sonofjacob\ghana-map-data`. This checkout still needs the OSRM graph preparation step and a Docker run on a Linux-compatible Docker host. Device rendering, HTTPS tile delivery on a physical phone, and production road suitability have not been verified here.
