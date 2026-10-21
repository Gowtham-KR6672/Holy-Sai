# We School — Handover

_Last updated: 21 October 2026. Written so the work can continue on another computer or in a new chat without
losing anything. Secrets are **not** in this file — they are in `handover.env` (kept out of git; copy it by hand)._

We School is the school-management product that began as **Holy Sai Smart School 360** for Holy Sai International
School. On 21 Oct 2026 the owner turned it into a multi-school SaaS: a platform Super Admin creates a **workspace** for
each school on a subscription, each school has its own admins, and the Super Admin can enter any school for support.

---

## 1. Summary — where things stand

| Part | Folder | State |
| --- | --- | --- |
| API (NestJS) | `apps/api` | Multi-school. 25 school modules + the **platform** module (console, support access, billing). Typecheck 0 errors. |
| Web app (React) | `apps/web` | School pages (the original UI) + the **We School console** at `/platform`, support access, the school's Subscription page. Typecheck 0 errors. |
| Mobile app (Expo) | `apps/mobile` | Same sign-in for every school; ends the session with a message when a school is suspended or its subscription ended. Typecheck 0 errors. Not yet run on a real phone; no APK yet. |
| Shared package | `packages/shared` | Roles (incl. **Campus Admin**), permissions (63), navigation, icons, enums, mobile translations. |
| Database | embedded PostgreSQL (dev) | One database: schema `platform` (We School) + one schema per school `ws_<code>`. Dev DB `holysai_app`: workspace **`holysai`** (converted from the single-school data). Test DB `holysai_test`: workspace `qa` + throw-away test schools. |
| Rebrand | merged into `main` | New logo, neutral sign-in page, texts, mobile app name/ids (commit `5c4f217`, merged 21 Oct 2026). |
| GitHub | https://github.com/Gowtham-KR6672/Holy-Sai | `main` (local) holds the We School work, the rebrand and the Tamil/Hindi translations — **not pushed yet**. The repository is **public**. |

Nothing has been tried with **live third-party accounts** (Razorpay/Stripe/PayPal for subscriptions, school
integrations, AI providers, devices). Gateway webhooks are covered by signed-payload tests — see §15.

---

## 2. Background

- **Client / first school:** Holy Sai International School (Cambridge curriculum, Guduvanchery, Tamil Nadu).
- **Why a rebuild:** the original application (`https://holy-sai.onrender.com`) lost its source code. Its front-end was
  recovered from the live site's source maps into `apps/web/src` and used as the specification; `reference/` keeps the
  recovered build (never executed or deployed).
- **We School (21 Oct 2026):** the owner's business model — monthly / quarterly / half-yearly / annual subscriptions per
  school; each school gets its own admin login; the school admin can create admins for other campuses; the platform
  Super Admin can access any school at any time for support; the product is named **We School**.
- **Live site caution:** when exploring the old live site, use one browser tab only (refresh-token reuse protection),
  and never type passwords into it on someone's behalf.

---

## 3. Requirements and how they are met

| # | Requirement | Implementation |
| --- | --- | --- |
| 1 | Workspaces per school, created by the Super Admin | Console › Schools › **Create school**: provisions the school's own schema, seeds roles/permissions/settings, creates the first **Workspace Admin** (temporary password shown once). |
| 2 | Subscriptions: monthly, quarterly, half-yearly, annual | Plans with INR and USD prices (Console › Plans). Periods per school; status active → ending soon (15 days) → grace (7 days) → ended. |
| 3 | Payments: manual, Razorpay, others, international in USD | Console › Record payment (bank / UPI / cheque / cash…); online renewal by the school: **Razorpay** (INR), **Stripe, PayPal, Razorpay International** (USD). Webhooks settle automatically; PDF invoices. Currency fixed per school. |
| 4 | One admin login per school; they add admins for other campuses | Role **Workspace Admin** (all campuses; was "Super Admin" inside the school) creates **Campus Admins**, each limited to one campus. |
| 5 | Super Admin can access any school any time | Console › school › **Open school (support)**: one-hour support session as the school's hidden "We School Support" account; recorded in both audit trails; works when suspended or expired. |
| 6 | Site name We School | Product name everywhere; each school's own name inside its workspace (logo upload still open — §16). |
| 7 | One sign-in page | Email / mobile number decides the school (or the console). Each email / mobile belongs to one school only. |
| 8 | Expiry | Warnings from 15 days before; after a 7-day grace period staff, parents and students cannot sign in; Workspace Admins can sign in only to renew; data kept. |
| 9 | AI keys | Each school connects its own (AI Providers page), as before. School integrations (WhatsApp, SMS, email, fee payments, GPS…) are per school too. |

