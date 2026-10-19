# Backend conventions (NestJS API)

The web app in `apps/web` is the **original Holy Sai front-end, recovered from the live site's source maps**. It is the
specification: every API call it makes must be answered with exactly the shape the page code reads. Do not change
page code to fit the API — change the API to fit the page. (The only web files you may add are the missing type-only
modules, e.g. `apps/web/src/pages/<module>/types.ts`, reconstructed from how the pages use them.)

`docs/api-inventory.txt` lists every call the front-end makes (method, path, file). Some calls use dynamic paths and are
not in the inventory — always read the page files themselves.

## Layout

```
apps/api/
  prisma/schema/            one .prisma file per module (schema.prisma = generator + datasource)
    foundation.prisma       users, roles, sessions, audit, settings, notifications, tasks, AI, integrations   (core — do not edit)
    core.prisma             campuses, classes, sections, subjects, houses, students, guardians, employees, routes (core — do not edit)
    <module>.prisma         your module's tables
  src/
    common/                 shared plumbing (envelope, errors, paging, scope, auth, prisma)   (do not edit)
    modules/<module>/       your module: <module>.module.ts + controllers + services
    modules/index.ts        FEATURE_MODULES registry (already lists every module — do not edit)
```

## Response envelope

Every JSON response is wrapped by `EnvelopeInterceptor`:

- `{ success: true, data, message, meta? }` — return a plain value (message "OK"), or use the helpers in
  `common/envelope.ts`:
  - `ok(data, 'Student created')` — the web app shows `message` as the success toast for mutations that don't pass
    their own success text, so give write endpoints a short human message.
  - `paged(rows, total, { page, pageSize })` — list endpoints read through `usePagedQuery`/`api.getPaged` MUST use this
    (`data` = the rows array, `meta` = `{ page, pageSize, total, totalPages }`).
- Errors (`common/errors.ts`): throw `notFound('Student')`, `forbidden()`, `badRequest(msg)`, `fieldError('email', msg)`
  (shown under that form field), `conflict(msg)`, `unavailable(msg)`, or `new AppError(status, CODE, msg, details)`.
  class-validator DTO failures become `{ error: 'VALIDATION_ERROR', details: [{ field, message }] }` automatically.

## Controllers

- The global prefix is `/api`; controller paths are what the front-end calls after `/api` (e.g. `@Controller('finance')`).
- Everything requires sign-in. `@Public()` opts out (rare). `@RequirePermissions('finance.read', 'finance.manage')` = any of.
  Match the permission the page's route uses (see `apps/web/src/pages/<module>/routes.tsx` and `layouts/nav.ts`), and
  use the `.manage`/`.approve` permission for writes.
- `@CurrentUser() user: AuthUser` gives `id, fullName, roleKey, roleName, scope, campusId, studentId, parentId,
  employeeId, permissions (Set)`.
- Validate bodies with class-validator DTO classes (`whitelist` strips unknown fields). Query DTOs can extend
  `ListQuery` (`q, page, pageSize, sort, dir, campusId`). Use `pageOf(q)` for skip/take, `like(q)` for search.
- Dates: the web sends and expects `YYYY-MM-DD` for dates and ISO strings for timestamps. Money: plain numbers (rupees).
  Prisma `Decimal` must be converted with `Number(x)` before returning.
- Field names: return exactly what the page reads (camelCase or snake_case — whatever the page uses). Status/label
  values must match the page's comparisons and badge maps (often Title Case like `'Under Review'`, or lower-case).

## Data scope (server-side, always)

`ScopeService` (inject it):
- `scope.campus(user, q.campusId)` → campus id to filter by, or `undefined` = all campuses (group view). The header
  sends `campusId` on most lists; group view sends none.
