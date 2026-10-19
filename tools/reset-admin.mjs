// Applies SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD from apps/api/.env to the existing Super Admin account
// (the account with that email, otherwise the oldest Super Admin). Unlocks it and signs out its sessions.
// The seed only creates the first Super Admin, so use this to change that login later.
// Usage: node tools/reset-admin.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const env = readFileSync('apps/api/.env', 'utf8');
const get = (k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim().replace(/^"(.*)"$/, '$1');
const email = (get('SEED_ADMIN_EMAIL') ?? '').toLowerCase();
const password = get('SEED_ADMIN_PASSWORD') ?? '';
if (!email || !password) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in apps/api/.env');
if (password.length < 10 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
  throw new Error('The password needs at least 10 characters with upper case, lower case and a digit.');
}

const db = new Client({ connectionString: get('DATABASE_URL').replace(/\?.*$/, '') });
await db.connect();
try {
  const { rows } = await db.query(
    `SELECT u.id, u.email FROM "User" u JOIN "Role" r ON r.id = u."roleId"
      WHERE r.key = 'super_admin' ORDER BY (lower(u.email) = $1) DESC, u."createdAt" ASC LIMIT 1`,
    [email],
  );
  if (!rows.length) throw new Error('No Super Admin yet — run npm run db:seed to create it from .env.');
  const user = rows[0];
  const clash = await db.query(`SELECT 1 FROM "User" WHERE lower(email) = $1 AND id <> $2`, [email, user.id]);
  if (clash.rowCount) throw new Error(`${email} already belongs to another user.`);

  await db.query('BEGIN');
  await db.query(
    `UPDATE "User" SET email = $1, "passwordHash" = $2, status = 'active', "failedLogins" = 0, "lockedUntil" = NULL,
       "mustChangePassword" = false, "updatedAt" = now() WHERE id = $3`,
    [email, await bcrypt.hash(password, 12), user.id],
  );
  await db.query(`UPDATE "Session" SET "revokedAt" = now() WHERE "userId" = $1 AND "revokedAt" IS NULL`, [user.id]);
  await db.query(
    `INSERT INTO "AuditLog" ("userId", "userName", role, action, module, "entityType", "entityId", description, sensitive)
     VALUES ($1::uuid, 'System', 'super_admin', 'update', 'users', 'User', $1::text, $2, true)`,
    [user.id, `Super Admin sign-in changed from ${user.email} to ${email} (tools/reset-admin.mjs)`],
  );
  await db.query('COMMIT');
  console.log(`Super Admin sign-in is now ${email} (was ${user.email}). Existing sessions were signed out.`);
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await db.end();
}
