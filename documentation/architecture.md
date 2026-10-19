# Architecture, data and dispatch

ELESEND is a Node.js modular monolith with PostgreSQL persistence. The runnable modules are `services/api/http.mjs` (HTTP transport), `platform.mjs` (application policies), `network.mjs` (company affiliations and business API keys), `security.mjs` (identity/cryptography), `db.mjs` (transactions). A responsive portal calls the same versioned API for all workspaces. Provider contracts are declared in `packages/contracts/providers.ts`; no concrete production adapters are wired.

Dependency direction: portal → HTTP → platform → PostgreSQL and injected SMS transport. Platform → cryptography. Database has no knowledge of ELEMARKET. Domain code uses standard JavaScript ES modules to run directly on Node without a bundler; TypeScript describes provider contracts. This is a deliberate small-runtime choice rather than importing ELEMARKET's TanStack transport and authentication graph. Modules are logically divided inside platform.mjs; split them further as production functionality is added.

## Database

Migration 001 creates users, sessions, permissions, companies, riders, versioned pricing policies, quotes, shipments, challenges, payment events, financial entries, disputes, last known locations, append-only audit evidence, event outbox and database-backed rate limits. No marketplace migrations or data are imported. Migration checksums prevent modifying already-applied migrations; an advisory lock serializes migration runners. New databases get no secret, account or price seeds.

Migration 002 adds hashed, expiring company rider invitations and scoped business API credentials. Company owners invite; only the exact authenticated rider can accept. Active custody blocks affiliation changes, and removing a company rider makes the account pending/offline rather than automatically eligible for independent riding. Company and rider row locks serialize affiliation with acceptance and suspension. Invitations are handed over manually; no invitation messaging worker exists. Business keys are returned once, hashed at rest and revocable; key sessions cannot manage credentials or enter administration.

UUID primary keys identify business records. Foreign keys protect parent references. Unique customer/idempotency keys protect booking retries; each quote can create one shipment. Payment event keys bind provider/event ID. One financial entry per shipment prevents duplicate earnings. A partial unique index prevents overlapping active rider custody. Indexes serve customer/company history, assignment eligibility and challenge history. Financial beneficiary IDs may refer to a rider user or company; this polymorphic relation needs stronger modeling before payouts.

Shipment transitions have both application policies and a PostgreSQL trigger. Terms cannot be edited after booking. Pickup requires a consumed challenge; delivery completion also requires payment and consumed, sent delivery verification. Direct arbitrary state edits are rejected. Actual lifecycle implemented: awaiting payment → awaiting assignment → rider assigned → pickup verified → in transit → awaiting delivery OTP → completed; controlled cancellation, failure and return states exist. Rich incident states and reassignment are outstanding.

## Dispatch

Approved, online riders see paid jobs within their declared weight capacity. Acceptance locks company (where applicable), rider and shipment inside one transaction. Revalidation blocks suspended companies/riders. A shipment row lock serializes competing riders; a partial index prevents the same rider accepting two active jobs. Other shipments remain independent. Busy riders may see offers that fail acceptance; offers are not reservations. No location proximity scoring, dimensions, regions, scheduling or expiring broadcast offers are implemented. This is a secure atomic claim primitive, not a complete matching engine.

## Quote and finance policies

Only authorized administrators can replace an active pricing policy; old policies and quote snapshots persist. Distance uses a straight-line estimate, not a verified road route or service area. Coordinates are customer supplied, so price estimates are unsuitable for paid operational service until authoritative routing/coverage validation is added. Integer minor units and BigInt calculate money; commission basis points round half up. Booking consumes the stored quote, not the latest policy. No fixed commission percentage is shipped.

Payment confirmation is an internal adapter seam. It enforces exact amount/currency and idempotent provider event binding in a transaction. It cannot be called through HTTP. A completed delivery creates an immutable charge/commission/entitlement allocation with payout status `held`. This represents an obligation, not held cash or a settled balance. Processing fees, taxes, adjustments, reconciliation, payouts and refunds are not implemented. A cancellation of a paid shipment returns refundReviewRequired; it does not issue a refund.

The outbox persists shipment events transactionally, but no delivery worker/subscriptions/retry/dead-letter implementation exists. Redis is not required by the current implementation: PostgreSQL provides durable coordination and rate limiting. A future queue worker must preserve idempotency and bounded retries.
