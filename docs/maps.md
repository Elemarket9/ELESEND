# ELESEND maps: how they work and how to improve them

ELESEND runs its own maps. Customers search for places, riders get turn-by-turn directions, and prices and ETAs come from road routes. No outside map company is needed.

## The parts

| Part | What it does | Where it lives |
|---|---|---|
| Place search | Finds what the customer types, such as "GTBank Kasoa" or "Domestic Terminal" | `services/api/infrastructure/maps/ghana-geocoder.mjs`, served at `GET /api/v1/maps/search` |
| Built-in places | About 44,500 settlements, businesses and landmarks shipped with the API | `ghana-gazetteer-data.json` |
| OpenStreetMap places | Named businesses and landmarks from the latest Ghana OpenStreetMap data, rebuilt monthly | `ghana-osm-places.json`, built by `scripts/build-ghana-places.sh` |
| Hand-added places | Places a person checked, each with where its position came from | `ghana-places-overlay.json` |
| Database places | Places approved into the database, including places riders taught the map | `spatial_landmarks` and `national_businesses`, merged into search by `searchPlaces` |
| Reverse lookup | Turns a dropped pin into a readable address | `GET /api/v1/maps/reverse` |
| GhanaPostGPS | Optional lookup of digital addresses such as GL-142-1585 | `POST /api/v1/maps/ghanapostgps`; set `GHANAPOSTGPS_LOOKUP_ENABLED` and `GHANAPOSTGPS_LOOKUP_URL` |
| Road routing | Road distance, travel time and turn-by-turn directions, with separate car and motorbike roads | OSRM, built by `scripts/prepare-ghana-osrm.sh`; set `ROUTING_OSRM_CAR_URL` and `ROUTING_OSRM_MOTORCYCLE_URL` |
| Map learning | Turns rider trips and rider reports into candidate roads and landmarks; staff approve them | `services/api/infrastructure/maps/egia/` |
| Quality checks | Searches and routes that must keep working | `config/map-quality.json`, run by `scripts/map-quality.mjs` |

Every optional piece fails soft. If a data file is missing, search runs on the rest. If the database is slow, search answers from the built-in places. If GhanaPostGPS or routing is not configured, the server still starts and logs a warning.

## Adding a place customers can't find

1. **It's on OpenStreetMap.** It arrives with the next map refresh, or you can run the refresh by hand from the Actions tab ("Map refresh", then "Run workflow").
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

## The monthly map refresh

`.github/workflows/map-refresh.yml` runs on the 3rd of each month and can also be started by hand. It:

1. downloads the Ghana extract from Geofabrik and checks its checksum
2. rebuilds the OpenStreetMap places
3. builds the car and motorbike road graphs
4. runs every search and route in `config/map-quality.json` against the new data
5. opens a pull request with the new places file and the check results

Review the counts in the pull request and merge it. Servers rebuild their own road graphs with `scripts/download-ghana.sh` and `scripts/prepare-ghana-osrm.sh`, then restart OSRM. If GitHub stops Actions from opening pull requests, the workflow still pushes the branch and says so. You can allow it under Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests".

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
