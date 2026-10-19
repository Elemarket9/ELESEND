# ELESEND dynamic pricing integration

Project: `C:/Users/sonofjacob/OneDrive/Desktop/ELESEND`. Changes dated 19 October 2026. No APK or production deployment was performed. This implements transparent pricing primitives; it does not claim access to Yango/Bolt algorithms or their measured performance.

## Approved rates

| Vehicle | Base GHS | Per km GHS | Per road minute GHS | Minimum GHS |
|---|---:|---:|---:|---:|
| Motorbike (`motorcycle`) | 12.00 | 3.20 | 0.25 | 20.00 |
| Car | 22.00 | 5.00 | 0.60 | 35.00 |
| Van | 55.00 | 8.50 | 1.10 | 75.00 |

These rates were supplied by the owner. Migration `022_vehicle_pricing_integration.sql` creates separate active, versioned vehicle policies with 20% commission and scheduled rush-hour pricing enabled. Supply/demand pricing is opt-in. The same rates in integer pesewas are in `config/vehicle-tariffs.json` for the standalone preview. The production API reads its tariffs from PostgreSQL, not this JSON file.

Money uses integer pesewas/BigInt arithmetic. Distance and estimated road time are rounded up to pesewas; the multiplier is rounded half-up, then the minimum fare floor is applied. Platform commission rounds half-up, and rider entitlement is the remainder. The accepted quote and its commission are saved, rather than recomputed during booking or settlement.

For a 10 km / 30 road-minute quote, without extra charges:

| Vehicle | Normal GHS | City rush GHS |
|---|---:|---:|
| Motorbike | 51.50 | 72.10 |
| Car | 90.00 | 126.00 |
| Van | 173.00 | 242.20 |

These are arithmetic examples, not measured Ghana trip estimates or a promise of availability. Actual provider distances/durations determine the quote. Rider entitlement is not net profit or a settled payout; taxes, payment-provider fees, fuel, data, bonuses, refunds and operating expenses require their own accounting.

## Main booking API

The existing authenticated `POST /api/v1/quotes` and new alias `POST /api/v1/calculate-fare` call the same authoritative quote implementation and save a 15-minute quote. Both use the existing user/session authorization and database-backed request limits. Business credentials need `quotes:write`. The request uses the existing booking contract plus a selected vehicle:

```json
{
  "vehicle": "motorcycle",
  "pickup": {"address":"Osu main entrance","latitude":5.6,"longitude":-0.2},
  "destination": {"address":"Airport main entrance","latitude":5.62,"longitude":-0.18},
  "recipientPhone":"0241234567",
  "weightG":1000,
  "description":"Sealed documents",
  "paymentMethod":"CASH",
  "cashPayer":"recipient"
}
```

The saved quote ID is used by the existing idempotent shipment booking endpoint. Clients cannot supply money, multiplier, policy ID, commission or routing URL. Vehicle is required for production requests; non-production legacy requests can retain the original untyped policy to support migration/tests. Legacy global policy updates no longer deactivate vehicle policies.

The mobile booking screen now offers Motorbike, Car and Van and submits the selected vehicle. Nearby discovery filters the vehicle before candidate limits; acceptance rechecks it; a PostgreSQL trigger also rejects a mismatched rider vehicle. A running graph and configured tariff are necessary to quote that vehicle. A missing graph fails closed; production quotes never use Haversine pricing.

`GET /api/v1/pricing/vehicles` lists active rates for authenticated customer/business/admin sessions. `POST /api/v1/admin/pricing/vehicles` requires an administrator with `pricing:write` and creates a new policy version:

```json
{"vehicle":"motorcycle","baseMinor":1200,"perKmMinor":320,"perMinuteMinor":25,"minimumMinor":2000,"commissionBps":2000,"rushHourEnabled":true,"supplyDemandEnabled":false}
```

Policies and quote terms are immutable in PostgreSQL. Quotes retain the selected vehicle, policy ID, distance, duration, source, multiplier and observation evidence. Disabling a policy does not change accepted quotes. Mid-trip changes must go through a future explicit adjustment/consent workflow; they cannot silently rewrite the original price. Quote expiry may be shortened, but not extended or repriced by an update.

## Road services and overload boundaries

