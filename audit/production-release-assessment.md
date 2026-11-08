# Production release assessment — HOLD / evidence incomplete

Audit date: 2026-11-08. Base: main @ 612b44101b6581e4a1d2774eca067658462178e8. Working branch: audit/2026-11-08-independent-verification. Verification must be based on GitHub Actions at this branch head, not on a green main. No physical Android device, Ghana routing engine, live PSP, production workload or disaster recovery environment was accessed in this review.

Current assessment: **NOT VERIFIED FOR PRODUCTION RELEASE**. Green main CI is a baseline, not an acceptance result. Independent custody regressions from branch `audit/complete-custody` have been imported into the new audit branch after correcting isolated PSP fixture. The narrow suspended rider HTTP authorization repair is committed separately. Their final CI outcome must be checked before describing either as verified.

Release blockers / unknowns: end-to-end payment and payout adversarial tests; actual low-end Android rider/customer journey; final effective DB trigger review under concurrency; Ghana real routing evidence; production provider sandbox/live payments; cash recovery and immediate-withdrawal policy reconciliation; backup, restore, PITR and concurrency capacity evidence. Do not silently waive these.

Branch: `audit/2026-11-08-independent-verification`. No merge to main authorized. Proposed PR must remain draft until full acceptance. Historical OTP records preserved. SMS-free pickup/delivery remains the policy. Optional receipt is not independent proof of receipt. No live PSP or device results claimed.

## Fixes awaiting independent completion evidence
The independent PostgreSQL custody suite run 42516692866 on 40ef866 revealed real failures: stale GPS, overdue pickups missed, lost-parcel complaint rejected, postpickup identity guards not explicit, wrong suspended-rider allowance, Android pickup cash absent, stale SMS wording, and missing table ownership. Changes through a4fb894 were committed to the audit branch, including migration 074. The full latest branch CI is not yet verified; release assessment remains HOLD. Previous green main must not be used to waive failing adversarial suite. Physical devices, real MoMo, actual Ghana routing and backup/restore tests still outstanding.

## Source-and-CI coverage matrix (not a production acceptance matrix)
| Subsystem | Source present | Independent test evidence | Remaining production proof |
|---|---|---|---|
| Authentication/security | Yes | Selected existing CI security cases; not an exhaustive threat audit | Device/session adversarial testing, penetration tests |
| Parcel ordering/handover | Yes | Isolated real PostgreSQL/PostGIS custody suite, multiple defects found | Latest branch CI, handset journey |
| Food ordering | Yes | Existing prepaid-food fixtures; not live order | Kitchen READY pickup regression, full settlement |
| Dispatch/batching | Yes | Custody manifest ordering passed in 42516692866 | 100-5000 load, physical route direction |
| Rider operations | Yes | Suspended rider integration exposed HTTP gate defect | Android background/Doze tests |
| Payments/refunds | Yes | Simulated provider and ledger source audited in part | Provider sandbox/live transfer and refunds |
| Commission/debt | Yes | Existing finance suite, not independently complete | 13%/10% snapshots, GH₵150 threshold races |
| GPS/tracking | Yes | Stale GPS failure reproduced; code repaired | Actual phone GPS freshness and outage |
| Maps/road ETA | Yes | Static source seen, no measured Ghana road graph | Road-ground-truth timing and route validation |
| Android apps | Yes | Source logic/static assertions only | APK compilation/install and low-end devices |
| Chat and WebSocket | Yes | Source discovered | Live auth/reconnect/notification tests |
| Workers/background jobs | Yes | Overdue incident bug reproduced | Worker crash/fault recovery |
| Database/restore | Yes | Isolated PostgreSQL migration/test runs | Backup/restore/PITR and online migration |
| Deployment/monitoring | Yes | CI and config paths inspected | Staging/prod startup, p95 and alerting |

**Owner release decision:** HOLD. The latest commit must pass its own CI; no release permission or merge to main was given. The seven reports are auditable findings, not claims that every original directive was fully completed.
