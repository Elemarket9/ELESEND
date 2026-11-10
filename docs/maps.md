# ELESEND maps: how they work and how to improve them

ELESEND runs its own maps. Customers search for places, riders get turn-by-turn directions, and prices and ETAs come from road routes. No outside map company is needed.

## The parts

| Part | What it does | Where it lives |
|---|---|---|
| Place search | Finds what the customer types, such as "GTBank Kasoa" or "Domestic Terminal" | `services/api/infrastructure/maps/ghana-geocoder.mjs`, served at `GET /api/v1/maps/search` |
| Built-in places | About 44,500 settlements, businesses and landmarks shipped with the API | `ghana-gazetteer-data.json` |
| OpenStreetMap places | Named businesses and landmarks from the latest Ghana OpenStreetMap data, rebuilt every night on each server | `ghana-osm-places.json` in the map data folder, built by `scripts/build-ghana-places.sh` |
| Hand-added places | Places a person checked, each with where its position came from | `ghana-places-overlay.json` |
| Database places | Places approved into the database, including places riders taught the map | `spatial_landmarks` and `national_businesses`, merged into search by `searchPlaces` |
| Reverse lookup | Turns a dropped pin into a readable address | `GET /api/v1/maps/reverse` |
| GhanaPostGPS | Optional lookup of digital addresses such as GL-142-1585 | `POST /api/v1/maps/ghanapostgps`; set `GHANAPOSTGPS_LOOKUP_ENABLED` and `GHANAPOSTGPS_LOOKUP_URL` |
| Road routing | Road distance, travel time and turn-by-turn directions, with separate car and motorbike roads | OSRM, built by `scripts/prepare-ghana-osrm.sh`; set `ROUTING_OSRM_CAR_URL` and `ROUTING_OSRM_MOTORCYCLE_URL` |
| Map learning | Turns rider trips and rider reports into candidate roads and landmarks; staff approve them | `services/api/infrastructure/maps/egia/` |
| Quality checks | Searches and routes that must keep working | `config/map-quality.json`, run by `scripts/map-quality.mjs` |

Every optional piece fails soft. If a data file is missing, search runs on the rest. If the database is slow, search answers from the built-in places. If GhanaPostGPS or routing is not configured, the server still starts and logs a warning.

## What search does when the built-in places fall short

Search is not limited to the places compiled into the server.

- **Nothing matches.** Search returns no results instead of loose look-alikes, so the app can offer a map pin.
- **A business typed with its area** ("Spintex Shoprite"). When no single place holds both, search finds the area and then the nearest places of that name within 8 km. Their label starts with "Near".
- **The best built-in result leaves a typed word unmatched.** Search also asks Photon, when `PHOTON_URL` is set. Photon holds every street and named place on the map. A Photon place that holds every typed word goes first; the rest follow the built-in results. Street searches ask Photon as before.

To turn Photon on, build its Ghana index with `scripts/photon-ghana.sh`, start the `photon` profile in `deploy/runtime/compose.yaml` and set `PHOTON_URL`.

## Adding a place customers can't find

1. **It's on OpenStreetMap.** It arrives in ELESEND the next morning, after the nightly refresh.
2. **It's not on OpenStreetMap.** Add it to OpenStreetMap at openstreetmap.org (this improves the map for everyone), and add it to `ghana-places-overlay.json` in the meantime:

   ```json
   {"name": "GTBank Kasoa Branch (New Market)", "category": "bank", "locality": "Kasoa", "city": "Kasoa", "region": "Central",
    "latitude": 5.5367, "longitude": -0.4215, "popularity": 80, "aliases": ["GT Bank Kasoa", "GTB Kasoa"],
    "positionSource": "Where this position came from", "checkedOn": "2026-11-08", "precision": "area"}
   ```

   `precision` is one of `entrance`, `building`, `street` or `area`. The test `tests/map-place-overlay.test.mjs` refuses entries without a source, a date or a precision.
3. **Riders find it on the job.** Rider reports become candidate landmarks. Once staff approve one, it appears in customer search straight away. No release is needed.

Then add the search to `config/map-quality.json`, so it can never silently break again:

```json
{"query": "GTBank Kasoa", "first": "GTBank Kasoa"}
```

## Daily automatic updates

Geofabrik publishes a fresh Ghana OpenStreetMap extract every day, and ELESEND picks it up every night on its own.

**On the server** (`deploy/runtime/refresh-map.sh`, run by `elesend-map-refresh.timer` at 02:30 each day), the refresh:

1. downloads the extract and checks its checksum
2. adds approved rider roads
3. rebuilds the map tiles, both road graphs and the searchable places
4. tests a long route (Accra to Kumasi) on both graphs, and checks the new places against `config/map-quality.json`
5. swaps the new map in, restarts the map services and the API (a few seconds, at the quietest hour), and keeps the previous map

If the road test fails, the live map is left untouched. If the places fail their checks, roads still update and yesterday's places are kept. If the new map does not come up, the refresh switches back to the previous one.

Setup on the server, once:

```sh
sudo apt install osmium-tool openjdk-21-jre-headless
echo "ELESEND_ROOT=/path/to/ELESEND" | sudo tee /etc/elesend/map-refresh.env
sudo cp deploy/runtime/elesend-map-refresh.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now elesend-map-refresh.timer
```

Keep at least 6 GB free on the map disk (`MAP_REFRESH_MIN_FREE_GB`). Check the last run with `journalctl -u elesend-map-refresh`.

**On GitHub** (`.github/workflows/map-refresh.yml`, daily at 01:41 UTC), the same map is rebuilt from that day's data and every check runs. Nothing is committed. A failed run means that day's OpenStreetMap data would break a search or route, and GitHub emails you. The built places file is kept for 7 days as a download on the run page. The generated places file is never committed, because a new copy every day would grow the repository by gigabytes a year.

## Checking routes after a change

```sh
ROUTING_OSRM_CAR_URL=http://127.0.0.1:5001 ROUTING_OSRM_MOTORCYCLE_URL=http://127.0.0.1:5002 node scripts/map-quality.mjs --routes-required
```

Each route must be at least as long as the straight line, no more than 2.5 times longer, and average 8 to 90 km/h. A route can also carry its own expected range. For example, the Airport Domestic Terminal to GTBank Kasoa route must be 30 to 40 km (measured at 34.3 km on 2026-11-08).

## Where to go next

- **Turn on GhanaPostGPS lookup.** Many Ghanaian businesses publish a digital address but are not on any map.
- **Ask businesses for their pin.** When a business signs up, take its entrance pin and add it as an `entrance` precision place.
- **Add customer reports.** The rider report flow could gain a matching "I couldn't find this place" button for customers, with staff approving.
- **Add more quality checks.** Every wrong search or route a customer reports should become a line in `config/map-quality.json`.

Map data © OpenStreetMap contributors, available under the Open Database Licence. The apps already show this credit on the map.
