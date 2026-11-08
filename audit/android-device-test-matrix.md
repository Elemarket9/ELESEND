# Android device evidence matrix

Audit date: 2026-11-08. Base: main @ 612b44101b6581e4a1d2774eca067658462178e8. Working branch: audit/2026-11-08-independent-verification. Verification must be based on GitHub Actions at this branch head, not on a green main. No physical Android device, Ghana routing engine, live PSP, production workload or disaster recovery environment was accessed in this review.

| Capability | Source discovered | Physical device proof | Result |
|---|---|---|---|
| Customer Android | `apps/mobile`, customer source flavor | None accessed | Unverified |
| Rider Android | `apps/mobile`, rider source flavor | None accessed | Unverified |
| SMS-free rider handover | API `platform.mjs`, rider source and test fixtures | None accessed | CI pending |
| Suspended rider cash-report flow | HTTP prefilter plus financial report handler | None accessed | Fixed in source; CI pending |
| Offline/Doze/GPS recovery | Android source exists | None accessed | Unverified |
| Checkout return | HTTP checkout return page exists | None accessed | Unverified |
| MapLibre/tile rendering | Mobile mapping source exists | None accessed | Unverified |
| APK compilation and installation | Android Gradle app exists | No build executed by this audit | Unverified |

Before pilot, execute on actual low-end Android handset and rider/customer identities: cold start, login, expiry, background GPS, airplane mode, screen off/Doze, network switch, cash pickup vs cash delivery, rapid duplicate handover taps, stopped GPS, merchant chat, payment redirect, map outage and app restoration. Record OS/device, build SHA, logs, screenshots and outcome.

## Additional Android source fixes (not device tested)
- Customer phone modal now reflects pre-pickup correction rather than an SMS code, commit 81e16c38.
- CustomerApp corrected SMS notice, commit 246105185.
- Rider sender cash pickup and recipient cash delivery use a shared testable helper and server cash-report route before declaration (603b7c5a, 71efaa823).
- No APK/ADB installation, background GPS trace, low-end Android measurement or Expo build was performed as part of this audit.
