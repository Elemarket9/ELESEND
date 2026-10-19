# Local and VPS deployment

## Local development

Install Node 24 and PostgreSQL 18. Use a dedicated ELESEND database; configure DATABASE_URL and an independent random OTP_KEY. Run npm ci, db:migrate, admin:create and start per README. Pricing starts unconfigured. The API binds loopback by default; HOST can change it deliberately. Health checks require a working database.

## Docker (configuration supplied, execution unverified)

Set POSTGRES_PASSWORD, DOCKER_DATABASE_URL (postgres://elesend:URL_ENCODED_PASSWORD@db:5432/elesend) and OTP_KEY in your local environment. Keep these values out of source control. Then:

```text
docker compose build
docker compose up -d
docker compose run --rm -e ADMIN_PHONE -e ADMIN_PASSWORD api node scripts/admin.mjs
docker compose logs --tail=100 api
```

The database has no published host port and an internal network. API binds the host's loopback port 3090. Add an HTTPS reverse proxy on the same host only after the release blockers are resolved. Configure trusted forwarding rules and request limits. Migration service runs once before API; application is nonroot with a read-only container filesystem, dropped capabilities and no-new-privileges. PostgreSQL volume is persistent. PostgreSQL is currently bootstrapped with an owner account; split runtime/migration SQL roles before exposure.

No Redis or fake worker container is shipped. Database transactions and counters handle the implemented coordination. The outbox is durable but has no sending worker yet. Do not treat stored events as delivered notifications. Do not run test truncation against an operational database.

## Backup and restore procedure (not executed here)

Use pg_dump in custom format for the dedicated ELESEND database, encrypt backup files, store them away from the server and monitor completion. Use pg_restore into a separate isolated database and verify migrations, record counts and a full synthetic lifecycle before accepting the backup as recoverable. Keep OTP keys and operational secrets under separate controlled recovery. Define RPO/RTO before a pilot; neither is verified by this release.

## Release sequence

Apply immutable migrations, provision accounts, configure versioned pricing and approved regions, wire real provider adapters, execute sandbox reconciliation/OTP tests, implement background delivery/recovery and onboarding controls, run security/browser/load tests, verify backup restoration, then obtain operational sign-off. Docker availability was absent in this environment; no container build or production rollout occurred.