Set `ROUTING_OSRM_VEHICLES_JSON` to the actual independent graph services, for example:

```json
{"car":{"endpoint":"http://car-osrm:5000","profile":"driving"},"motorcycle":{"endpoint":"http://motorcycle-osrm:5000","profile":"driving"},"van":{"endpoint":"http://van-osrm:5000","profile":"driving"}}
```

The graph must be extracted for that vehicle. An endpoint label is not evidence of motorcycle legality, van access, surface quality or realistic road speeds. Legacy configuration is car-only at server startup. Provider requests reject redirects, bound response bodies to 1 MiB, use timeouts and admit at most eight concurrent requests per API instance. HTTP 429 and authoritative disconnected routes remain distinct. The main HTTP server bounds bodies to 32 KiB and validates UTF-8 JSON. Multi-instance provider admission and sustained-load capacity still require deployment/load work.

## Scheduled and measured surge

Scheduled pricing uses Ghana time and `[07:00,09:00)` / `[16:00,19:00)` windows. Accra/Kumasi circles in the preview helper are provisional city zones, not legal or administrative boundaries. The scheduled multiplier is 1.4. This is a published time rule, not a measurement of live traffic.

Optional measured pricing uses PostGIS zones and PostgreSQL state, with no Redis dependency. `POST /api/v1/admin/pricing/surge-zones` requires `pricing:write`:

```json
{"name":"Reviewed service zone","latitude":5.6,"longitude":-0.2,"radiusM":3000,"enabled":false}
```

Enable a reviewed zone and a vehicle policy's `supplyDemandEnabled` only after observing the local data. Zone replacement creates a new zone ID and retires the prior one using optional `replaceId`. Overlaps select the smallest matching enabled zone, with ID as a deterministic tie-breaker. No zones are enabled automatically by this migration.

Demand counts independent customers with dispatchable, selected-vehicle shipments awaiting assignment in the last ten minutes. Supply counts fresh, approved, online, enabled-vehicle riders without active/failed custody, with company/car approval checks. This is a deliberately bounded market proxy, not exact package-specific eligible supply; weight, category, service-radius and route feasibility remain dispatch checks. Repeated unbooked quotes do not count as demand.

At least three independent customers are needed to raise the multiplier. The target is `1 + max(0,demand-supply)/max(1,supply)`, capped at 2. Each refresh blends 25% of the target into the prior value and limits movement to 0.05, with a 0.05 deadband; balanced markets decay back to 1. State is cached for 30 seconds and refreshed under a row lock, so concurrent quote requests cannot accelerate the increase. Scheduled and measured multipliers combine by taking the maximum, not multiplying them. Their evidence is stored on the quote. No background worker is needed for this lazy refresh design; observability/alerting and a measured-capacity assessment remain required.

## Standalone preview

`deliveryEngine.mjs` retains its separately authenticated preview/greedy open-tour interface for algorithm experiments. It uses the same `services/api/pricing.mjs` money arithmetic as booking, but its multiple-drop-off preview is not an atomic production tour booking. Its `pickup.lat/lng` and `dropoffs` contract differs from the main API above. Do not route mobile bookings to its loopback listener. It cannot write the booking ledger or replace main session authorization.

## Rollout and verification

Back up and test restoration before applying migration 022 to a real database. Apply it with the migration account, configure and road-validate vehicle graphs, and restart the API. Startup requires migration 022. No real application database was migrated in this work; only disposable test databases were used.

Run the complete suite using a disposable PostGIS database and a test role allowed to create databases:

```powershell
$env:TEST_DATABASE_URL='postgres://test-role:password@127.0.0.1:5432/elesend_test'
node scripts/test-isolated.mjs
```

The runner gives each database suite a new database and removes it afterward. Exact current results are recorded in `audit-evidence/pricing-integration-full.log`. This checkout's results must not be mixed with the Downloads project's 337-test record.

Remaining work: real graph deployment/road verification; traffic or verified historical travel-time modelling; full pickup/delivery waiting events and grace-period policy; customer-approved destination adjustments and refund handling; atomic same-rider multi-stop booking/fare allocation; production observability and distributed load tests; native-device tests and real cash/payment reconciliation. No claim of perfection, Yango/Bolt equivalence, or production certification is made.
