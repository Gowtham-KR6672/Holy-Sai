// One-time conversion of a single-school database (school tables in "public") into We School:
//  - the school's tables move to the schema ws_<code> (a rename: nothing is copied or deleted),
//  - the platform schema is created and the school becomes a workspace,
//  - the account with SEED_ADMIN_EMAIL becomes the We School platform Super Admin (same password),
//    and its old school account becomes the school's hidden "We School Support" account,
//  - every other account gets its sign-in directory entry; uploaded files move to uploads/<code>/.
// Safe to run again (each step checks what is already done). --revert moves the tables back to "public".
//
// Usage: node tools/convert-to-weschool.mjs --code holysai [--name "School name"]
//        node tools/convert-to-weschool.mjs --code holysai --revert
// Reads DATABASE_URL, SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD and UPLOAD_DIR from apps/api/.env (DATABASE_URL may be
// set in the environment instead, e.g. for the test database).
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pgClientConfig } from './pg-config.mjs';

const root = path.resolve(import.meta.dirname, '..');
const api = path.join(root, 'apps', 'api');
const require = createRequire(path.join(api, 'package.json'));
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const code = (arg('code') ?? '').trim().toLowerCase();
const revert = process.argv.includes('--revert');
if (!/^[a-z][a-z0-9]{1,29}$/.test(code)) {
  console.error('Give the school a code: --code <2–30 lower-case letters or digits, starting with a letter>');
  process.exit(1);
}
const schema = `ws_${code}`;
const SUPPORT_EMAIL = `we-school-support@${code}.support.weschool.invalid`;

const fromEnvFile = existsSync(path.join(api, '.env')) ? Object.fromEntries(
  (await import('node:fs')).readFileSync(path.join(api, '.env'), 'utf8').split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^"(.*)"$/, '$1')]),
) : {};
const env = (k) => process.env[k] ?? fromEnvFile[k];
const base = env('DATABASE_URL');
if (!base) throw new Error('DATABASE_URL is not set');
const plain = (() => {
  const u = new URL(base);
  for (const p of ['schema', 'connection_limit', 'pool_timeout']) u.searchParams.delete(p);
  return u.toString();
})();
const platformUrl = (() => {
  const u = new URL(base);
  u.searchParams.set('schema', 'platform');
  return u.toString();
})();

const db = new Client(pgClientConfig(plain));
await db.connect();
// Prisma stores timestamps as UTC wall time; the embedded server's own zone is local.
await db.query("SET TIME ZONE 'UTC'");
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const schemaExists = async (name) => !!(await one('SELECT 1 AS x FROM information_schema.schemata WHERE schema_name = $1', [name]));
const tableExists = async (s, t) => !!(await one('SELECT 1 AS x FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2', [s, t]));
const q = `"${schema}"`;

