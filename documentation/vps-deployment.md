# provider-neutral VPS deployment — staging only (NOT executed here)

VPS provider is the chosen server vendor; **~20 GB is a planned application/operations consumption envelope**, NOT an assurance that a 20 GB physical disk suffices for the OS, container layers, WAL and backups. Provision headroom and measured IOPS/RAM/CPU. A customer-facing website is **not** part of the product; expose only the HTTPS API consumed by Android/iOS.

## Non-production deployment procedure

1. Provision an isolated Linux VPS. Install current, supported Docker Engine/Compose, enable automatic critical OS security updates and minimal inbound SSH access, enable system firewall and secure clocks. Do not expose PostgreSQL or container administration ports externally.
2. Point a hostname such as `api.example.tld` to the VPS; add real DNS and configure Caddy for automatic TLS. Require app HTTPS. Prepare Google Routes server key (API-restricted and server IP-bound when practical), distinct Android/iOS Maps SDK keys (package/signing certificate or bundle-ID restricted). Get explicit Maps/Routes billing quota and alerts before public testing.
3. In project root create `.env.vps` from `deploy/vps/.env.example`, `chmod 600 .env.vps`, replace **all** placeholders, store in an access-controlled secret path. If DB password contains reserved URL characters, URL-encode it in `DOCKER_DATABASE_URL`. Never commit secrets, SMS tokens or client phone records.
4. Deploy staging: `docker compose -f deploy/vps/compose.yaml --env-file .env.vps config` then `docker compose -f deploy/vps/compose.yaml --env-file .env.vps up -d --build`. Check `docker compose ... ps`, `docker compose ... logs --tail 120`, and `https://api.example.tld/health`. The `migrate` one-shot step runs tracked checksummed migrations before API start. Take a tested SQL and volume backup **before** upgrading any existing ELESEND DB.
5. Install off-server encrypted backup destination, independently run/verify `deploy/vps/backup-offsite.sh`, `deploy/vps/storage-check.sh`, restore to a fresh test environment and verify data. Integrate cron/systemd, escalation and disk, inode, RAM and database health alerts. Store backups **off VPS**. Scripts are examples; their execution and restore success are NOT verified.
6. Build and install signed Android/iOS binaries from `apps/mobile` using appropriate native tooling / Expo EAS; provision the client HTTPS URL and **app-restricted** native Maps keys. Verify permission explanation, background GPS OS behavior, dark/captive/offline network, pushes, battery use, cash receipt and OTP timeouts on Ghana devices.
7. Keep SMS + settlement PSP and prepaid credits **disabled** until cryptographic verification, webhook idempotency, on-call operations and full money-in/money-out reconciliation are independently certified. COD merchandise and multi-stop pooling must remain OFF until the appropriate separate gates pass.

### Compose and data protection

The compose configuration has internal-only PostGIS, non-root read-only API, separate Caddy ingress, size-limited container logs and health-gated migration. **No Redis is required by this source candidate**; PostgreSQL is authoritative for ledger and dispatch and the original design can incorporate Redis later only as discardable cache. Avoid running untested high-availability/microservice products on a small VPS.

### Verification needed before any production deployment

- Test compose build and migrate with a real PostgreSQL/PostGIS engine; verify Postgres 18 extension compatibility and persistent volume mount and backup/restore.
- Resolve Expo native packages with `npx expo install --check`, build Android APK and iOS IPA and test on phones; re-review SDK version compatibility.
- Run whole DB integration/concurrency suite on disposable `elesend_test*` DB, end-to-end verified OTP/PSP sandboxes, Google route matrix with actual Ghana road network, route limitation for motorcycles, multi-stop custody and finance ledger reconciliation.
- Set baseline SLOs from observed performance: Geo query P95, matrix P95, offer acceptance P95, ETA accuracy, cash commission aging, cash reconciliation variance, PSP webhook success/dedup, disk/backups, cost per routed delivery. No actual production benchmark exists in this package.

### Operations

Monitor audit/finance errors without logging authentication headers, OTPs or customer phone data. Keep only privacy-justified GPS samples; track rider consent, deletion and export procedures. Ensure independent security audit, recovery procedures, app-store approvals, legal/insurance/provider review and a live dispatch pilot before public scale.

### Reverse proxy, fair rate limiting, and readiness

`/health` is a **database-free liveness check**. To verify PostgreSQL readiness, explicitly supply a private `READINESS_PROBE_TOKEN` (at least 32 random characters) and send `GET /ready` with `X-Elesend-Health-Token`. Do not expose this secret in any mobile app or public status dashboard.

Socket-address rate limits behind a TLS reverse proxy can otherwise lump all riders into one ingress IP and cause shared 429 outages. By default, ELESEND distrusts `X-Forwarded-For`. Set `TRUSTED_PROXY_CIDRS` **only** to the exact IP or smallest dedicated IPv4 range of the exclusively controlled reverse proxy, and verify external clients cannot reach the API directly. Invalid or untrusted forwarded headers are ignored. Do not use `0.0.0.0/0` or a broad private network; test real rider IP attribution before launch. IPv6 CIDR trust is not supported; exact IPv6 IP is supported.

Root `compose.yaml` is for local/container development; the portable `deploy/vps` template is an **example only**, not proof of a successful deployment.
