# Standalone fare engine

`deliveryEngine.mjs` exports `calculateDeliveryPrice`, `getSurgeMultiplier`, `validateGhanaBoundary`, and `createFareHandler`. It uses native Node.js APIs and fetch. It does not replace `services/api/pricing.mjs`, alter existing commission policies, write ledger entries, or mount itself into the production API.

## Configuration

Supply `FARE_API_TOKEN` with at least 32 random characters. Keep this server-to-server token out of mobile applications. Use the existing session/role authorization boundary when integrating into the main API instead of shipping a shared token to customers.

Supply `FARE_TARIFFS_JSON` as a JSON object keyed by `motorcycle`, `car`, and `van`. Each configured vehicle has `baseMinor` and `perKmMinor`, with optional `perMinuteMinor`, `perExtraStopMinor`, and `minimumMinor`. All rates are nonnegative integer pesewas. No commercial rates are invented or enabled by default. Configure approved rates before requesting a fare.

Supply `FARE_ROUTES_JSON` with each vehicle mapped to an object containing `endpoint` and `profile`, for example `{"motorcycle":{"endpoint":"http://motorcycle-osrm:5000","profile":"driving"}}`. These are trusted server configuration values, never client input. The graph must actually have been extracted for that vehicle; a profile name in an HTTP URL does not change graph contents. Build and validate graphs independently.

Start with `node deliveryEngine.mjs`. The standalone listener binds to `127.0.0.1:3091` (override the port with `FARE_PORT`). Deploy it behind the existing HTTPS ingress and authorization/rate-limit policy if exposed externally. No listener is started when the module is imported. A single process admits at most eight simultaneous calculations; this is not distributed rate limiting.

## Request

POST `/api/v1/calculate-fare` with `Content-Type: application/json` and `Authorization: Bearer <server-token>`:

```json
{
  "vehicle": "motorcycle",
  "pickup": {"lat": 5.6037, "lng": -0.187},
  "dropoffs": [
    {"lat": 5.616, "lng": -0.176},
    {"lat": 5.635, "lng": -0.162}
  ]
}
```

Only these fields are accepted. Clients cannot set prices, commission, multiplier, clock time, routing endpoints, or estimate policy. Coordinates must be finite numbers. Requests are limited to 16 KiB and 1–10 drop-offs. Compressed bodies, malformed JSON, unexpected keys and invalid coordinates are rejected.

## Pricing math

The engine obtains a directed OSRM distance/duration matrix and greedily selects the closest remaining drop-off. The tour starts at pickup and ends at its final drop-off. It excludes rider travel to pickup and has no return leg. Greedy nearest-neighbor is a bounded heuristic, not a guarantee of the global shortest or cheapest tour.

The subtotal in pesewas is base + rounded-up distance charge + rounded-up route-minute charge + extra-stop charge. The rush surcharge applies to the subtotal, rounded half-up to pesewas, followed by the minimum fare floor. Commission is rounded half-up at 20% of that final fare. Driver earnings equal final fare minus commission, ensuring both amounts sum exactly to the total. Integer minor-unit fields are authoritative; GHS fields are presentation values. This is the fare allocation before any taxes, PSP fees, refunds, bonuses, or operating expenses—not a paid or settled rider balance.

Scheduled rush windows are `[07:00,09:00)` and `[16:00,19:00)` in `Africa/Accra`. Approximate circles around Accra (45 km) and Kumasi (35 km) select the city rule. These are explicit provisional zones, not validated administrative boundaries. The surcharge is 1.4 in those windows/zones and 1.0 otherwise. It is not measured supply/demand surge or live traffic prediction.

The Ghana envelope is inclusive latitude 4.7–11.2 and longitude -3.3–1.2. It rejects `(0,0)` and far-away coordinates but still includes some ocean and neighboring territory. Actual Ghana-only or service-zone enforcement needs a polygon and coverage checks.

## Estimates and booking

OSRM failures produce an error by default. `FARE_ALLOW_ESTIMATES=true` permits a clearly labeled Haversine preview for non-authoritative outages. Disconnected routes remain errors. Haversine returns no duration; when the tariff charges per minute, the engine rejects the estimate rather than omitting that charge silently.

Every successful result has `pricingStatus: "preview"` and `requiresBookingQuote: true`. Haversine additionally has `estimateOnly: true`. Before booking, the main API must validate capacity/eligibility, persist the selected vehicle, route/tariff/surcharge versions, authenticated owner, expiry and immutable accepted amount. This module does not implement multi-parcel custody/dispatch, demand-based surge, waiting-event billing, mid-trip repricing, financial settlement, or distributed infrastructure. Those are required integration work before calling the whole system enterprise-ready.

## Verification

Run `node --test tests/delivery-engine-preview.test.mjs`. Six focused tests pass, covering rush boundaries/cities, coordinate rejection, directed route and exact split arithmetic, fail-closed/estimate behavior, disconnected routes, and actual HTTP authentication/body validation. No real OSRM service, provider, device or production environment was exercised.
