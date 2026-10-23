# ELESEND — Cloud & VPS Production Deployment Guide

This guide details deployment of the ELESEND modular monolith across traditional Linux VPS environments and managed cloud container platforms (AWS ECS/RDS, GCP Cloud Run/Cloud SQL, Render, Railway, Fly.io).

---

## 1. Environment & Architecture Principles

- **No Hardcoded Domains**: All public endpoints (`API_PUBLIC_ORIGIN`, `WEB_PUBLIC_ORIGIN`, and `ADMIN_HOST`) must be explicitly declared in your environment. Production mode (`NODE_ENV=production`) fails fast if any required origin or hostname is missing or malformed.
- **Fail-Fast Validation**: The backend validates all settings on startup via `services/api/config.mjs`. Invalid URLs, unseparated secrets, or missing credentials for selected providers immediately halt startup with clear diagnostic error messages.
- **Client/Server Secret Separation**: Mobile clients consume configuration solely via `EXPO_PUBLIC_*` build-time variables. Server credentials (database passwords, PSP secret keys, MFA master keys) are never bundled into client applications.

---

## 2. Managed PostgreSQL TLS/SSL Configuration

In production, database traffic contains financial transactions, identity hashes, and customer delivery records. ELESEND enforces strict TLS verification.

### 2.1 The Production Security Standard: Custom Trusted CA Certificates

> [!IMPORTANT]
> The recommended and secure configuration requires `DATABASE_SSL_REJECT_UNAUTHORIZED=true` and supplies the cloud provider's official Root CA certificate via `DATABASE_SSL_CA`.
>
> Setting `DATABASE_SSL_REJECT_UNAUTHORIZED=false` disables server certificate verification, leaving database traffic vulnerable to active Man-In-The-Middle (MITM) attacks. ELESEND emits a critical security hazard warning if certificate verification is disabled in production.

### 2.2 Provider-Specific CA Setup

#### AWS RDS / Aurora PostgreSQL
1. Download the global Amazon Root CA certificate bundle:
   ```bash
   curl -o /etc/ssl/certs/rds-ca-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
   ```
2. Configure your environment:
   ```env
   DATABASE_URL=postgres://elesend:PASSWORD@your-rds-instance.rds.amazonaws.com:5432/elesend
   DATABASE_SSL=true
   DATABASE_SSL_CA=/etc/ssl/certs/rds-ca-bundle.pem
   DATABASE_SSL_REJECT_UNAUTHORIZED=true
   ```

#### Google Cloud SQL
1. Download your instance's server CA certificate (`server-ca.pem`) from the Cloud SQL console or using gcloud:
   ```bash
   gcloud sql instances describe INSTANCE_NAME --format="value(serverCaCert.cert)" > /etc/ssl/certs/cloud-sql-ca.pem
   ```
2. Configure your environment:
   ```env
   DATABASE_URL=postgres://elesend:PASSWORD@YOUR_CLOUD_SQL_IP:5432/elesend
   DATABASE_SSL=true
   DATABASE_SSL_CA=/etc/ssl/certs/cloud-sql-ca.pem
   DATABASE_SSL_REJECT_UNAUTHORIZED=true
   ```

