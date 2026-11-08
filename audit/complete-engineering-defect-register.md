# Independent ELESEND defect register — 2026-11-08

Evidence class: GitHub source inspection + automated regression assertions on audit branch. CI run https://github.com/Elemarket9/ELESEND/actions/runs/42518948507 is the verification source; no claim of success until it completes.

| ID | Severity | Module | Reproduction | Root cause | Fix commit | Regression | Verification | Remaining risk |
|---|---|---|---|---|---|---|---|---|
| ETA-001 | Medium | services/api/eta/stage-eta.mjs | Pass GPS latitude 91, longitude 181 or timestamp 30 seconds in the future to classifyGps at fixed NOW | Coordinates were checked only for finiteness; future timestamps were clamped to age 0 and treated as fresh | cfa0f62920e55f70492df94ab24f8ed9925aeba1 | tests/eta.test.mjs GPS quality test extended in 499381075671066101b4cd47a81bd7e7f88bb83a | Pending current CI result | No physical GPS spoof/device test |
| ETA-002 | Medium | services/api/eta/eta-service.mjs | Simulated rider delivery whose manifest has an earlier dropoff | routeThroughStops charged pickupHandoverSeconds (180) for every preceding stop instead of using 120 for a dropoff | 008f791777259762c99dbb4552410985263a281f | tests/eta.test.mjs earlier-stop test extended in 499381075671066101b4cd47a81bd7e7f88bb83a | Pending current CI result | Real route graph and measured ETA unavailable |

These are independently sourced source-code defects. Reproduction and tests run as mocked code paths in GitHub CI, not on real Android devices. Keep unresolved defects out of the 'fixed and tested' count until CI passes.
