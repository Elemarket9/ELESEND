# Source audit and extraction decisions

## Evidence and provenance

The working tree supplied in `elemarket9` identifies package version **2.11.3**, `ELEMARKET_EIDE_FINAL_CLEAN_SOURCE`, dated 2026-10-16. It uses TypeScript, React 19, TanStack Start, Vite, Better Auth, PostgreSQL/pg/Kysely and an Expo-oriented mobile tree. `source-baseline.json` records the commit, SHA-256 of each of 828 tracked source files, and an aggregate manifest checksum. The tree was clean when discovery started. No AGENTS.md files were found in the workspace.

The only adjacent ZIP discovered was `elemarket-ci-mobile-complete-repair.zip`, SHA-256 **38bbc6c164d24f15a56a51cf8119202ee194971e0dc1d1c556d624ecb0135aaa**. Its PACKAGE-INFO reports 2.11.3, a developer repair package and NO-GO for public exposure. Archive listing shows mobile/security and repair material; **it does not contain the backend delivery files inspected here**. Its metadata was extracted under `reference/elemarket-archive`. It cannot establish provenance for the complete latest backend. A full backend source archive remains unavailable. The supplied current working tree was used as the implementation reference instead; that distinction must not be erased.

Eight relevant working-tree files were copied to `reference/working-tree` solely as non-executable audit evidence. No marketplace module is imported at runtime. Existing schema order dependencies make direct migration copying inappropriate. New ELESEND schema and application policies were implemented independently, adapting purpose-bound OTP and explicit transition patterns. Existing archive and original working tree were not modified.

## Extraction dependency matrix

Locations below are relative to the original ELEMARKET tree, also recorded in the source hash manifest.

| Component / location | Observed dependencies | Decision and limitation |
|---|---|---|
| logistics/internal/transport/partner.delivery.functions.ts | TanStack server functions; identity middleware; orders; merchants; partner organizations; provider rows; order_delivery_handover; protected receipt flow | Replace orchestration. Original order receipt must remain authoritative for later integration. Not copied as runnable code. |
| logistics/internal/transport/delivery-otp-crypto.ts | Node HMAC/randomInt/timingSafeEqual; ELEMARKET_HANDOVER_OTP_HMAC_KEY; order/job/rider/phone binding | Adapt pattern into security.mjs with a separate OTP_KEY and shipment/purpose/challenge/rider/phone binding. Original code retained as reference. |
| logistics/internal/transport/handover-authority.server.ts | organization/provider activation; user emailVerified; personnel capability; pickup location attendant joins | Replace with independent company/rider approval and exact assignment locks. ELESEND does not yet replicate verification evidence, accepted invitations or account phone verification. |
| logistics/internal/transport/rider-workforce.functions.ts | organization membership, invitations, delivery holds and job ownership | Do not extract wholesale. Independent registration and hashed, exact-rider invitation consent implemented separately; full workforce evidence/delegation outstanding. |
| logistics/internal/delivery-state.ts | marketplace transport statuses and a separate handover stage | Adapt explicit transition pattern; add independent payment/quote lifecycle and SQL transition guard. No marketplace delivered status is reused. |
| logistics/internal/adapters/delivery.server.ts | marketplace customer/merchant checks; environment helpers; rate limit; server geocoder; pinned HTTPS; shared money | Replace quote service. Existing server-geocoding protection is not yet replicated: client coordinate estimates are unsuitable for live paid pricing. |
| logistics/internal/adapters/providers/geoapify.server.ts | provider configuration, remote geocoding/routing | Leave untouched. RoutingAdapter contract only; production geocoder not implemented. |
| payments/internal/adapters/providers/registry.ts | literal built-in Paystack adapter; marketplace payment contract | Do not extract marketplace financial workflows. Independent adapter contracts and internal reconciled event seam exist; actual provider integration blocked. |
| migrations/0194_owned_handover_otp.sql | orders, delivery_jobs, otp_challenges | Reference only. New independent challenges table. |
| migrations/0203_delivery_personnel_and_pickup.sql | partner organizations/users, provider invitations, delivery_jobs and shipments | Reference only. No ELESEND table references any original schema. |
| migrations/0190–0210 delivery changes | marketplace holds, invitation outbox, recovery/returns, allocation, evidence, reassignment, tracking origins | Filenames/schema context inventoried. Not all SQL bodies or migration histories fully audited; no claim of complete source security review. |

Prefix `logistics/` means `src/modules/logistics/`, and `payments/` means `src/modules/payments/`. The observed import graph was: routes → public module transport → internal transport → identity/database/shared/security/provider modules → orders, merchants, partner memberships and finance. That coupling requires adaptation at domain boundaries, not filesystem extraction alone.

## Readiness and review limits

Readiness of original delivery components is **not independently certified**. The repository package scripts reference delivery PostgreSQL and browser tests, but the clean source tree does not provide a normal tests directory. Existing ELEMARKET tests were not run, and original provider sandbox behavior was not exercised. Negative controls in ELESEND were tested separately. A wider source audit, full migration dependency inventory and current original test archive are still required before claiming full phase-one completion.

The audit identifies dependencies and protection patterns, not proof that every original mechanism is secure. No defect has been asserted against unexecuted original code. ELESEND's own demonstrated scope and security gaps are in security-report.md and release-readiness.md.
