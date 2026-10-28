# ELESEND — Production Runtime & Deployment Guide

This guide details the environment-neutral configuration, TLS security, and operational execution of the ELESEND platform across single-instance and multi-instance containerized runtime environments.

---

## 1. Environment & Architecture Principles

- **No Hardcoded Domains**: All public endpoints (`API_PUBLIC_ORIGIN`, `WEB_PUBLIC_ORIGIN`, and `ADMIN_HOST`) must be explicitly declared in your environment. Production mode (`NODE_ENV=production`) fails fast if any required origin or hostname is missing or malformed.
- **Fail-Fast Validation**: The backend validates all settings on startup via `services/api/config.mjs`. Invalid URLs, unseparated secrets, or missing credentials for selected providers immediately halt startup with clear diagnostic error messages.
- **Client/Server Secret Separation**: Mobile clients consume configuration solely via `EXPO_PUBLIC_*` build-time variables. Server credentials (database passwords, PSP secret keys, MFA master keys) are never bundled into client applications.

---

## 2. PostgreSQL TLS/SSL Configuration

In production, database traffic contains financial transactions, identity hashes, and customer delivery records. ELESEND enforces strict TLS verification when `DATABASE_SSL` is enabled.

### 2.1 The Production Security Standard: Trusted CA Certificates

> [!IMPORTANT]
> The recommended and secure configuration for external database connections requires `DATABASE_SSL_REJECT_UNAUTHORIZED=true` and supplies the database server's trusted Root CA certificate via `DATABASE_SSL_CA` (when not signed by a system-trusted public CA).
>
> Setting `DATABASE_SSL_REJECT_UNAUTHORIZED=false` disables server certificate verification, leaving database traffic vulnerable to active Man-In-The-Middle (MITM) attacks. ELESEND emits a critical security hazard warning if certificate verification is disabled in production.

### 2.2 Configuring Database TLS

1. Mount or place your database CA certificate bundle in the container/host filesystem (for example `/etc/ssl/certs/db-ca-bundle.pem`):
   ```env
   DATABASE_URL=postgres://elesend:PASSWORD@db-host.example:5432/elesend
   DATABASE_SSL=true
   DATABASE_SSL_CA=/etc/ssl/certs/db-ca-bundle.pem
   DATABASE_SSL_REJECT_UNAUTHORIZED=true
   ```
2. If the database server uses a certificate signed by a standard public Certificate Authority already present in the OS trust store:
   ```env
   DATABASE_URL=postgres://elesend:PASSWORD@db-host.example:5432/elesend?sslmode=require
   DATABASE_SSL=true
   DATABASE_SSL_REJECT_UNAUTHORIZED=true
   ```

---

## 3. Background Worker Execution Plan

ELESEND relies on recurring background tasks:
- **Dispatch Tick (`dispatch.tick`)**: Periodically matches shipments with nearby couriers (every 3s).
- **Notification Queue (`notifications.tick`)**: Retries pending SMS notifications (every 3s).
- **Food Maintenance**: Expires unfulfilled kitchen orders, syncs refunds, and checks payment timeouts (every 15s).
- **Corridor Refresh**: Pre-computes road geometry corridors for transit tracking (every 60s).
- **Payment Reconciliation**: Reconciles pending MoMo/Card checkouts against provider status (every 2m).
- **Table Maintenance & Debt Restrictions**: Cleans expired sessions/challenges and restricts overdue couriers (every 1h).

### 3.1 Execution Topologies

ELESEND provides a dedicated background worker runner:
```bash
npm run worker
# Executed via: node --env-file-if-exists=.env services/api/worker.mjs
```

#### Topology A: Single-Instance Runtime (Docker Compose)
- Keep `BACKGROUND_JOBS_ENABLED=true` (the default) on the API container.
- Background tasks run inside the server process.
- Built-in PostgreSQL Advisory Locks (`pg_try_advisory_lock`) coordinate execution so rolling container restarts never duplicate singleton jobs.

#### Topology B: Horizontally Scaled Runtime (Separate API & Worker)
Split your deployment into two services sharing the same database and configuration:

1. **API Service (`api`)**:
   - Command: `npm start`
   - Setting: `BACKGROUND_JOBS_ENABLED=false`
   - Scaling: Scale from 1 to N instances based on HTTP request rate.

2. **Worker Service (`worker`)**:
   - Command: `npm run worker`
   - Setting: `BACKGROUND_JOBS_ENABLED=true`
   - Scaling: Fixed singleton (1 replica) with continuous CPU allocation.
   - Advisory Locks: The worker uses advisory locks on all reconciliation and maintenance routines, guaranteeing safe operation even during rolling worker deployments.

---

## 4. Containerized Runtime Deployment (`deploy/runtime/`)

1. Configure `.env.runtime` from the template:
   ```bash
   cp deploy/runtime/.env.example .env.runtime
   chmod 600 .env.runtime
   # Edit .env.runtime with your domain names, database passwords, and provider credentials
   ```
2. Run the containerized stack:
   ```bash
   docker compose -f deploy/runtime/compose.yaml --env-file .env.runtime up -d --build
   ```
3. Verify service status and migrations:
   ```bash
   docker compose -f deploy/runtime/compose.yaml ps
   docker compose -f deploy/runtime/compose.yaml logs -f api
   ```
4. Safe rollback (preserving database records by default):
   ```bash
   bash deploy/runtime/rollback.sh
   ```

---

## 5. Pre-Flight Launch Checklist

Before opening public access:

- [ ] All 5 cryptographic keys (`OTP_KEY`, `ADMIN_MFA_ENCRYPTION_KEY`, `JWT_SECRET`, `ADMIN_MASTER_KEY`, `AUDIT_LOG_SECRET`) are unique, distinct, and at least 32 characters (64 hex characters for OTP and MFA).
- [ ] Database TLS is enabled with strict verification (`DATABASE_SSL_REJECT_UNAUTHORIZED=true`) when connecting over untrusted networks.
- [ ] Hostname isolation is active: `ADMIN_HOST` points exclusively to your secure administrative domain.
- [ ] Explicit payment and SMS providers are configured with validated credentials.
- [ ] Background worker process (`npm run worker` or server worker) is verified running and acquiring advisory locks cleanly.
- [ ] Mobile app bundle is exported with matching `EXPO_PUBLIC_ELESEND_API_BASE_URL` pointing to your validated HTTPS API origin.
