import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/** The school migrations (prisma/schema/migrations), applied to every school's schema. */
export const SCHOOL_MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/schema/migrations');
const SCHEMA_NAME = /^ws_[a-z0-9_]{2,40}$/;

/** Prisma's own bookkeeping table, so `prisma migrate status` works against a school schema too. */
const PRISMA_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id"                  VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum"            VARCHAR(64) NOT NULL,
  "finished_at"         TIMESTAMPTZ,
  "migration_name"      VARCHAR(255) NOT NULL,
  "logs"                TEXT,
  "rolled_back_at"      TIMESTAMPTZ,
  "started_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

export interface SchoolMigration {
  name: string;
  sql: string;
  checksum: string;
}

/** The school migrations in order. */
export function schoolMigrations(dir = SCHOOL_MIGRATIONS_DIR): SchoolMigration[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, 'migration.sql')))
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const bytes = readFileSync(path.join(dir, name, 'migration.sql'));
      return { name, sql: bytes.toString('utf8'), checksum: createHash('sha256').update(bytes).digest('hex') };
    });
}

/** The newest school migration (the version every school schema should be at). */
export function latestSchoolMigration(): string | null {
  return schoolMigrations().at(-1)?.name ?? null;
}

/** A plain PostgreSQL connection string from DATABASE_URL (Prisma-only parameters removed). */
export function pgConnectionString(url = process.env.DATABASE_URL): string {
  if (!url) throw new Error('DATABASE_URL is not set');
  const u = new URL(url);
  for (const p of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size']) u.searchParams.delete(p);
  return u.toString();
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Brings a school schema up to date: creates it if needed and applies each missing migration in its own
 * transaction (DDL is transactional in PostgreSQL, so a schema is never left half-migrated). Concurrent runs for
 * the same schema wait for each other. Returns the migrations applied and the schema's version afterwards.
 */
export async function migrateSchoolSchema(schema: string, log: (msg: string) => void = () => undefined): Promise<{ applied: string[]; version: string | null }> {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`Invalid school schema name "${schema}"`);
  const client = new Client({ connectionString: pgConnectionString() });
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`migrate:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`);
    await client.query(`SET search_path TO ${ident(schema)}`);
    await client.query(PRISMA_MIGRATIONS_TABLE);
    const done = new Set(
      (await client.query<{ migration_name: string }>('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows.map((r) => r.migration_name),
    );
    for (const m of schoolMigrations()) {
      if (done.has(m.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL search_path TO ${ident(schema)}`);
        await client.query(m.sql);
        await client.query(
          'INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count, started_at) VALUES ($1, $2, now(), $3, 1, now())',
          [randomUUID(), m.checksum, m.name],
        );
        await client.query('COMMIT');
        applied.push(m.name);
        log(`${schema}: applied ${m.name}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`${schema}: migration ${m.name} failed — ${(err as Error).message}`);
      }
    }
    const last = await client.query<{ migration_name: string }>(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1',
    );
    return { applied, version: last.rows[0]?.migration_name ?? null };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`migrate:${schema}`]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
