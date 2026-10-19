# HTTP API v1

All POST bodies require application/json and a maximum of 32 KiB. Protected endpoints require `Authorization: Bearer <opaque-session-token>`. HTTP errors return `{error}`. Validation errors are 400; authentication 401; authorization 403; missing record 404; state conflicts 409; rate limit 429; unconfigured providers 503. UUIDs must be valid UUID strings. No unrestricted status update endpoint exists.

| Method | Path under /api/v1 | Body / result |
|---|---|---|
| POST | /auth/register | phone, password (12+ chars), kind: customer/business/rider/company, optional name, vehicle, maxWeightG; phoneVerified=false |
| POST | /auth/login | phone, password → token, user |
| POST | /auth/logout | {} → revokes current session |
| GET | /me | authenticated identity |
| POST | /quotes | pickup/destination {address,latitude,longitude}, recipientPhone, weightG, description |
| POST | /shipments | {quoteId}; required Idempotency-Key header (8–128 alphanumeric/underscore/hyphen) |
| GET | /shipments | own scope, newest 100 |
| GET | /shipments/:id | authorized shipment and parcel details |
| POST | /shipments/:id/accept | approved online rider, {} |
| POST | /shipments/:id/pickup-challenge | assigned rider, {} → challengeId |
| POST | /shipments/:id/delivery-challenge | assigned rider, {} → challengeId |
| POST | /shipments/:id/verify | {challengeId,code} |
| POST | /shipments/:id/transition | action: start/fail/return/returned/cancel; reason required except start |
| POST | /shipments/:id/location | {latitude,longitude}, active assigned rider only |
| GET | /shipments/:id/tracking | authorized last location from last 24 hours |
| POST | /shipments/:id/disputes | category: lost/damaged/payment/misconduct/address/other, detail |
| GET | /rider/offers | approved online rider; limited pickup info and proposed entitlement |
| POST | /rider/availability | {online:boolean} |
| GET | /earnings | immutable own/company allocations, all held |
| GET | /admin/review | permission verification:write |
| POST | /admin/riders/:id | {status:approved/suspended/rejected}, verification:write |
| POST | /admin/companies/:id | same status / permission |
| POST | /admin/pricing | {baseMinor,perKmMinor,commissionBps}, pricing:write |
| GET | /company/riders | company owner's scoped fleet |
| POST | /company/invitations | {riderId}; approved company, approved independent rider; returns private token once |
| POST | /rider/invitations/accept | {token}; exact invited rider accepts, 48-hour expiry, no active custody |
| POST | /company/riders/:id/remove | own company rider, no unfinished custody; returns rider to pending/offline |
| POST | /business/api-keys | {name,scopes}; business session; quotes:write, shipments:write, shipments:read |
| POST | /business/api-keys/:id/revoke | owning business session; rotate by creating replacement then revoking old key |

Admin bootstrap grants pricing:write, verification:write and shipments:read. Registration cannot request admin. Permissions are server queried; role/permission management UI and MFA are outstanding. Session expiry is 12 hours. HTTP rate limits use database counters; do not trust arbitrary forwarded IP headers.

Example quote body:

```json
{"pickup":{"address":"Osu main gate","latitude":5.55,"longitude":-0.19},"destination":{"address":"Airport landmark","latitude":5.60,"longitude":-0.17},"recipientPhone":"0241234567","weightG":1000,"description":"Sealed books"}
```

There is no public payment confirmation endpoint. Business keys use the Bearer header, are returned once, stored as SHA-256 digests, expire in 90 days and can access only their configured quote/booking/read scopes. Keys cannot create other keys, change roles or access rider/company/admin operations. Tenant binding remains the business owner identity. Business memberships/bulk booking, webhook subscriptions and marketplace authority integration are not implemented. The business API is partial pending signed webhook delivery and integration-provider verification.

## Intelligent dispatch extension (October 2026)

See `README.md` and `documentation/intelligent-dispatch-audit.md`. These endpoints require the existing bearer session, and are only active when `ROUTING_OSRM_URL` configures a road adapter.

