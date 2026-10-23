# ELESEND — Cash-First Ghana Logistics & Delivery Platform

ELESEND supports cash parcel deliveries and prepaid restaurant orders in Ghana. Food orders require verified upfront payment of the food and delivery total through an enabled digital method. Kitchens cannot accept unpaid orders, and courier dispatch requires kitchen acceptance. It consists of a **Node.js backend** (`services/api`), **PostGIS database** (`database/migrations`), **self-hosted mapping and routing** (`services/maps`), and **React Native / Expo app** (`apps/mobile`).

Apply migrations through `033_provider_neutral_operations.sql` before starting this version. Existing cash food orders are not converted into paid orders; operations must review them. Paid food cancellations enter `/api/v1/admin/payments/exceptions` for refund processing; a queued refund is not a completed provider refund.

Payments use explicit `PAYMENT_PROVIDER` configuration, defaulting to `none`. Native adapters are optional; provider names and API rules are confined to the adapter/configuration boundary. To use another contracted PSP without changing order code, select `gateway` and configure `PAYMENT_GATEWAY_NAME`, `PAYMENT_GATEWAY_ENDPOINT`, `PAYMENT_GATEWAY_ALLOWED_HOST`, `PAYMENT_GATEWAY_TOKEN` (32+ characters), approved hosted `PAYMENT_GATEWAY_CHECKOUT_HOSTS`, `PAYMENT_GATEWAY_METHODS`, and `PAYMENT_PAYER_FIELDS` (empty or `email`). The gateway is an integration bridge you must supply, not an API promised by an arbitrary PSP. Secrets remain server-side. Drain or reconcile outstanding transactions before switching the active adapter.

Production API and worker startup reject a selected payment adapter unless it implements checkout, payment verification, refunds, beneficiary verification, and payouts with verification. The current native Paystack and Hubtel adapters are incomplete for this requirement; use a fully implemented gateway bridge or complete those adapters before enabling production payments. This startup check verifies method availability, not live provider behavior. Both processes also require migration 039 before starting.

The bridge uses authenticated JSON POST requests to `/checkout`, `/verify`, `/commission-checkout`, `/webhooks/verify`, `/refunds`, `/refunds/verify`, `/beneficiaries/verify`, `/payouts`, and `/payouts/verify`. Creation requests carry stable `Idempotency-Key` values. Checkout returns `{reference,checkoutUrl}` on an approved HTTPS domain. Verification must independently query the PSP and return `verified:true`, original reference, exact integer `amountMinor`, currency, normalized status, and unique `eventId`. Commission receipts supply `commissionIntentId`; refund and payout receipts supply `type` and `requestId`; payout receipts also identify `recipientReference`. Refund completion is `status:refunded`, payout completion is `status:paid`. Beneficiary verification must independently prove ownership and return matching `beneficiaryId` and `recipientReference`. Never implement verification by echoing client claims. An uncertain charge is never retried automatically; the bridge may return verified `status:not_created,definitiveNoCharge:true` only after establishing that no charge exists. Gateway submission failures are definitive only when its authenticated response explicitly provides `verified:true,definitiveNoCharge:true`.

Configure one provider webhook URL: `/api/v1/payments/webhook`. Legacy webhook paths use the same dispatcher. Mobile payer fields come from adapter capabilities; missing required details are rejected before creating payment intents. Where payment return URLs use the API origin, `/checkout/complete`, `/checkout/cancelled`, and the corresponding `/settlement/*` pages reopen the mobile app without claiming payment success.

New merchants remain pending until an admin with `verification:write` approves them. Pending merchants can be listed at `GET /api/v1/admin/restaurants` and approved through `POST /api/v1/restaurants/:id`. Declared hours use Ghana time with weekday names or ISO weekday numbers; overnight hours are supported. Food timeout settings are `FOOD_ACCEPTANCE_TIMEOUT_SECONDS` (default 300 after verified payment), `FOOD_COURIER_TIMEOUT_SECONDS` (default 1200 after the dispatch window), and `FOOD_PAYMENT_TIMEOUT_SECONDS` (default 1800). Unfulfilled orders cancel and reserve the full verified amount for refund. Fulfilment workers must remain running. Review merchant compensation policy for prepared but undelivered food before enabling public service.

Finance APIs require `finance:configure`: list refunds at `GET /api/v1/admin/payments/refunds`, submit/reconcile at `POST /api/v1/admin/payments/refunds/:id/submit` or `/reconcile`. Only adapters implementing independent refund verification can complete them. Payout recipients establish verified ownership through `POST /api/v1/me/payout-beneficiary` with `recipientReference`. Propose a per-delivery restaurant/rider payout at `POST /api/v1/admin/payments/payouts` with `shipmentId` and `kind`; a different finance administrator must approve it at `POST /api/v1/admin/payments/payouts/:id/approve`. `/reconcile` verifies the outcome. Unknown submission outcomes remain pending verification and never trigger blind resubmission. Ledger balances close only after verified receipts. Capability support varies by installed adapter; unsupported operations fail closed. Payout source balances remain provider receivables: independently reconcile actual PSP settlement and bank statements before treating them as bank cash.

