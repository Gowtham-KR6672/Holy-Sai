# We School

School management as a service: one platform, many schools. The We School console creates a workspace for each school
on a monthly, quarterly, half-yearly or annual subscription; each school runs its own campuses, staff, students,
parents, fees, transport, academics and AI tools — web app, REST API and iOS/Android app.

| Part | Folder | Stack |
| --- | --- | --- |
| Web app | `apps/web` | React 19 + Vite + TypeScript. School pages (the original Holy Sai Smart School 360 front-end, recovered from the live site — see `reference/`), the **We School console** (`/platform`) and support access. |
| API | `apps/api` | NestJS 11 + Prisma 6 + PostgreSQL — 25 school modules + the platform module (schools, support, billing) |
| Mobile app | `apps/mobile` | Expo (React Native) for iOS and Android — one app for every school, role-based after sign-in (see `apps/mobile/README.md`) |
| Shared | `packages/shared` | Permissions, roles, navigation, icons and translations used by the API and the mobile app |

## How it is organised

- **One database, one schema per school.** The `platform` schema holds We School itself (platform admins, schools,
  plans, payments, invoices, the sign-in directory); each school's data lives in its own schema `ws_<code>`.
- **One sign-in page.** The email or mobile number decides the school — or the We School console for platform admins.
  Each email / mobile number belongs to one school.
- **Roles inside a school:** Workspace Admin (the whole school), Campus Admin (one campus), School Admin, Principal,
  Management, Office, Finance, HR, Teacher, Non-Teaching Staff, Parent, Student.
- **Support access:** a platform admin can open any school (one-hour session as "We School Support"), recorded in both
  audit trails.
- **Subscriptions:** warnings from 15 days before the end date, a 7-day grace period, then only Workspace Admins can sign in
  (to renew). Payments are recorded by hand or paid online — Razorpay (INR); Stripe, PayPal, Razorpay International (USD).

## Run locally

Requirements: Node.js 22 or newer.

```bash
npm install               # approve install scripts if npm 11 asks: npm install-scripts approve
npm run build:shared      # builds packages/shared (the API imports its compiled output)
npm run db:start          # local PostgreSQL on port 5433 (keeps running; data in .data/pg)
```

In a second terminal:

```bash
cp apps/api/.env.example apps/api/.env   # then set secrets (JWT_ACCESS_SECRET, PLATFORM_JWT_SECRET, APP_ENCRYPTION_KEY, SEED_ADMIN_*)
npm run db:migrate        # the platform schema and every school's schema
npm run db:seed           # the platform Super Admin (from SEED_ADMIN_*) and each school's roles, permissions and settings
npm run dev:api           # http://localhost:4000/api
```

In a third terminal:

```bash
npm run dev:web           # http://localhost:5173 (proxies /api to the API)
```

Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` to reach the **We School console**, then create the first
school. Its Workspace Admin signs in on the same page with the temporary password shown once. To change the platform
Super Admin's login later, edit the two values and run `node tools/reset-admin.mjs`.

Phones and other computers on the same network can open the site at `http://<this computer's IP>:5173` (Vite prints
it as "Network:"). The firewall must allow Node.js on that network.

The database must be **UTF-8** (Tamil and Hindi names, the ₹ sign). `npm run db:start` creates UTF-8 databases and warns
if an existing one is not. Managed PostgreSQL in production is UTF-8 by default; keep `max_connections` at least
`API instances × MAX_LIVE_WORKSPACES (15) × WORKSPACE_DB_CONNECTION_LIMIT (2) + 20`.

An older single-school database (school tables in `public`) is converted with
`node tools/convert-to-weschool.mjs --code <code>` (`--revert` undoes it).

## First steps in the console

1. **Plans** — prices in INR and USD. **Settings** — billing details printed on invoices (legal name, address, GSTIN, tax
   %), renewal reminder and grace days, the email sender (SMTP).
2. **Gateways** — Razorpay (INR), Razorpay International / Stripe / PayPal (USD): keys, mode, **Test**, and the webhook
   URLs to register with each provider.
3. **Schools › Create school** — name, permanent code, billing currency, contact, first Workspace Admin, and a trial or a
   paid first period. **Open school (support)** enters it; **Record payment** / **Extend** manage the subscription; **Suspend** then
   **Delete** removes a school and all its data (its payments and invoices are kept).

Inside a school, the Workspace Admin sets up campuses, years, classes, subjects and houses (**Users & Settings › School
Setup**), staff and students, sign-in accounts (**Users & Roles**, including Campus Admins), AI providers, integrations
and **Subscription** (status, online renewal, invoices). A school's webhook addresses include its code:
`/api/w/<code>/…` (shown on its Integrations page).

## Languages

English, Tamil and Hindi. Switch from the sign-in screen or the profile menu. Every page is translated at display time
from `apps/web/src/i18n/dict/<lang>.json` (see `apps/web/src/i18n/domTranslator.ts`); dates follow the language.
After changing page text run `node tools/i18n-extract.mjs`, `node tools/i18n-merge.mjs split`, translate the chunks
into `dict/parts/<lang>-N.json`, then `node tools/i18n-merge.mjs merge`. In development, `window.__i18nMissing` in the
browser console lists on-screen text that has no translation yet.

## Testing

Tests run against a separate **test database** (`holysai_test`) so real schools are never touched:

```bash
node tools/test-api.mjs                     # API on port 4001 against holysai_test (build first: npm run build -w @holysai/api)
node tools/test-web.mjs                     # web app on port 5174 against the test API (for trying things in a browser)
node tools/tests/workspaces.test.cjs        # schools never see each other's data
node tools/tests/platform-console.test.cjs  # console, support access, suspension, admins
node tools/tests/campus-admin.test.cjs      # campus admins see only their campus
node tools/tests/billing.test.cjs           # plans, payments, invoices, signed webhooks, expiry and renewal
node tools/tests/delete-school.test.cjs     # deleting a school: guards, what goes, what stays, code reuse
node tools/tests/account-links.test.cjs     # account ↔ record linking (inside a test school)
node tools/tests/student-lifecycle.test.cjs # leaving and re-enrolling, Tamil and Hindi data
```

Each suite creates its own throw-away school through the console API. `node tools/tests/make-test-accounts.cjs` creates a
test platform admin for the browser (credentials in `.data/test-accounts.json`, git-ignored).

## Project notes

- `HANDOVER.md` — full handover: requirements, architecture, status, open items, how to continue on a new computer.
- `docs/backend-conventions.md` — how API modules are built (envelope, errors, scope, audit, Prisma rules).
- `docs/api-inventory.txt` — every API call the original web app makes.
- `reference/` — the original build (compiled assets, recovered sources, original translations), kept for reference only.
