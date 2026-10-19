# Holy Sai Smart School 360

The connected digital campus for Holy Sai International School — web application, REST API and iOS/Android app.

| Part | Folder | Stack |
| --- | --- | --- |
| Web app | `apps/web` | React 19 + Vite + TypeScript. **The original front-end, recovered exactly from the live site's source maps** (see `reference/`). |
| API | `apps/api` | NestJS 11 + Prisma 6 + PostgreSQL — 20 feature modules, ~600 endpoints |
| Mobile app | `apps/mobile` | Expo (React Native) for iOS and Android — one app, role-based after sign-in (see `apps/mobile/README.md`) |
| Shared | `packages/shared` | Permissions, roles, navigation, icons and translations used by the API and the mobile app |

## Run locally

Requirements: Node.js 22 or newer.

```bash
npm install               # approve install scripts if npm 11 asks: npm install-scripts approve
npm run build:shared      # builds packages/shared (the API imports its compiled output)
npm run db:start          # local PostgreSQL on port 5433 (keeps running; data in .data/pg)
```

In a second terminal:

```bash
cp apps/api/.env.example apps/api/.env   # then set secrets (JWT_ACCESS_SECRET, APP_ENCRYPTION_KEY, SEED_ADMIN_*)
npm run db:migrate        # create the tables
npm run db:seed           # roles, permissions, settings and the first Super Admin (no demo data)
npm run dev:api           # http://localhost:4000/api
```

In a third terminal:

```bash
npm run dev:web           # http://localhost:5173 (proxies /api to the API)
```

Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `apps/api/.env` (to change that login later, edit those
two values and run `node tools/reset-admin.mjs`).

The database must be **UTF-8** (Tamil and Hindi names, the ₹ sign). `npm run db:start` creates UTF-8 databases and warns
if an existing one is not. Managed PostgreSQL in production is UTF-8 by default.

## First-time setup in the app (no demo data — the school starts empty)

1. **Users & Settings → School Setup** — campuses (with map coordinates for GPS tracking), the academic year, classes
   and sections, subjects, houses.
2. **Workforce → Employee Directory** — staff records. **Students → Add New Student** (or enrol from Admissions).
3. **Users & Settings → Users & Roles** — create sign-in accounts. Each login is **linked to its record**: a student
   login to the student, a parent login to the parent (they then see all their children), staff logins to their
   employee record (matched by email). Linked logins are what the mobile app uses.
4. **AI Providers** — connect Claude, Gemini, OpenAI, Groq or OpenRouter and choose which features each one serves
   (Co-Pilot, Knowledge AI, Paper Correction, WhatsApp AI…). Everything works without AI; AI adds drafting and marking.
5. **Integrations** — WhatsApp (Meta Cloud API, incl. the **App secret**), SMS (MSG91 / Twilio), email (SMTP),
   payments (Razorpay), push (Expo), GPS (Traccar or device tokens), smart-gate readers, biometric attendance, maps,
   file storage (local disk, Amazon S3 or Cloudflare R2). Each has a **Test** button. Webhook URLs to register with
   the providers are shown on that page (`/api/whatsapp/webhook`, `/api/finance/webhooks/razorpay`,
   `/api/gate/webhooks/scan`, `/api/workforce/webhooks/biometric`, `/api/tracking/ingest`). They must be reachable over
   public HTTPS once hosted.
6. **Paper Correction → AI settings** — tick the acknowledgement that answer scripts are sent to the AI provider;
   reading and marking stay off until then (uploads still work).

## School policies built in

- Student records are kept for school records. **Student 360 → Mark as left** (discontinued / transferred /
  graduated) keeps the record, disables the student's login, and disables a parent's login when none of their
  children is still enrolled. **Re-enrol** restores them. Logins of students who left cannot be re-activated directly.
- Paper Correction: the AI gives **full marks when the concept is correct**, partial marks in proportion otherwise,
  and the teacher reviews, corrects and approves every answer before marks are pushed to Academics.

## Languages

English, Tamil and Hindi. Switch from the sign-in screen or the profile menu. Every page is translated at display time
from `apps/web/src/i18n/dict/<lang>.json` (see `apps/web/src/i18n/domTranslator.ts`); dates follow the language.
After changing page text run `node tools/i18n-extract.mjs`, `node tools/i18n-merge.mjs split`, translate the chunks
into `dict/parts/<lang>-N.json`, then `node tools/i18n-merge.mjs merge`. In development, `window.__i18nMissing` in the
browser console lists on-screen text that has no translation yet.

## Testing

- `node tools/smoke-api.mjs` — signs in as the Super Admin and calls every page's GET endpoint.
- `tools/tests/` — end-to-end checks against the test API on port 4001 (account linking, student leave/re-enrol with
  Tamil and Hindi data) and the S3 request-signing check (`npx tsx tools/tests/s3-sign.test.ts`).
- A separate **test database** (`holysai_test`) keeps test records out of the school's data: run a second API with
  `PORT=4001 DATABASE_URL=postgresql://holysai:holysai_dev@localhost:5433/holysai_test node apps/api/dist/main.js`
  (after `npm run build -w @holysai/api`; apply migrations to it with `DATABASE_URL=… npx prisma migrate deploy`).

## Project notes

- `HANDOVER.md` — full handover: requirements, decisions, status, open items, how to continue on a new computer.

- `docs/backend-conventions.md` — how API modules are built (envelope, errors, scope, audit, Prisma rules).
- `docs/api-inventory.txt` — every API call the web app makes.
- `reference/` — the original build (compiled assets, recovered sources, original translations) kept for reference only;
  it is never executed or deployed.
