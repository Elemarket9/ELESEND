# ELESEND API modules

The API is a modular monolith: one process and one database, split into modules that only talk to each other through a small public entry. `config/modules.json` is the map, and `tests/module-boundaries.test.mjs` enforces it.

```
services/api/
├── modules/
│   ├── payments/   checkout, wallets, settlement, commission, payouts
│   ├── orders/     parcels, dispatch, pricing, ETAs, notifications, webhooks
│   ├── riders/     rider documents, licence, vehicles, rider tools, companies
│   ├── food/       restaurants, food orders, commissions, promotions
│   ├── maps/       routing (OSRM or Google), search, traffic, map learning, tracking
│   └── safety/     chat, trusted contacts, emergencies, ratings
├── shared/         security, database, rate limits, market settings, geometry, algorithms
├── config.mjs      configuration (composition)
├── http.mjs        HTTP routes (composition)
├── server.mjs      API process (composition)
├── worker.mjs      background worker (composition)
└── background-jobs.mjs
```

## The rules

1. **One public entry per module.** Code outside `modules/<name>/` imports only `modules/<name>/index.mjs`. Tests and scripts may import internal files directly.
2. **Declared dependencies only.** Each module lists the modules it uses in `dependsOn` in `config/modules.json`. A new dependency fails the test until it is declared there, so it gets reviewed.
3. **Shared code has no business owner.** `shared/` may not import any module. Put something there only if it is pure (like `haversine`) or plain infrastructure (like `db.mjs`).
4. **Payments and maps depend on nothing but shared code.**
5. **Every file loads on its own.** Modules reach each other through their entries, so a value used while a file loads (a schema, a constant) must not come round a cycle. Keep such values in a file that imports no other module, and list it first in the entry. The boundary test loads every module file in a fresh process to catch this.
6. **Accounts and messaging are shared.** `users`, `sessions`, `permissions`, push tokens, phone and recovery challenges, admin MFA, API clients, `notification_jobs` and `outbox` belong to `shared` in `config/modules.json`, because every module signs people in, checks permissions and queues messages.
7. **Each table has one owner.** SQL that reaches another module's tables is recorded in `config/module-boundary-baseline.json`. That list may only shrink: replace a cross-module query with a call to the owning module's entry, then run `node scripts/module-boundaries.mjs --write`.

## Current dependencies

| Module | Uses |
|---|---|
| payments | none |
| maps | none |
| safety | maps |
| riders | orders, payments |
| food | orders, payments, safety |
| orders | food, payments, riders, safety |

Orders still has two-way links with food and riders. Those calls happen inside functions, not while files load, so they are safe. They are the next to untangle.

## Checking

```sh
node scripts/module-boundaries.mjs        # summary
node --test tests/module-boundaries.test.mjs
```

## What is left

100 queries still read or write another module's tables (`config/module-boundary-baseline.json`). The largest are in `orders/platform.mjs`, `food/restaurant-orders.mjs`, `safety/chat-engine.mjs` and `orders/dispatch.mjs`. Moving them behind module entries changes how transactions are shared, so each one needs its own change and tests.