Earlier requirements still hold (no demo data; Paper Correction; English/Tamil/Hindi; student leaving keeps the record and
disables logins; campuses with map coordinates) — see §10–§14.

---

## 4. Repository layout

```
Holy Sai/
├─ apps/
│  ├─ api/
│  │  ├─ prisma/schema/            school models (one .prisma per module) + migrations/ (applied to every ws_<code>)
│  │  ├─ prisma/platform/          platform models (We School) + migrations/ (schema "platform")
│  │  ├─ prisma/seed.ts            platform Super Admin + every school's catalogue
│  │  └─ src/
│  │     ├─ tenancy/               multi-school core: context, TenancyService, Prisma proxy, middleware, migrator,
│  │     │                         sign-in directory, campus pinning, subscription status, platform settings
│  │     ├─ platform/              console API, platform auth, provisioning, support access, billing/ (gateways, invoices, jobs)
│  │     ├─ common/                envelope, errors, paging, auth guard, scope, crypto, counters
│  │     └─ modules/               the 25 school modules
│  ├─ web/src/pages/platform/      the We School console (/platform/*) and /support
│  ├─ web/src/pages/core/SubscriptionPage.tsx   the school's Subscription page
│  └─ mobile/                      Expo app (own node_modules)
├─ packages/shared/                roles, permissions, navigation, i18n
├─ tools/                          dev-db, migrate-all, convert-to-weschool, reset-admin, prisma-generate, smoke-api,
│                                  test-api, test-web, tests/ (end-to-end suites)
├─ docs/                           backend conventions, API inventory
├─ reference/                      recovered original build (reference only)
├─ .claude/launch.json             dev servers: db 5433, api 4000, api-test 4001, web 5173, web-test 5174, mobile-web 8081
├─ README.md · HANDOVER.md
└─ handover.env                    ALL settings incl. secrets (git-ignored — copy by hand)
```

---

## 5. Tech stack

Node.js 22+ (developed on 24.21) · TypeScript 5.9 · NestJS 11 · Prisma 6.19.3 (two generated clients: school
`@prisma/client`, platform `.prisma/platform-client`) · PostgreSQL 18 (embedded for development) · `pg` 8.23 (migrator,
tools) · React 19 + Vite 8 · TanStack Query 5 · Expo SDK 58 · pdf-lib (invoices) · nodemailer (platform email).
npm workspaces: `packages/shared`, `apps/api`, `apps/web` (mobile is standalone).

---

## 6. Set up on a new computer

1. Install Node.js 22+ and Git; `git clone https://github.com/Gowtham-KR6672/Holy-Sai.git`.
2. Copy `handover.env` to **`apps/api/.env`** (it now includes `PLATFORM_JWT_SECRET`).
3. `npm install` at the root (approve install scripts if npm asks: prisma, @prisma/engines, @prisma/client, esbuild,
   embedded-postgres). `postinstall` generates **both** Prisma clients.
4. `npm run build:shared`.
5. Terminal 1: `npm run db:start` — PostgreSQL on 5433 (max_connections 300), creates `holysai_app` (UTF-8) if missing.
6. Terminal 2:
   - `npm run db:migrate` → `tools/migrate-all.mjs`: the platform schema, then every school schema.
   - `npm run db:seed` → the platform Super Admin from `SEED_ADMIN_*` (if none) and every school's catalogue.
   - `npm run dev:api` → http://localhost:4000/api.
