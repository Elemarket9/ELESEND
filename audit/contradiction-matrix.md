# Contradiction matrix — 2026-11-08

| ID | Evidence in source | Impact | Status |
|---|---|---|---|
| C-ETA-01 | services/api/eta/eta-service.mjs previously used pickup handover time for preceding dropoffs, inconsistent with stage-eta.mjs separate pickup/dropoff assumptions | Multi-stop ETA overstates 60 seconds per earlier dropoff under default assumptions | Code repaired; regression added; CI pending |
| C-GPS-01 | classifyGps classified finite out-of-bounds coordinates or future-dated timestamps as usable | Fabricated/invalid rider tracking could influence ETA | Code repaired; regression added; CI pending |
| C-SMS-01 | eta-service.mjs retains legacy state AWAITING_DELIVERY_OTP and milestone otp_completed in SQL evidence samples despite new SMS-free rider declaration | Legacy naming needs schema/state trace; may invalidate ETA calibration for newly completed trips | NOT YET VERIFIED; do not remove historical data blindly |

A matching string does not establish reachability. Resolve C-SMS-01 only after tracing producer/consumer milestones and migrations.
