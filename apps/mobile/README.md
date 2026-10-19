# ELESEND mobile apps — React Native / Expo, Android + iOS

**Source candidate: no APK/IPA built or tested.** ELESEND is an Android/iOS-native-app product, not a web marketplace. Server has no browser homepage, and the native UI does not embed a WebView. Standalone VPS backend is a secure API only.

## Setup

```sh
cd apps/mobile
npm install
npx expo install --check
cp .env.example .env
# EXPO_PUBLIC_ELESEND_API_BASE_URL=https://api.your-controlled-domain
# GOOGLE_ANDROID_MAPS_SDK_KEY and GOOGLE_IOS_MAPS_SDK_KEY are build-time
# app-restricted keys in app.config.js; NEVER embed the server Routes key.
npx expo run:android        # Android Studio and native build tools required
# iOS: supported macOS/Xcode installation or EAS cloud build and Apple credentials.
```

**Native SDK:** Expo SDK 54 / React 19.1 / React Native 0.81.5 and bundled Expo modules. SDK versions are provisional until Expo's `--check` passes in a networked build environment. Phone hardware testing, GPS permissions, store publication and app signing were not performed here.

### Customer

3-step native map booking → parcel/recipient → `CASH` or `DIGITAL` payer/quote/availability confirmation. Cash delivery bookings go to dispatch without online prepayment. The displayed nearby capacity is **not** a guaranteed accepted driver. Digital checkout cannot complete without an authorized PSP adapter; user is clearly warned.

### Driver / rider

Motorcycle or car registration; cars require plate, make, model and cargo declarations and separate manual verification before dispatch. Online shifts with explicit foreground/background GPS consent and Android ongoing foreground-service notification. Driver sees delivery fees, commission, earning, cash payer, expiry and ETA before accepting. Multi-parcel pilot is feature-gated behind admin approval AND rider opt-in. App shows route manifest, pickup/recipient OTP actions per parcel, receiver cash report, commission debt/credit and initiate PSP repayment action (fails closed with no provider).

### Operations

Native admin panels allow **authorized** admins to review cars/riders, edit bounded dispatch policy and finance repayment limits, inspect aging and create/approve two-person finance waiver requests. UI is not itself an authorization grant; backend revalidates permissions. No identity document scanner/MFA or downloadable receipts yet.

### Offline

Encrypted limited read-only delivery and manifest snapshot in OS secure storage. Offline or unreliably connected app must **not** locally declare OTP handover, payment settled or commission received. A real device synchronization, GPS buffering/permissions and reconnect campaign remains untested.

### Release gaps

- Delivery OTP SMS adapter, actual PSP MoMo collection, refund/reconciliation and push notification workers missing.
- Google Maps native keys and backend Routes quota/sandbox credentials not installed; no road ETA in Ghana verified.
- Production-grade proof-of-person/vehicle, PIN/MFA for finance admins, device GPS anti-spoof evidence, COD merchandise remittances and live cash dispute processing not implemented.
- Build native APK/IPA and validate on real low-end Ghana Android devices, mobile background tracking and iOS permissions before public launch.

### Cash, mobile money, cards and checkout-link QR

`App.js` now includes native choices for CASH / MOMO / CARD / QR, conditional on authorized administrator activation and configured verified PSP adapter. Digital bookings stay unpaid until provider verification. QR uses `react-native-qrcode-svg` and the Expo 54 compatible `react-native-svg` dependency; `metro.config.js` enables the QR text transformer. It displays a checkout **URL** as a QR, not a Ghana GhQR merchant barcode. The QR can be scanned by a second device, or payer may use Open secure checkout.

Install new React Native dependencies with an internet-connected Android/iOS build environment; an actual APK/IPA is required before considering the payment UX working. Backend never accepts card PIN/PAN/CVV. Checkout uses hosted PSP infrastructure from the mobile app.