* `POST /api/v1/rider/location`: `{latitude:5.58,longitude:-0.21,accuracyMeters:10,observedAt:"2026-10-17T19:00:00Z",headingDegrees:90,speedMps:4}`; approved online rider only. Values shown are illustration, not a replayable live timestamp.
* `GET /api/v1/rider/dispatch-settings`: returned upload scheduling parameters.
* `GET /api/v1/rider/offers`: list only authenticated rider's unexpired offers; pickup/destination, road ETA, charge, commission, earnings.
* `POST /api/v1/shipments/:id/accept`: `{offerId:"<UUID>"}`; exclusive actor-bound, unexpired offer mandatory.
* `POST /api/v1/rider/offers/decline`: `{shipmentId:"<UUID>",offerId:"<UUID>"}`.
* `POST /api/v1/rider/assignments/release`: `{shipmentId:"<UUID>",reason:"Cannot safely reach pickup"}`; before custody only.
* `POST /api/v1/delivery/availability`: `{pickup:{latitude:5.58,longitude:-0.21},weightG:900,parcelCategory:"general",parcelSize:"small"}`; indicative only, authenticated customer/business.
* `GET /api/v1/shipments/:id/dispatch`: caller must already be an authorized shipment viewer.
* `GET|POST /api/v1/admin/dispatch-policy`: admin with `dispatch:configure`; POST requires *all* fields: `searchRadiiM,candidateLimit,freshSeconds,maxSampleAgeSeconds,maxAccuracyM,maxSpeedMps,offerSeconds,retrySeconds,maxAttempts,sampleRetentionHours,movingUploadSeconds,idleUploadSeconds,multiStopEnabled:false`.
* `GET|POST /api/v1/admin/vehicle-policy`: admin with `dispatch:configure`; POST `{vehicle,maxParcelSize,allowedCategories,enabled}`. Categories are `general,documents,fragile,food`; food disabled in initial defaults.

The HTTP server deliberately does not expose payment-confirmation routes. The periodic server dispatch worker acts only on **paid** `AWAITING_ASSIGNMENT` shipments, with payment confirmation restricted to internal verified adapters.


## Native vehicle + multi-parcel API extension (2026-10-17)

- `GET /api/v1/rider/vehicle` — own vehicle and verification status.
- `POST /api/v1/rider/vehicle` — `{vehicle:"car",maxWeightG:25000,car:{plateNumber:"GT 1234-26",make:"Toyota",model:"Corolla",color:"White"}}`; forces pending rider/vehicle review and offline.
- `POST /api/v1/auth/register` (kind rider, vehicle car) — same `car` object mandatory for cars; other vehicle categories unchanged.
- `POST /api/v1/admin/vehicles/:riderId/review` — `{status:"approved"|"rejected"|"suspended"}`, verification:write permission required. Actual evidence checks remain a human responsibility.
- `GET /api/v1/rider/manifest` — current individual shipment states, ordered stops, opt-in status and capacity; authenticated rider only.
- `POST /api/v1/rider/multi-stop` — `{enabled:true|false}`; authenticated approved rider, no forced new jobs.
- `POST /api/v1/admin/dispatch-policy` now additionally requires `maxActiveParcels` (1..3), `maxDetourSeconds`, `deliverySlackSeconds`, `maxPickupEtaSeconds`, `maxOfferMovementM` and `multiStopEnabled` can be **true** only through authorized policy update. This is OFF initially.
- `GET /api/v1/rider/offers` also returns `existingParcels`, `estimatedDropoffSeconds`; accepted charges/commission/entitlement remain authoritative.

The HTTP server is a JSON API for **native mobile clients**, not a browser/PWA app. No static portal is served.

## October 2026 addendum — mobile dispatch/operations, safe global staging

These endpoints require authenticated `admin` actor plus `dispatch:configure`; they are used by the **native mobile administrator app**, not a customer-facing website.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/v1/admin/algorithm-features` | Read 15 feature switches; twelve core algorithms plus corridor, fan-out and advisory batch planning |
| POST | `/api/v1/admin/algorithm-features` | `{featureKey,enabled}`; auditing and immutable core safety gates; advanced features off by default |
| GET | `/api/v1/admin/fleet-batch-preview` | Road-ETA-based small-batch *read-only* recommendation; no assignment performed |
| GET | `/api/v1/admin/risk-signals` | Review explainable operational flags |
| POST | `/api/v1/admin/risk-signals/review` | `{signalId,decision:'reviewed'|'dismissed',reason}`; audited manual decision |
| GET | `/api/v1/admin/markets` | View staged ISO country/currency registry |
| POST | `/api/v1/admin/markets/stage` | `{countryCode,isoCurrency}`, register future rollout entry without granting services |
| POST | `/api/v1/admin/markets/activate` | `{countryCode,enabled}`; **GH only**. Foreign markets blocked pending currency/identity/provider/compliance work |

When `multi_rider_broadcast` is enabled, the dispatcher creates offers for **all verified road-eligible candidates within the configured shortlist**, each with a distinct `offerId`. The existing rider endpoint `GET /api/v1/rider/offers` lists only offers still live and owned by the authenticated rider. First valid rider acceptance is arbitrated under a shipment lock; other offers are invalidated and withdrawal events are placed in the outbox. These outbox rows currently require an external push delivery worker for background notifications; the native app already polls foreground offers.

`POST /api/v1/admin/dispatch-policy` supports `maxActiveParcels` up to 10 on staging. Setting `multiStopEnabled:true` atomically enables the two essential optimizer dependencies. Currency/commission legacy contracts for Ghana remain unchanged except that a **new active pricing version** uses 3% per individually successful order; old quotes remain immutable.