7. Terminal 3: `npm run dev:web` → http://localhost:5173. Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` → the
   **We School console**. Create schools there. Other devices: `http://<this computer's IP>:5173`.
8. **Carrying over a database from the old computer:** copy the whole `.data/pg` folder (with the database stopped) — the
   schools are schemas inside it. A fresh database starts empty: create the schools again in the console.
9. **An older single-school database** (tables in `public`): `node tools/convert-to-weschool.mjs --code <code>` moves them
   into `ws_<code>`, creates the platform schema and the workspace, turns `SEED_ADMIN_EMAIL`'s account into the platform
   Super Admin (same password) and the old school Super Admin account into the hidden support account. `--revert` undoes
   the move. Done on 21 Oct 2026 for `holysai_app` (→ `holysai`) and `holysai_test` (→ `qa`).
10. **Test environment** (keeps test records out of real schools): the test database `holysai_test`; start
    `node tools/test-api.mjs` (API on 4001, built from `apps/api/dist`, sign-in rate limit raised) and
    `node tools/test-web.mjs` (web on 5174 → 4001). Both are in `.claude/launch.json` (`api-test`, `web-test`).
11. Mobile: `cd apps/mobile && npm install`, `EXPO_PUBLIC_*` lines from `handover.env` into `apps/mobile/.env`,
    `npx expo start`.

**Windows notes.** While an API runs, `prisma generate` cannot replace the engine DLL — stop the APIs first, then
`node tools/prisma-generate.mjs` (generates both clients under a lock). Stopping the database from a tool window can be
unclean; the next start replays the WAL and fsyncs every file (minutes with many test schools).

---

## 7. We School architecture (multi-school)

**Data.** One PostgreSQL database. Schema `platform`: PlatformAdmin, PlatformSession, Workspace, LoginIdentifier (sign-in
directory), DeviceToken, SupportCode, PlatformAuditLog, PlatformSetting, Plan, SubscriptionPeriod, Payment, Invoice,
GatewayConfig, GatewayEvent, PlatformCounter, ReminderLog. Each school: schema `ws_<code>` with the 158 school tables,
created by `src/tenancy/migrator.ts` from `prisma/schema/migrations` (recorded in that schema's `_prisma_migrations`).

**Requests.** `workspacePathRewrite` (main.ts) turns `/api/w/<code>/…` into `/api/…` for that school. `TenancyMiddleware`
picks the school from the access token's `ws` claim, the `/w/<code>/` address, or (GPS ingest) the device token; stores it
with the subscription status in AsyncLocalStorage. `PrismaService` is a **proxy** to the current school's Prisma client
(`src/tenancy/prisma.proxy.ts`), so module code is unchanged. Outside a school, school data access fails with a clear
400 `NO_SCHOOL`.

**Clients and connections.** `TenancyService` keeps one Prisma client per school (pool `WORKSPACE_DB_CONNECTION_LIMIT`,
default 2), at most `MAX_LIVE_WORKSPACES` (15) open, idle ones closed after 3 minutes; background jobs close a school
again unless a request is using it. Measured ≈ 8 MB per open school. PostgreSQL needs
`max_connections ≥ API instances × 15 × 2 + 20`. Do not put PgBouncer in transaction mode in front (search_path).

**Jobs.** Every `@Cron` / `@Interval` runs once per school (`@ForEachWorkspace`). The Paper Correction queue first asks
one cross-schema query which schools have work. Per-school catalogue seeds are registered with `WorkspaceSeeds` and run
for every school at start-up and for a new school. In-memory caches are per school (`PerWorkspace`, `workspaceKey`).

**Sign-in.** `POST /auth/login` looks the email / mobile up in the directory → a school (school session: JWT `{sub, fam, ws,
aud:'ws'}`, refresh token `<code>.<secret>` in cookie `hs_rt` or the mobile body) or the console (platform session: JWT
signed with `PLATFORM_JWT_SECRET`, cookie `we_prt` on `/api/platform/auth`). The directory is written in the same
transaction as the user (Users & Roles); a nightly job reconciles it. Platform admins cannot use the mobile app.

**Support access.** Console › Open school (support) → single-use code (60 s) → new tab `/support#code=…` → one-hour token
for the school's hidden "We School Support" account (`we-school-support@<code>.support.weschool.invalid`, hidden from user
lists, cannot change passwords) with `sup` claim; support bar in the school; audited in both trails.

