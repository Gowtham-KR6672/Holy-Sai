// pg connection settings for the tools, from a DATABASE_URL (same rules as pgClientConfig in
// apps/api/src/tenancy/migrator.ts): Prisma-only parameters are removed, and sslmode=require (or prefer / no-verify)
// encrypts the connection without checking the server certificate — what Prisma does with the same URL — because
// hosted databases such as Supabase sign theirs with their own CA. verify-full / verify-ca are left to pg.
export function pgClientConfig(url) {
  const u = new URL(url);
  for (const p of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size']) u.searchParams.delete(p);
  const mode = u.searchParams.get('sslmode');
  if (mode && ['require', 'prefer', 'no-verify'].includes(mode)) {
    u.searchParams.delete('sslmode');
    return { connectionString: u.toString(), ssl: { rejectUnauthorized: false } };
  }
  return { connectionString: u.toString() };
}