try {
  if (revert) {
    if (!(await schemaExists(schema))) throw new Error(`Schema ${schema} does not exist — nothing to revert.`);
    const leftovers = await one(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`);
    if (leftovers.n > 0) throw new Error('The "public" schema is not empty — refusing to replace it.');
    await db.query('BEGIN');
    const ws = (await schemaExists('platform')) ? await one('SELECT id FROM platform."Workspace" WHERE code = $1', [code]) : null;
    if (ws) {
      const log = await one(`SELECT metadata FROM platform."PlatformAuditLog" WHERE action = 'convert' AND "workspaceId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [ws.id]);
      const m = log?.metadata;
      if (m?.supportUserId && m.originalEmail) {
        await db.query(`UPDATE ${q}."User" SET email = $1, "fullName" = $2, title = $3, "updatedAt" = now() WHERE id = $4`, [m.originalEmail, m.originalName, m.originalTitle ?? null, m.supportUserId]);
      }
      await db.query('DELETE FROM platform."LoginIdentifier" WHERE "workspaceId" = $1', [ws.id]);
      await db.query('DELETE FROM platform."DeviceToken" WHERE "workspaceId" = $1', [ws.id]);
      await db.query('DELETE FROM platform."Workspace" WHERE id = $1', [ws.id]);
    }
    await db.query('DROP SCHEMA public');
    await db.query(`ALTER SCHEMA ${q} RENAME TO public`);
    await db.query('COMMIT');
    console.log(`Reverted: the school tables are back in "public". The platform schema and platform admin were kept.`);
    process.exit(0);
  }

  // 1. Move the school's tables into their own schema.
  if (await schemaExists(schema)) {
    console.log(`1. Tables already in ${schema}`);
  } else {
    if (!(await tableExists('public', 'User'))) throw new Error('There is no single-school database in "public" to convert.');
    await db.query('BEGIN');
    await db.query(`ALTER SCHEMA public RENAME TO ${q}`);
    await db.query('CREATE SCHEMA public');
    await db.query('COMMIT');
    console.log(`1. Moved the school's tables to ${schema}`);
  }

  // 2. Platform schema.
  execSync('npx prisma migrate deploy --schema prisma/platform/schema.prisma', { cwd: api, stdio: 'inherit', env: { ...process.env, PLATFORM_DATABASE_URL: platformUrl } });
  console.log('2. Platform schema is up to date');

  await db.query('BEGIN');
  // 3. The workspace.
  const setting = async (key) => (await one(`SELECT value FROM ${q}."Setting" WHERE key = $1`, [key]))?.value;
  const name = arg('name')?.trim() || (await setting('school.name')) || code;
  const timezone = (await setting('school.timezone')) || 'Asia/Kolkata';
  const version = (await one(`SELECT migration_name FROM ${q}."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1`))?.migration_name ?? null;
  let ws = await one('SELECT id, "supportUserId" FROM platform."Workspace" WHERE code = $1', [code]);
  if (!ws) {
    ws = await one(
      `INSERT INTO platform."Workspace" (id, code, name, "schemaName", status, currency, country, timezone, "schemaVersion", notes, "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, 'active', 'INR', 'India', $4, $5, 'Converted from the single-school database', now(), now()) RETURNING id, "supportUserId"`,
      [code, name, schema, timezone, version],
    );
    console.log(`3. Created the workspace "${name}" (${code})`);
  } else {
    console.log(`3. Workspace ${code} already exists`);
  }

  // 4. Platform Super Admin.
  const seedEmail = (env('SEED_ADMIN_EMAIL') ?? '').trim().toLowerCase();
  const oldAdmin = seedEmail
    ? await one(`SELECT u.id, u.email, u."fullName", u.title, u.phone, u."passwordHash" FROM ${q}."User" u JOIN ${q}."Role" r ON r.id = u."roleId" WHERE lower(u.email) = $1 AND r.key = 'super_admin'`, [seedEmail])
    : null;
  let admin = await one('SELECT id, email FROM platform."PlatformAdmin" ORDER BY "createdAt" LIMIT 1');
  if (!admin) {
    if (!seedEmail) throw new Error('Set SEED_ADMIN_EMAIL in apps/api/.env');
    let hash = oldAdmin?.passwordHash;
    if (!hash) {
      const pw = env('SEED_ADMIN_PASSWORD');
      if (!pw) throw new Error('Set SEED_ADMIN_PASSWORD in apps/api/.env');
      hash = await bcrypt.hash(pw, 12);
    }
    admin = await one(
      `INSERT INTO platform."PlatformAdmin" (id, email, "fullName", "passwordHash", status, "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, 'active', now(), now()) RETURNING id, email`,
      [seedEmail, oldAdmin?.fullName || 'We School Administrator', hash],
    );
    console.log(`4. Platform Super Admin: ${seedEmail}${oldAdmin ? ' (same password as before)' : ''}`);
  } else {
    console.log(`4. Platform Super Admin already exists (${admin.email})`);
  }
  await db.query(
    `INSERT INTO platform."LoginIdentifier" (id, kind, value, "platformAdminId", "createdAt") VALUES (gen_random_uuid(), 'email', $1, $2, now()) ON CONFLICT (kind, value) DO NOTHING`,
    [admin.email.toLowerCase(), admin.id],
  );

  // 5. The school's hidden support account (the old Super Admin account, renamed; history stays attached to it).
  if (!ws.supportUserId) {
    let supportId;
    if (oldAdmin) {
      await db.query(`UPDATE ${q}."User" SET email = $1, "fullName" = 'We School Support', title = 'We School support', phone = NULL, "mustChangePassword" = false, "updatedAt" = now() WHERE id = $2`, [SUPPORT_EMAIL, oldAdmin.id]);
      await db.query(`UPDATE ${q}."Session" SET "revokedAt" = now() WHERE "userId" = $1 AND "revokedAt" IS NULL`, [oldAdmin.id]);
      supportId = oldAdmin.id;
    } else {
      const existing = await one(`SELECT id FROM ${q}."User" WHERE email = $1`, [SUPPORT_EMAIL]);
      supportId = existing?.id ?? (await one(
        `INSERT INTO ${q}."User" (id, email, "fullName", title, "passwordHash", status, "roleId", "mustChangePassword", "createdAt", "updatedAt")
         SELECT gen_random_uuid(), $1, 'We School Support', 'We School support', $2, 'active', r.id, false, now(), now() FROM ${q}."Role" r WHERE r.key = 'super_admin' RETURNING id`,
        [SUPPORT_EMAIL, await bcrypt.hash(randomBytes(32).toString('base64url'), 10)],
      )).id;
    }
    await db.query('UPDATE platform."Workspace" SET "supportUserId" = $1, "updatedAt" = now() WHERE id = $2', [supportId, ws.id]);
    await db.query(
      `INSERT INTO platform."PlatformAuditLog" (id, "adminName", action, "entityType", "entityId", "workspaceId", description, metadata, "createdAt")
       VALUES (gen_random_uuid(), 'System', 'convert', 'workspace', $1::text, $2::uuid, $3, $4, now())`,
      [ws.id, ws.id, `Converted the single-school database into the workspace ${code}`, JSON.stringify({ supportUserId: supportId, originalEmail: oldAdmin?.email ?? null, originalName: oldAdmin?.fullName ?? null, originalTitle: oldAdmin?.title ?? null })],
    );
    console.log(`5. Support account ready${oldAdmin ? ' (the old Super Admin school account)' : ''}`);
  } else {
    console.log('5. Support account already set');
  }

  // 6. Sign-in directory for everyone else in the school.
  const users = (await db.query(`SELECT id, email, phone FROM ${q}."User" WHERE email NOT LIKE '%.support.weschool.invalid'`)).rows;
  let added = 0;
  const conflicts = [];
  for (const u of users) {
    const entries = [['email', u.email.trim().toLowerCase()]];
    const digits = (u.phone ?? '').replace(/\D/g, '');
    if (digits.length >= 6) entries.push(['phone', digits]);
    for (const [kind, value] of entries) {
      const r = await db.query(
        `INSERT INTO platform."LoginIdentifier" (id, kind, value, "workspaceId", "userId", "createdAt") VALUES (gen_random_uuid(), $1, $2, $3, $4, now()) ON CONFLICT (kind, value) DO NOTHING`,
        [kind, value, ws.id, u.id],
      );
      if (r.rowCount) added++;
      else {
        const holder = await one('SELECT "workspaceId", "userId" FROM platform."LoginIdentifier" WHERE kind = $1 AND value = $2', [kind, value]);
        if (holder.userId !== u.id) conflicts.push(`${kind} ${value}`);
      }
    }
  }
  console.log(`6. Sign-in directory: ${users.length} account(s), ${added} new entr${added === 1 ? 'y' : 'ies'}`);
  if (conflicts.length) console.log(`   These already sign in elsewhere and were skipped: ${conflicts.join(', ')}`);
  await db.query('COMMIT');

  // 7. Uploaded files move to the school's own folder.
  const uploads = path.resolve(api, env('UPLOAD_DIR') ?? './uploads');
  if (existsSync(uploads)) {
    const target = path.join(uploads, code);
    const known = new Set((await db.query('SELECT code FROM platform."Workspace"')).rows.map((r) => r.code));
    const items = readdirSync(uploads).filter((n) => !known.has(n));
    if (items.length) {
      mkdirSync(target, { recursive: true });
      for (const n of items) renameSync(path.join(uploads, n), path.join(target, n));
    }
    console.log(`7. Uploads: ${items.length ? `moved ${items.length} item(s) to ${target}` : 'nothing to move'}`);
  } else {
    console.log('7. Uploads: no upload folder yet');
  }
  console.log(`\nDone. Sign in with ${admin.email} to reach the We School console; the school's own admins sign in as before.`);
} catch (err) {
  await db.query('ROLLBACK').catch(() => undefined);
  console.error(`\nConversion stopped: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