**Campus Admins.** Role `campus_admin` (scope school, pinned): the guard pins every request to the account's campus
(rewrites `?campusId=`, refuses other campuses), `ScopeService` returns that campus, and a Prisma extension
(`campus-pin.extension.ts`) limits every model with a `campusId` column — including records opened by id — and hides other
campuses. Campus Admins set up their own campus (School Setup: campus details, classes and sections; permission
`setup.campus`) and create users for it, but not school-wide roles. Limit: records without a campus column (e.g.
guardians) are not filtered by id.

**Subscriptions.** Status from the latest period end date in the school's time zone (`subscription-status.service.ts`).
Suspended (by a platform admin) or expired (past grace): sign-in refused except Workspace Admins of an expired school, who
reach only `/auth/*` and `/subscription/*` (other pages answer 402); support always gets in. A school with no subscription
yet is not restricted.

**Billing.** `src/platform/billing/`: gateway settings (keys AES-encrypted; Test button), checkout (Razorpay Orders +
Checkout.js; Stripe Checkout Session redirect; PayPal Orders v2 approve → capture), webhooks
`/api/platform/webhooks/{razorpay,stripe,paypal}` (HMAC of the raw body / Stripe-Signature with 5-minute tolerance /
PayPal verify-webhook-signature; each event once), settling once per payment (new period after the current end or from
today; invoice `WS-INV-YYYY-NNNN` with tax from Platform settings; receipt email; notification in the school). Daily
reminders 09:00 IST (15/7/3/1 days, end day, grace start/last day, blocked). Unfinished checkouts fail after 6 h.

---

## 8. Accounts, roles and security

