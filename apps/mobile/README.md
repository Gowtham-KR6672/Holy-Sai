# Holy Sai Smart School 360 — mobile app (iOS & Android)

One Expo / React Native app for every role. After sign-in the bottom tabs, home screen and the "More" menu follow the
signed-in role (the original's mobile bottom navigation, `BOTTOM_NAV` in `packages/shared`), and every screen is available
in English, தமிழ் and हिन्दी.

`apps/mobile` is a **standalone Expo project** (SDK 58, expo-router). It is not one of the root npm workspaces and has its
own `node_modules`. The only shared code is `packages/shared/src` (roles, permissions, navigation, icons, translations),
which Metro compiles directly through the `@holysai/shared` alias (`metro.config.js` + `tsconfig.json` paths).

## What each role gets

| Role | Tabs | Main endpoints |
| --- | --- | --- |
| Parent | Home · Track · Academics · Fees · More (Circulars, Messages, PTM, Safety & Pickup) | `/parents/me`, `/parents/:pid/children/:cid/overview`, `/parents/:pid/children/:cid/location(/history)`, `/students/:id/profile`, `/family/children/:id/fees`, `/family/receipts/:id`, `/finance/gateway/orders` + `/finance/gateway/verify` (Pay Now), `/family/circulars(/:id/acknowledge)`, `/family/messages`, `/family/ptm`, `/family/ptm/:id/book`, `/family/ptm/bookings/:id/cancel`, `/family/children/:id/safety`, `/family/children/:id/pickup(/:pid/confirm|revoke)` |
| Teacher | Home · Attendance · Co-Pilot · Students · More (Homework, …) | `/academics/teacher-dashboard`, `/attendance/sections`, `/attendance/register` (GET/PUT), `/academics/homework(/summary, /:id/submissions, /:id/remind, /:id/close)`, `/copilot/context`, `/copilot/drafts(/:id, /approve, /discard)`, `/students`, `/students/:id/profile` |
| Student | Me · Alerts · Tasks · More (My Ideas) | `/students/:id/profile`, `/me/ideas` (GET/POST), `/notifications` |
| Non-teaching staff | Home · Transport · Gate · Alerts · More | `/me/employee`, `/me/roster`, `/me/attendance(/check-in, /check-out)`, `/me/leave-balances`, `/me/leave-requests(/:id/cancel)`, `/me/overtime`, `/me/payslips(/:id)`, `/me/requests`, `/me/tasks`, `/transport/routes(/:id)`, `/transport/boarding`, `/gate/log`, `/gate/events` |
| Principal | Pulse · Students · Alerts · Tracking · More | `/dashboard/command-center`, `/students`, `/students/summary`, `/tracking/map`, `/tracking/students`, `/students/:id/location(/history)` |
| Office | Admissions · Fees · Students · Tasks · More | `/admissions/dashboard`, `/enquiries`, `/finance/fees/summary`, `/students` |
| Admin, Management, Finance, HR | Home (Pulse or Fees) · Alerts · Tasks · More | as above, by permission |
| Everyone | Notifications, My Tasks (with Review), My account | `/notifications`, `/notifications/counts`, `/notifications/:id/read`, `/notifications/read-all`, `/tasks`, `PATCH /tasks/:id`, `/auth/change-password`, `/auth/sessions/revoke-all` |

"More" lists every other feature the role has permission for (the web sidebar, filtered by the same permissions).
Features with a native screen open in the app; the rest open in the web portal (`EXPO_PUBLIC_WEB_URL`).
Endpoints that are not built yet show a friendly "Not available yet" state rather than an error.

## Sign-in and session

- `POST /auth/login { identifier, password, clientType: 'mobile' }`; every request sends `X-Client-Type: mobile`.
- The access token stays in memory; the refresh token is stored with `expo-secure-store` (Keychain / Keystore).
- On a 401 the client refreshes once (`POST /auth/refresh { refreshToken }`, single-flight so a rotated token is never
  presented twice), stores the new refresh token and retries. On launch the saved session is restored the same way; if the
  server is unreachable the app offers "Try again" instead of signing the user out.
- Sign out calls `POST /auth/logout { refreshToken }` and clears the device.

## Run it

Prerequisites: Node 22+, the API running (`npm run dev:api` from the repo root, port 4000).

```bash
cd apps/mobile
npm install
cp .env.example .env          # optional: set EXPO_PUBLIC_API_URL for a physical phone
npx expo start                # then press a (Android emulator), i (iOS simulator) or scan the QR code
```

- **Expo Go** (quickest): install Expo Go on the phone, make sure phone and computer are on the same Wi-Fi, set
  `EXPO_PUBLIC_API_URL=http://<your-computer-LAN-IP>:4000/api`, run `npx expo start` and scan the QR code.
  Everything works in Expo Go except remote push notifications on Android.
- **Development build** (recommended for testing like production): `npx expo run:android` / `npx expo run:ios` locally,
  or `npx eas-cli@latest build --profile development --platform android|ios` and install the result.
- **Web smoke test**: `npx expo start --web` (port 8081). The API only allows the origins in `WEB_ORIGIN`
  (apps/api/.env), which already includes `http://localhost:8081`. Phones are not
  affected by CORS.

Checks:

```bash
npm run typecheck              # tsc --noEmit (strict)
npx expo-doctor
npx expo export --platform android
```

## Store builds with EAS

`eas.json` has three profiles: `development` (dev client, internal), `preview` (installable APK / ad-hoc IPA for testers)
and `production` (Play Store app bundle / App Store build, auto-incremented build numbers). Set the real API and web
URLs in each profile's `env` before building.

```bash
npx eas-cli@latest login
npx eas-cli@latest init                     # links the project and writes extra.eas.projectId into app.json
npx eas-cli@latest build --profile preview --platform android
npx eas-cli@latest build --profile production --platform all
npx eas-cli@latest submit --profile production --platform android   # or ios
```

Identifiers: iOS bundle id and Android package are both `com.holysai.smartschool360`.

## Notes and to-dos

- **Push notifications**: after sign-in the app asks for permission and registers its Expo push token with
  `PUT /api/auth/push-token` (`src/lib/push.ts`); signing out on the phone removes it on the server. Remote push needs
  `eas init` (project id) and a development/store build, and the school must enable Integrations › Push.
- **Payments**: Pay Now creates a Razorpay order (`POST /finance/gateway/orders`), opens Razorpay Checkout in a WebView
  (UPI apps are handed to the phone) and confirms it with `POST /finance/gateway/verify`. A 503 means the school has not
  connected a payment gateway yet; the parent is asked to pay at the office.
- **Maps** use Leaflet with OpenStreetMap tiles in a WebView (or the tile server configured under Integrations › Maps),
  so no Google Maps key is needed.
- The app icon and splash are generated from `apps/web/public/logo-mark.webp` (213 px wide). Replace
  `assets/icon.png`, `assets/splash-icon.png` and `assets/android-icon-*.png` with high-resolution artwork before release.
- Mobile strings are translated in `packages/shared/src/i18n/modules/mobile.ts` (Tamil and Hindi, keyed by the English text).