- `scope.studentWhere(user, campusId)` → Prisma `StudentWhereInput` for what the user may see (school / class teacher's
  sections / parent's children / own record). `scope.assertStudent(user, id)` throws if outside scope.
- `scope.teacherSectionIds(user)`, `scope.familyStudentIds(user)`.
- Teachers (`class` scope) see their sections; parents (`family`) their own children; `self` their own records.

## Audit, notifications, tasks, AI, messaging (all injectable)

- `AuditService.record({ user, action: 'create'|'update'|'delete'|'approve'|'reject'|'view'|'export'|'publish'|'ask', module: '<module>', entityType, entityId, description, req })`
  — every write, every approval, every export, and **reads of sensitive records** (wellbeing, counselling, medical,
  safeguarding, payslips, student location: pass `sensitive: true`).
- `NotificationsService.notifyUsers(ids, { category: 'Critical'|'Attention'|'Information'|'Completed', topic, module, title, body, route, deliver })`,
  `notifyPermission(perm, …)`, `notifyGuardians(studentId, …)`; `createTask({...})`, `createTaskForPermission(perm, {...})`,
  `completeTasksFor(entityType, entityId)`. Approval items (leave, expenses, concessions…) should create
  `status: 'Under Review'` tasks for approvers with a `route` to the record, and complete them on decision.
- `AiService.complete(purpose, { system, messages, maxTokens }, { vision })` / `completeJson<T>(…)` — never call AI
  vendors directly. Purposes: `copilot | knowledge | paper_correction | whatsapp | report_comments | talent | analytics`.
  If no provider is connected it throws a clear 503; pages should still work without AI.
- `MessagingService.send('whatsapp'|'sms'|'email'|'push', { to, subject?, body }, { entityType, entityId })`.
- `CountersService.next(key)` for human references, e.g. `RCT-2026-008454`, `LV-882`, `EXP-2211`.
- `SettingsService.get(key, fallback)` for configurable thresholds.
- `SearchService.register(fn)` (in `onModuleInit`) to add your records to the global Ctrl K search.

## Prisma rules

- Your tables go in `apps/api/prisma/schema/<module>.prisma`. Do **not** edit `foundation.prisma`, `core.prisma` or
  other modules' files.
- Reference core records (Student, Employee, Section, Campus, Subject, User, TransportRoute…) and other modules' records
  with plain `String @db.Uuid` columns plus `@@index`, **without** a Prisma `@relation` (relations need a back-field in
  the other file). Relations between tables inside your own file are fine. Join in code (`findMany({ where: { id: { in } } })`).
- You may read and write core tables through Prisma (e.g. Admissions enrolment creates a `Student`).
- Use `String` for statuses (store the exact values the page expects), `Decimal @db.Decimal(12,2)` for money,
  `DateTime @db.Date` for dates, `Json` for flexible payloads. Prefix model names with your module when generic
  (e.g. `FinanceBudget`, not `Budget`) to avoid clashes.
- **No demo data.** The school starts empty. Only seed reference catalogs that the UI cannot create and the original
  needed to work (e.g. leave types, fee heads, report catalog) — idempotently, from `onModuleInit` or a
  `seedDefaults()` that only inserts when the table is empty. Never seed students, staff, transactions or sample records.
- Validate your schema before saving it into the shared folder (other agents generate from the same folder):
  copy `schema.prisma`, `foundation.prisma`, `core.prisma` and your file into a temp folder and run
  `npx prisma validate --schema <tempdir>` from `apps/api`.
- Generate the client only through the lock script (concurrent generation corrupts the client on Windows):
  `node tools/prisma-generate.mjs` (from the repo root). Never run `prisma migrate`, `db push` or `migrate reset` —
  the integrator applies migrations between batches.

## Checking your work

- Typecheck: `npx tsc -p apps/api/tsconfig.json --noEmit` and look only at errors in your own files (other modules are
  being written at the same time). Your files must have zero errors.
- Web types: `npx tsc -p apps/web/tsconfig.json --noEmit` and fix errors in your module's pages that come from missing
  types (create the `types.ts` the pages import). Do not edit page logic.
- Business logic matters as much as shapes: approvals change statuses and record the decider; totals, percentages and
  ageing are computed from real rows; empty data must return zeros / empty arrays, never errors.