#### Supabase / Neon / Managed Cloud DBs with Public CAs
These providers use certificates signed by standard public certificate authorities (e.g., Let's Encrypt, DigiCert):
```env
DATABASE_URL=postgres://elesend:PASSWORD@db.provider.com:5432/elesend?sslmode=require
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true
```

---

## 3. Background Worker Cloud Execution Plan

ELESEND relies on recurring background tasks:
- **Dispatch Tick (`dispatch.tick`)**: Periodically matches shipments with nearby couriers (every 3s).
- **Notification Queue (`notifications.tick`)**: Retries pending SMS notifications (every 3s).
- **Food Maintenance**: Expires unfulfilled kitchen orders, syncs refunds, and checks payment timeouts (every 15s).
- **Corridor Refresh**: Pre-computes road geometry corridors for transit tracking (every 60s).
- **Payment Reconciliation**: Reconciles pending MoMo/Card checkouts against provider status (every 2m).
- **Table Maintenance & Debt Restrictions**: Cleans expired sessions/challenges and restricts overdue couriers (every 1h).

### 3.1 Why Serverless/Auto-Scaled APIs Cannot Run Background Jobs Alone
On serverless or container platforms with scale-to-zero or request-based CPU throttling (such as Google Cloud Run without always-on CPU, or auto-scaled AWS ECS tasks):
1. **CPU Throttling**: When no inbound HTTP requests are active, the container CPU is throttled or suspended. Background `setInterval` timers pause, causing missed dispatch ticks and delayed payment reconciliation.
2. **Horizontal Scaling Duplication**: If 5 API replicas are spun up to handle heavy customer traffic, running hourly maintenance and payment reconciliations on all 5 instances wastes database connections and causes contention.

### 3.2 Cloud Execution Strategy

ELESEND provides a dedicated background worker runner:
```bash
npm run worker
# Executed via: node --env-file-if-exists=.env services/api/worker.mjs
```

#### Strategy A: Single VPS or Monolithic Container (Docker Compose)
- Keep `BACKGROUND_JOBS_ENABLED=true` (the default) on the API container.
- Background tasks run inside the server process.
- Built-in PostgreSQL Advisory Locks (`pg_try_advisory_lock`) coordinate execution so even rolling container restarts or manual process restarts never duplicate singleton jobs.

#### Strategy B: Scaled Cloud Deployment (AWS ECS, GCP Cloud Run, Kubernetes, Render, Railway)
Split your deployment into two services sharing the same database and configuration:

1. **API Service (`api`)**:
   - Command: `npm start`
   - Setting: `BACKGROUND_JOBS_ENABLED=false`
   - Scaling: Auto-scale from 1 to N instances based on CPU / HTTP request rate.
   - CPU: Request-allocated or standard burstable.

2. **Worker Service (`worker`)**:
   - Command: `npm run worker`
   - Setting: `BACKGROUND_JOBS_ENABLED=true`
   - Scaling: Fixed singleton (1 replica).
   - CPU: Continuous (always-allocated) CPU allocation to prevent timers from freezing.
   - Advisory Locks: The worker uses advisory locks on all reconciliation and maintenance routines, guaranteeing safe operation even during blue/green worker deployments.

---

## 4. Platform Deployment Guides

### 4.1 Deployment on Linux VPS (Docker Compose + Caddy)

1. Provision an Ubuntu 24.04 LTS VPS with at least 2 vCPUs and 4 GB RAM.
2. Clone the repository and configure `.env.vps`:
   ```bash
   cp deploy/vps/.env.example .env.vps
   chmod 600 .env.vps
   # Edit .env.vps with your domain names, database passwords, and provider credentials
   ```
3. Run the containerized stack:
   ```bash
   docker compose -f deploy/vps/compose.yaml --env-file .env.vps up -d --build
   ```
4. Verify service status and migrations:
   ```bash
   docker compose -f deploy/vps/compose.yaml ps
   docker compose -f deploy/vps/compose.yaml logs -f api
   ```

### 4.2 Deployment on AWS (ECS Fargate + RDS PostgreSQL)

1. **Database**: Provision Amazon RDS for PostgreSQL (PostGIS extension enabled). Download the global CA bundle.
2. **Task Definition 1 (API)**:
   - Container Image: `elesend:latest`
   - Command: `npm start`
   - Environment:
     - `NODE_ENV=production`
     - `BACKGROUND_JOBS_ENABLED=false`
     - `PORT=3090`
     - `API_PUBLIC_ORIGIN=https://api.yourdomain.com`
     - `WEB_PUBLIC_ORIGIN=https://yourdomain.com`
     - `ADMIN_HOST=admin.yourdomain.com`
     - `DATABASE_URL=postgres://elesend:PASS@rds-host:5432/elesend`
     - `DATABASE_SSL=true`
     - `DATABASE_SSL_CA=/etc/ssl/certs/rds-ca-bundle.pem`
     - `DATABASE_SSL_REJECT_UNAUTHORIZED=true`
   - Target Group: Application Load Balancer (ALB) HTTPS listener forwarding to container port 3090.
3. **Task Definition 2 (Worker)**:
   - Container Image: `elesend:latest`
   - Command: `npm run worker`
   - Environment: Same database and provider environment as API.
   - Desired Count: Fixed at `1`.

### 4.3 Deployment on Google Cloud (Cloud Run + Cloud SQL)

1. **Cloud SQL**: Provision PostgreSQL with PostGIS extension.
2. **Cloud Run API Service**:
   - Container Image: `gcr.io/your-project/elesend-api:latest`
   - Port: Auto-injected (`8080`)
   - Environment: `NODE_ENV=production`, `BACKGROUND_JOBS_ENABLED=false`, `API_PUBLIC_ORIGIN`, `ADMIN_HOST`.
   - Concurrency: 80 requests per instance.
3. **Cloud Run Worker Service**:
   - Container Image: `gcr.io/your-project/elesend-api:latest`
   - Entrypoint: `npm run worker`
   - CPU Allocation: Select **"CPU is always allocated"** (to prevent task suspension).
   - Scaling: Min instances: 1, Max instances: 1.

### 4.4 Deployment on Render / Railway

1. **Database**: Provision managed PostgreSQL.
2. **API Web Service**:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment: `BACKGROUND_JOBS_ENABLED=false`, `API_PUBLIC_ORIGIN`, `ADMIN_HOST`, etc.
3. **Background Worker Service**:
   - Create a Background Worker service referencing the same repository.
   - Build Command: `npm install`
   - Start Command: `npm run worker`
   - Environment: Identical configuration to the API service.

---

## 5. Pre-Flight Launch Checklist

Before opening public access:

- [ ] All 5 cryptographic keys (`OTP_KEY`, `ADMIN_MFA_ENCRYPTION_KEY`, `JWT_SECRET`, `ADMIN_MASTER_KEY`, `AUDIT_LOG_SECRET`) are unique, distinct, and at least 32 characters (64 hex characters for OTP and MFA).
- [ ] Database TLS is enabled with strict verification (`DATABASE_SSL_REJECT_UNAUTHORIZED=true`) and trusted CA certificate mounted.
- [ ] Hostname isolation is active: `ADMIN_HOST` points exclusively to your secure administrative domain.
- [ ] Explicit payment and SMS providers are configured with validated credentials.
- [ ] Background worker process (`npm run worker` or server worker) is verified running and acquiring advisory locks cleanly.
- [ ] Mobile app bundle is exported with matching `EXPO_PUBLIC_ELESEND_API_BASE_URL` pointing to your validated HTTPS API origin.
