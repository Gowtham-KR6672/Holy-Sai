// Applies SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD from apps/api/.env to the We School platform Super Admin
// (the platform admin with that email, otherwise the oldest one). Unlocks it, signs out its sessions and updates its
// sign-in directory entry. The seed only creates the first platform admin, so use this to change that login later.
// Usage: node tools/reset-admin.mjs   (DATABASE_URL in the environment overrides apps/api/.env, e.g. for the test database)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const api = path.resolve(import.meta.dirname, '..', 'apps', 'api');
const require = createRequire(path.join(api, 'package.json'));
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const env = readFileSync(path.join(api, '.env'), 'utf8');
const get = (k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim().replace(/^"(.*)"$/, '$1');
const email = (get('SEED_ADMIN_EMAIL') ?? '').toLowerCase();
const password = get('SEED_ADMIN_PASSWORD') ?? '';
if (!email || !password) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in apps/api/.env');
if (password.length < 10 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
  throw new Error('The password needs at least 10 characters with upper case, lower case and a digit.');
}

const url = new URL(process.env.DATABASE_URL ?? get('DATABASE_URL'));
for (const p of ['schema', 'connection_limit', 'pool_timeout']) url.searchParams.delete(p);
const db = new Client({ connectionString: url.toString() });
await db.connect();
// Prisma stores timestamps as UTC wall time; the embedded server's own zone is local.
await db.query("SET TIME ZONE 'UTC'");
try {
  const { rows } = await db.query(`SELECT id, email FROM platform."PlatformAdmin" ORDER BY (lower(email) = $1) DESC, "createdAt" ASC LIMIT 1`, [email]);
  if (!rows.length) throw new Error('No platform Super Admin yet — run npm run db:seed to create it from .env.');
  const admin = rows[0];
  const clash = await db.query(`SELECT 1 FROM platform."LoginIdentifier" WHERE kind = 'email' AND value = $1 AND ("platformAdminId" IS NULL OR "platformAdminId" <> $2)`, [email, admin.id]);
  if (clash.rowCount) throw new Error(`${email} already signs in to a school or another platform admin.`);

  await db.query('BEGIN');
  await db.query(
    `UPDATE platform."PlatformAdmin" SET email = $1, "passwordHash" = $2, status = 'active', "failedLogins" = 0, "lockedUntil" = NULL,
       "mustChangePassword" = false, "updatedAt" = now() WHERE id = $3`,
    [email, await bcrypt.hash(password, 12), admin.id],
  );
  await db.query(`UPDATE platform."PlatformSession" SET "revokedAt" = now() WHERE "adminId" = $1 AND "revokedAt" IS NULL`, [admin.id]);
  await db.query(`DELETE FROM platform."LoginIdentifier" WHERE "platformAdminId" = $1 AND kind = 'email'`, [admin.id]);
  await db.query(`INSERT INTO platform."LoginIdentifier" (id, kind, value, "platformAdminId", "createdAt") VALUES (gen_random_uuid(), 'email', $1, $2, now())`, [email, admin.id]);
  await db.query(
    `INSERT INTO platform."PlatformAuditLog" (id, "adminName", action, "entityType", "entityId", description, "createdAt")
     VALUES (gen_random_uuid(), 'System', 'update', 'platform_admin', $1, $2, now())`,
    [admin.id, `Platform Super Admin sign-in changed from ${admin.email} to ${email} (tools/reset-admin.mjs)`],
  );
  await db.query('COMMIT');
  console.log(`Platform Super Admin sign-in is now ${email} (was ${admin.email}). Existing sessions were signed out.`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await db.end();
}
