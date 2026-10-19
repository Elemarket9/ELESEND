# Running ELESEND 12-algorithm tests

Requires Node.js >=22.16.0.

```sh
npm ci
npm run test:algorithms-full
npm test
```

`test:algorithms-full` uses standard `node:test` and deterministic road fixtures, so it can run even when PostgreSQL and real routing credentials are unavailable. `npm test` includes database-dependent tests and MUST pass with real dependencies/PostGIS/Redis before a release decision changes. To run actual DB tests, use the project's `.env.example`, disposable PostgreSQL/PostGIS instance, and `npm run db:migrate` only on a TEST DATABASE first. NEVER apply new migrations to a production database without an independently verified backup and restore plan.

Mobile code is in `apps/mobile`; the delivered archive is source, NOT a compiled APK or IPA. For Android and iOS compile use the app's README and an appropriate local build environment.
