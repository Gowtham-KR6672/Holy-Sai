// Brings the whole We School database up to date:
//  1. the platform schema (`prisma migrate deploy` for apps/api/prisma/platform),
//  2. every school's schema ws_<code> (the school migrations in apps/api/prisma/schema/migrations).
// Usage: node tools/migrate-all.mjs        (reads DATABASE_URL from apps/api/.env unless already set)
import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const api = path.join(root, 'apps', 'api');
const require = createRequire(path.join(api, 'package.json'));
const { Client } = require('pg');

if (!process.env.DATABASE_URL && existsSync(path.join(api, '.env'))) process.loadEnvFile(path.join(api, '.env'));
const base = process.env.DATABASE_URL;
if (!base) {
  console.error('DATABASE_URL is not set (apps/api/.env)');
  process.exit(1);
}

const withSchema = (schema) => {
  const u = new URL(base);
  u.searchParams.set('schema', schema);
  return u.toString();
};
const plain = () => {
  const u = new URL(base);
  for (const p of ['schema', 'connection_limit', 'pool_timeout']) u.searchParams.delete(p);
  return u.toString();
};

// 1. Platform schema.
console.log('Platform schema:');
execSync('npx prisma migrate deploy --schema prisma/platform/schema.prisma', {
  cwd: api,
  stdio: 'inherit',
  env: { ...process.env, PLATFORM_DATABASE_URL: withSchema('platform') },
});

// 2. School schemas (same steps as apps/api/src/tenancy/migrator.ts).
const dir = path.join(api, 'prisma', 'schema', 'migrations');
const migrations = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, 'migration.sql')))
  .map((d) => d.name)
  .sort()
  .map((name) => {
    const bytes = readFileSync(path.join(dir, name, 'migration.sql'));
    return { name, sql: bytes.toString('utf8'), checksum: createHash('sha256').update(bytes).digest('hex') };
  });

const db = new Client({ connectionString: plain() });
await db.connect();
// Prisma stores timestamps as UTC wall time; the embedded server's own zone is local.
await db.query("SET TIME ZONE 'UTC'");
const schools = (await db.query(`SELECT id, code, name, "schemaName" FROM platform."Workspace" WHERE status IN ('active', 'suspended', 'provisioning') ORDER BY "createdAt"`)).rows;
let failed = 0;
for (const ws of schools) {
  if (!/^ws_[a-z0-9_]{2,40}$/.test(ws.schemaName)) {
    console.error(`  ${ws.code}: invalid schema name ${ws.schemaName}`);
    failed++;
    continue;
  }
  const q = `"${ws.schemaName}"`;
  try {
    await db.query('SELECT pg_advisory_lock(hashtext($1))', [`migrate:${ws.schemaName}`]);
    await db.query(`CREATE SCHEMA IF NOT EXISTS ${q}`);
    await db.query(`SET search_path TO ${q}`);
    await db.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" ("id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ, "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`);
    const done = new Set((await db.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows.map((r) => r.migration_name));
    const todo = migrations.filter((m) => !done.has(m.name));
    for (const m of todo) {
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL search_path TO ${q}`);
        await db.query(m.sql);
        await db.query('INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count, started_at) VALUES ($1, $2, now(), $3, 1, now())', [randomUUID(), m.checksum, m.name]);
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw new Error(`${m.name}: ${err.message}`);
      }
    }
    const version = migrations.at(-1)?.name ?? null;
    await db.query('SET search_path TO public');
    await db.query('UPDATE platform."Workspace" SET "schemaVersion" = $1 WHERE id = $2', [version, ws.id]);
    console.log(`  ${ws.name} (${ws.code}): ${todo.length ? `applied ${todo.map((m) => m.name).join(', ')}` : 'up to date'}`);
  } catch (err) {
    failed++;
    console.error(`  ${ws.name} (${ws.code}) FAILED: ${err.message}`);
  } finally {
    await db.query('SELECT pg_advisory_unlock(hashtext($1))', [`migrate:${ws.schemaName}`]).catch(() => undefined);
  }
}
if (!schools.length) console.log('  no schools yet');
await db.end();
process.exit(failed ? 1 : 0);
