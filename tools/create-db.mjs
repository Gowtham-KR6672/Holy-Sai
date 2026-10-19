// Creates a UTF-8 database on the local development PostgreSQL (started with `npm run db:start`).
// Usage: node tools/create-db.mjs holysai_test        (port from DEV_DB_PORT, default 5433)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9_]{1,62}$/.test(name)) {
  console.error('Usage: node tools/create-db.mjs <database_name>   (lower-case letters, digits, underscore)');
  process.exit(1);
}
const port = Number(process.env.DEV_DB_PORT ?? 5433);
const client = new Client({ connectionString: `postgresql://holysai:holysai_dev@localhost:${port}/postgres` });
await client.connect();
try {
  const exists = await client.query('SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = $1', [name]);
  if (exists.rowCount) {
    console.log(`Database "${name}" already exists (${exists.rows[0].enc}).`);
  } else {
    try {
      await client.query(`CREATE DATABASE "${name}" WITH TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'en-IN' LC_COLLATE 'C' LC_CTYPE 'C'`);
    } catch {
      // PostgreSQL without ICU: byte-order sorting, still UTF-8.
      await client.query(`CREATE DATABASE "${name}" WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    }
    console.log(`Created UTF-8 database "${name}".`);
  }
  console.log(`DATABASE_URL=postgresql://holysai:holysai_dev@localhost:${port}/${name}`);
} finally {
  await client.end();
}