Run `npm test` with a dedicated `TEST_DATABASE_URL` whose database name starts with `elesend_test`. Database regressions roll back their fixtures; the concurrency suite creates and removes its own disposable `elesend_test_race_*` database and requires test-only CREATE DATABASE privileges. Never supply a production database.

Deployment requires explicit `API_PUBLIC_ORIGIN` and `WEB_PUBLIC_ORIGIN`. Configure separate vehicle router endpoints and valid managed-database certificates. Configure `NOTIFICATION_GATEWAY_*` for the contracted SMS/push bridge: signed JSON requests use `Idempotency-Key`, and the bridge must deduplicate them and return `{accepted:true,messageId}` after durable provider acceptance. Notification jobs retry with backoff and preserve failures for operations. Without this bridge, notifications remain queued. Run the API on continuously running compute so dispatch, notification and reconciliation workers continue between requests. Live providers, signed device builds and backup restoration still require operational verification before public launch.

---

## Architecture Overview

```
                                    ┌────────────────────────┐
                                    │  React Native / Expo   │
                                    │ (Customer/Rider/Admin) │
                                    └───────────┬────────────┘
                                                │ HTTPS
                                                ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 ELESEND Node.js Backend                                │
│                                                                                        │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────────────┐  │
│  │   Dispatch Engine    │  │  Restaurant Market   │  │   Financial Ledger & Cash    │  │
│  │  - Multi-Vehicle     │  │  - Order Lifecycle   │  │   - Double-entry accounting  │  │
│  │  - Corridors & ETAs  │  │  - 30-min Food Handover│  │   - Weekly Rider Settlement  │  │
│  │  - Atomic Row Locks  │  │  - Branch Management │  │   - Auto Debt Restrictions   │  │
│  └──────────┬───────────┘  └──────────┬───────────┘  └──────────────┬───────────────┘  │
│             │                         │                             │                  │
│  ┌──────────┴───────────┐  ┌──────────┴───────────┐  ┌──────────────┴───────────────┐  │
│  │  Private Maps Engine │  │  Multi-PSP Gateways  │  │   Identity & MFA Security    │  │
│  │  - Self-hosted OSRM  │  │  - Hubtel (MoMo/SMS) │  │   - TOTP Authenticator (RFC) │  │
│  │  - 35k+ Ghana POIs   │  │  - Paystack (Cards)  │  │   - Rate-limiting & Session  │  │
│  │  - Vector MBTiles    │  │  - Dynamic Callbacks │  │   - Hostname Isolation (/adm)│  │
│  └──────────────────────┘  └──────────────────────┘  └──────────────────────────────┘  │
└───────────────────────────────────────────────┬────────────────────────────────────────┘
                                                │ TLS / SSL
                                                ▼
                                    ┌────────────────────────┐
                                    │  PostgreSQL + PostGIS  │
                                    │   (App & Spatial DB)   │
                                    └────────────────────────┘
```

---

## Key Platform Systems

### 1. Cash-First Logistics & Double-Entry Financial Ledger
- **Integer Pesewas Accounting**: All monetary values are strictly computed and stored as integer pesewas (`1 GH₵ = 100 pesewas`), eliminating floating-point errors.
- **Rider Cash Custody & Double-Entry Journal**: Cash collections on delivery are recorded with verified OTP handovers. Cash collected creates an auditable receivable owed to ELESEND without claiming uncollected digital revenue.
- **Weekly Rider Settlement**: Unpaid cash commissions close every Sunday at midnight (UTC). Couriers exceeding cutoff terms are automatically restricted from accepting new jobs until debts are settled via Mobile Money or audited two-person admin waiver.
- **Multiple Payment Channels**: Native checkout supports `CASH`, Mobile Money (`MOMO` via Hubtel), card payments (`CARD` via Paystack), and dynamic `QR` hosted checkout.

### 2. Intelligent Dispatch & Restaurant Marketplace
- **Vehicle-Aware Dispatch**: Supports distinct profiles (motorcycle, car, van) with route ETA calculations, road-corridor validation, and capacity limits.
- **Restaurant Operations**: Kitchen acceptance, preparation tracking, and strict 30-minute food-ready-to-handover time guarantees.
- **Atomic Concurrency**: Simultaneous rider acceptances and order assignments are protected by database row-level locks (`SELECT FOR UPDATE`), guaranteeing exactly one courier per order.

### 3. Private Ghana Spatial Mapping & Routing
- **Self-Hosted Tile Server & OSRM**: Serves OpenStreetMap vector tiles directly from local MBTiles, eliminating recurring third-party map API costs.
- **35,000+ Verified Ghana Landmarks**: Comprehensive spatial gazetteer covering Greater Accra, Ashanti, Central, Western, Eastern, and Northern regions.
- **Dynamic Vehicle Routing**: Vehicle-specific OSRM routing with per-vehicle endpoint configuration and fallback mechanisms.