- **Platform Super Admin:** `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (in `handover.env`). Change with
  `node tools/reset-admin.mjs` (updates the platform admin, its directory entry, signs it out; `DATABASE_URL=… node
  tools/reset-admin.mjs` targets another database). The owner chose a new Super Admin login on 21 Oct 2026 and it was
  set this way in the dev database and in `apps/api/.env` / `handover.env` (both git-ignored) — never in a tracked file.
  Passwords need at least 10 characters. More platform admins:
  Console › Admins (temporary password, must change at first sign-in).
- **School accounts:** created by each school (Users & Roles), or by the console (first admin, extra admins, password
  resets with temporary passwords).
- **Tokens:** access 15 min; refresh rotation with a 60-s reuse grace; lockout after 5 failures for 15 min; sign-in rate
  limit 10/min per address (`LOGIN_RATE_LIMIT`). Secrets at rest (AI keys, integrations, gateway keys, SMTP password):
  AES-256-GCM with `APP_ENCRYPTION_KEY`.
- **School roles (12):**

| Role key | Name | Scope | Home | Permissions |
| --- | --- | --- | --- | --- |
| super_admin | **Workspace Admin** | school | /overview | all 63 |
| school_admin | School Admin | school | /overview | 56 |
| campus_admin | **Campus Admin** (one campus) | school, pinned | /command-center | 51 |
| principal | Principal | school | /command-center | 46 |
| management | Management | school | /command-center | 25 |
| office · finance · hr | Office · Finance · HR | school | /admissions · /fees · /workforce | 30 · 9 · 10 |
| teacher | Teacher | class | /teacher | 20 |
| staff | Non-Teaching Staff | self | /staff-self | 5 |
| parent | Parent | family | /parent-360 | 3 |
| student | Student | self | /my-profile | 1 |

  New permissions (appended so role positions stay valid): `setup.campus`, `subscription.manage`. The seed gives newly
  added permissions to the roles defined with them, without touching a school's own changes.

---

## 9. API modules

Conventions unchanged (`docs/backend-conventions.md`): envelope `{ success, data, message, meta? }`, audited writes,
`paged()` lists, no cross-file Prisma relations. New:

| Module | Routes | What it covers |
| --- | --- | --- |
| platform | `platform/auth/*`, `platform/overview`, `platform/workspaces/*`, `platform/support/exchange`, `platform/admins`, `platform/audit`, `platform/plans`, `platform/payments`, `platform/gateways/*`, `platform/settings`, `platform/invoices/:id/pdf`, `platform/webhooks/*` | the We School console API (platform admins only, except support exchange and webhooks) |
| subscription (school side) | `subscription`, `subscription/checkout`, `subscription/razorpay/verify`, `subscription/confirm`, `subscription/invoices/:id/pdf` | the school's Subscription page (`subscription.manage`) |

The 25 school modules are unchanged in behaviour (see the module table in git history of this file) except: Users &
Roles (directory, campus admins, hidden support account), School Setup (campus admins), public config (We School vs the
school), GPS devices (token index), auth (directory, platform, support, subscription checks).

---

## 10. School policies built in

Unchanged: account ↔ record linking; student leaving keeps the record and disables logins (re-enrol restores); no demo
data. New: one email / mobile per school across We School; the hidden support account never appears in lists and does
not count as the school's admin.

---

## 11. AI and integrations (per school)

As before, each school connects its own AI providers and integrations. **Webhook addresses now include the school:**
`/api/w/<code>/whatsapp/webhook`, `/api/w/<code>/finance/webhooks/razorpay` (fee payments), `/api/w/<code>/gate/webhooks/scan`,
`/api/w/<code>/workforce/webhooks/biometric`; certificate verification `/api/w/<code>/certificates/verify/:code`. GPS
devices keep `/api/tracking/ingest` (the token finds the school). Each school's Integrations page shows its own
addresses; the bare addresses (without `/w/<code>`) answer `NO_SCHOOL`.

---

## 12. AI Paper Correction

Unchanged (pipeline, marking rules, external-processing acknowledgement). The background worker is per school.

---

## 13. Translations

Unchanged mechanism (`domTranslator.ts`, `dict/parts/*`, `tools/i18n-extract.mjs` / `i18n-merge.mjs`). The rebrand adds
`ta-brand.json` / `hi-brand.json`; the console, support bar, subscription pages and campus-admin texts are in
`ta-platform.json` / `hi-platform.json` (incl. the gateway field names the API sends). Only four non-text values remain
untranslated (CSS values, a setting key, a path). Data from the API stays as entered: school names, codes, platform
audit descriptions and gateway error messages.

---

## 14. Using it — first steps

1. Console › Plans: set INR and USD prices. Console › Settings: billing details (legal name, address, GSTIN, tax %),
   renewal days, the email sender (SMTP) — "Save and send a test".
2. Console › Gateways: Razorpay (INR), Razorpay International / Stripe / PayPal (USD) — keys, mode, **Test**; register
   the webhook URLs shown there with each provider.
3. Console › Schools › Create school: name, code (permanent), billing currency, contact, first admin, and a trial or a
   paid first period. Share the temporary password privately.
4. The school's Workspace Admin: School Setup (campuses, years, classes, subjects, houses), staff, students, Users & Roles
   (incl. Campus Admins), AI Providers, Integrations, Paper Correction settings — as before.

---

## 15. What was tested (21 Oct 2026, test database, API on 4001)

- Typecheck: API 0, web 0, mobile 0 errors.
- `tools/tests/workspaces.test.cjs` — 27/27: separate schemas, lists and records per school, 40 interleaved concurrent
  requests never cross, tokens only valid in their school, refresh tokens bound to the school, one email per school,
  hidden support account, GPS token routing, school addresses, clear errors without a school.
- `tools/tests/platform-console.test.cjs` — 27/27: school details and rename, support access (single-use, audited in both
  trails, works when suspended, cannot change passwords), suspend/resume, extra admins, password resets, platform admins.
- `tools/tests/campus-admin.test.cjs` — all: own campus only (lists, `campusId=all`, by-id, edits), cannot add campuses or
  school-wide admins, campus dashboard works, Workspace Admin unaffected.
- `tools/tests/delete-school.test.cjs` — all: only a suspended school with its code typed; schema, sign-ins, sessions,
  webhooks and uploads gone; payments and invoices kept (marked "Deleted school"); code and admin email reusable by a
  new, empty school.
- `tools/tests/billing.test.cjs` — all: plans, tax, masked gateway keys, Test button, trial, manual payment + invoice PDF
  (18% tax), Razorpay and Stripe webhooks (forged / stale / replayed refused or ignored), USD school, expiry (staff blocked,
  admin 402 except Subscription, support allowed), renewal, checkout error with bad keys.
- `tools/tests/account-links.test.cjs`, `student-lifecycle.test.cjs` (21 checks, Tamil/Hindi) — inside test schools.
- Every scheduled job run once across 15 schools without errors; `tools/smoke-api.mjs` 188/200 (same as before) before
  the cut-over.
- Browser (test web 5174): console sign-in, overview, schools, create school, school page, support access and exit,
  school sign-in on the shared page, school Subscription page, gateways page; the console in Tamil and Hindi; a school's
  Integrations page showing `/api/w/<code>/…` addresses.
- After committing the We School work and merging the rebrand (21 Oct 2026): typecheck API 0, web 0, mobile 0; all
  suites above pass again; `tools/smoke-api.mjs` on `holysai` through support access 188/200 (the same 12 as before).

**Not tested (needs real accounts/devices):** Razorpay / Stripe / PayPal live or sandbox checkouts (PayPal webhooks
especially), the platform SMTP sender, school integrations, AI providers, the mobile app on phones.

---

## 16. Open items and decisions

1. **Push `main`** to GitHub when the owner says so (everything is committed locally).
2. Check the Tamil/Hindi console texts with a native speaker (machine-assisted translations).
3. Hosting: API + web + managed UTF-8 PostgreSQL (watch `max_connections`), public HTTPS for webhooks, `PUBLIC_WEB_URL`.
4. Sandbox accounts for Razorpay (INR + international), Stripe and PayPal; a real SMTP account for receipts and reminders.
5. **Schools outside India:** time zone and fee currency per school (daily jobs and fee amounts still assume
   Asia/Kolkata and ₹ inside schools).
6. Per-school logo upload (School Setup) — the header shows the school name; a logo field is not built yet.
7. **Deleting a school** (console › school › Delete): only once suspended (or a failed set-up), with its code typed.
   Drops its schema, sign-in entries, device tokens and local uploads; keeps its payments and invoices (the school row
   stays as `deleted`, code renamed `<code>~deleted~<stamp>` so the code can be reused). Files in a school's own S3/R2
   bucket are not removed. Exporting a school is not built.
8. Test database holds many throw-away test schools (each test run adds 1–3); clean up or recreate `holysai_test` when it
   gets slow (only with the owner's OK).
9. Earlier items still open: APK build (EAS), app icons, real-phone tests, features without original screens.
10. The GitHub repository is public — consider making it private.

---

## 17. Git and working conventions

- `main` (local, not pushed): the single-school build, popup-focus fix, LAN access, the We School work (`5660399`), the
  rebrand merged from `refs/heads/claude/objective-borg-af50b1` (`5c4f217`, merge `8a08ac5`) and the translations.
- The rebrand worktree `.claude/worktrees/objective-borg-af50b1` can be removed; its branch is fully merged.
- Never commit `apps/api/.env`, `handover.env`, `.data/`, `uploads/`. Commit or push only when the owner asks.
- Rules: no demo data; every write audited; one `.prisma` file per school module; platform models in
  `prisma/platform/schema.prisma`; migrations additive and reviewed; test with the test database (API 4001), never with
  real schools.

---

## 18. Suggested next steps

1. Push `main` (only with the owner's OK); consider making the repository private first.
2. Set prices, billing details and SMTP; connect gateway sandbox keys and try a renewal end to end for each gateway.
3. Decide hosting; deploy; register webhook URLs; create the real schools (Holy Sai already exists as `holysai`).
4. Build the Android APK and test on phones.
