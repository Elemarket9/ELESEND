# Dispatch security review — unresolved risks

### Enforced in source
- Authentication is applied before GPS updates, offers and financial verification; business API keys may access only their allowlisted scoped endpoints; fresh location plus company+rider approval required for assignment.
- Location snapshots validated for longitude/latitude bounds, monotonic timestamps, accuracy, implausible speed; offline changes invalidate offers. These are **heuristics**, not GPS attestation.
- Shipment/rider acceptance uses database transactions and locks; accepted offer verified against authenticated rider UUID, expiry, compensation, fresh position, vehicle rules, company approval, and active custody. A partial unique index prevents simultaneous open/accepted offers for the same shipment.
- Pre-pickup release invalidates all pending OTP challenges, previous offer acceptance, and tracking snapshot. Custody-started assignments cannot be released through that route. `FAILED` custody remains exclusive until recorded return.
- OTP verification remains rider-authenticated and shipment-bound; delivery completion and financial_entries persist atomically. External/ELEMARKET authority cannot complete through ELESEND's ordinary endpoint.
- Search uses geography index with bounded shortlist; no untrusted client-supplied destination URL is passed to fetch. Router endpoint is configured server-side.

### High-risk limitations / launch blockers
- GPS spoofing can be performed with gradual fake coordinates, rooted devices, or replayed provider-level data. Add mobile platform integrity attestation, network/location consistency, device health signals, audit/alerts and privacy consent for production. Heuristics alone do not prove actual road presence.
- No real SMS provider: the test adapter is for test execution only. A carrier acceptance response is not proof of end-user receipt.
- No real payment, refund, reconciliation or durable settlement provider. Do not represent quoted rider entitlement as settled/paid money.
- Cross-platform customer OTP verification for ELEMARKET is unimplemented and must never be simulated with ELESEND status webhook.
- No authenticated notification sender/receiver or worker operating outbox (browser offers polling only). On mobile, service worker/push reception and app background-location permission must be engineered and independently tested.
- No live reverse geocoding, map matching, OSRM motorbike/truck compliance certification, traffic feeds or real-world Ghana road baseline.
- No live PG concurrency/performance verification in this authoring runtime; run supplied integration tests on a disposable database and add failure injection under multiple processes.
- Current public HTTP deployment must sit behind real TLS and hardened reverse proxy with appropriate forwarded IP trust; password/TOTP/MFA, rate-limit tenancy, SSO and rider identity vetting require additional review.
- Admin configurable retention and purging minimises exposure but does not replace Ghana data-protection compliance review, user-facing disclosures and controls.