### 4. Enterprise Security & Administration
- **Hostname Isolation**: Dedicated `ADMIN_HOST` enforces strict boundary isolation, preventing admin endpoints from public exposure.
- **Two-Factor Authentication**: RFC 6238 TOTP MFA required for all administrative actions with encrypted factor storage.
- **Cloud & VPS Portability**: Validated unified configuration (`services/api/config.mjs`) supporting standard deployment targets: traditional Linux VPS (Docker Compose + Caddy), AWS ECS/RDS, GCP Cloud Run/Cloud SQL, Render, Railway, and Fly.io.

---

## Directory Structure

```
.
├── apps/
│   └── mobile/              # React Native / Expo application (Android & iOS)
├── config/                  # Vehicle tariffs and runtime configuration schemas
├── data/                    # Spatial landmark gazetteer data & seeds
├── database/
│   └── migrations/          # Versioned, append-only PostgreSQL/PostGIS migrations
├── deploy/
│   ├── maps/                # Dockerfile and schema for self-hosted map tile service
│   └── vps/                 # VPS deployment templates (Caddy, backup scripts)
├── packages/                # Shared contracts and type definitions
├── scripts/                 # Operational CLI utilities (migrate, admin, tiles)
├── services/
│   ├── api/                 # Modular monolith backend API
│   └── maps/                # Vector tile server
├── .env.example             # Documented backend configuration template
├── compose.yaml             # Docker multi-container orchestration
├── Dockerfile               # Node.js production container specification
└── README.md                # Platform documentation
```

---

## Getting Started

### Prerequisites
- **Node.js**: `v24.22.1` LTS (or `v22.23.4` LTS)
- **PostgreSQL**: PostgreSQL 16+ with PostGIS extension installed
- **Docker & Docker Compose**: (optional, for containerized execution)
- **Expo CLI / Android Studio / Xcode**: (for mobile app development)

### 1. Backend Setup

1. **Clone and Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment Variables**:
   ```bash
   cp .env.example .env
   # Edit .env with your PostgreSQL credentials, security secrets, and provider keys
   ```

3. **Run Database Migrations**:
   ```bash
   npm run db:migrate
   ```

4. **Provision Administrator & MFA**:
   ```bash
   # Create initial administrative user
   npm run admin:create

   # Provision administrative TOTP MFA credentials
   npm run admin:mfa:provision
   ```

5. **Start Backend Server**:
   ```bash
   npm start
   ```
   The API will start listening on the configured `PORT` (defaults to `3090`).

---

### 2. Mobile Application Setup

1. **Navigate and Install**:
   ```bash
   cd apps/mobile
   npm install
   ```

2. **Configure Mobile Environment**:
   ```bash
   cp .env.example .env
   # Set EXPO_PUBLIC_API_URL to your backend's public HTTPS URL
   # Set EXPO_PUBLIC_VECTOR_TILE_URL to your vector tile server URL
   ```

3. **Launch Mobile Development Server**:
   ```bash
   # Start Expo development client
   npm start

   # Run directly on Android
   npm run android
   ```

---

### 3. Docker Deployment

To launch the full stack (API, PostGIS database, and tile server) using Docker:

```bash
docker compose up -d
```

To run database migrations inside the container:
```bash
docker compose exec api node scripts/migrate.mjs
```

---

## Production Environment Configuration

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `NODE_ENV` | Environment mode (`production` enforces HTTPS & secrets) | `development` |
| `PORT` | HTTP port for backend service (auto-injected on cloud) | `3090` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://user:pass@host:5432/elesend` |
| `DATABASE_SSL` | Enable TLS for managed databases (AWS RDS, GCP Cloud SQL) | `false` |
| `JWT_SECRET` | 32+ character cryptographic secret for session tokens | *Required in prod* |
| `ADMIN_MASTER_KEY` | 32+ character separate secret for admin credentials | *Required in prod* |
| `AUDIT_LOG_SECRET` | 32+ character separate secret for tamper-evident logs | *Required in prod* |
| `API_PUBLIC_ORIGIN`| Public HTTPS origin for the API server | `https://api.elesend.com` |
| `ADMIN_HOST` | Isolated hostname restricted to admin access | `admin.elesend.com` |
| `PAYMENT_PROVIDER` | Active PSP adapter (`hubtel`, `paystack`, `none`, `auto`) | `auto` |
| `SMS_PROVIDER` | Active SMS provider (`hubtel`, `https_gateway`, `none`) | `auto` |
| `ROUTING_OSRM_URL` | OSRM routing server base URL | `http://127.0.0.1:5000` |

---

## License

All rights reserved. Proprietary software.
