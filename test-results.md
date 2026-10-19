# Current verification evidence — 17 October 2026

- `npm run test:unit` **PASS: 25/25**, deterministic local unit/mocked HTTP tests only. Includes 4 new adversarial trusted-proxy/client IP tests.
- Backend `.mjs` syntax `node --check`: **PASS**.
- Expo/React Native JSX syntax: TypeScript `transpileModule` **PASS (0 parse errors)** on App.js and 3 mobile helpers; no native build.
- `npm test` / `npm run test:db`: **BLOCKED**, no PostgreSQL/PostGIS server. Earlier attempt to run entire suite before using local dependencies failed with missing `pg` dependency; source now statically parse-valid. No database migrations were executed.
- `npm ci`: **BLOCKED**, npm registry DNS unreachable from current sandbox. Previous workspace's local dependencies are not included in the ZIP.
- Android/iOS APK/IPA, Google Routes live, SMS send, MoMo PSP, Docker/VPS, backup-restore, load tests: **NOT RUN**.

Read `DEEP_SECURITY_AUDIT_2026-10-17.md` for defects, remediation evidence, limitations and exact release gate.
