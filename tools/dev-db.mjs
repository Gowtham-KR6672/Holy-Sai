// Local PostgreSQL for development, without a system install.
// Data lives in .data/pg; stop with Ctrl+C. Production uses a managed PostgreSQL via DATABASE_URL.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import path from 'node:path';

const databaseDir = path.resolve('.data/pg');
const port = Number(process.env.DEV_DB_PORT ?? 5433);
const database = process.env.DEV_DB_NAME ?? 'holysai_app';

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'holysai',
  password: 'holysai_dev',
  port,
  persistent: true,
  // UTF-8 so Tamil / Hindi text and the ₹ sign can be stored (Windows would otherwise default to WIN1252).
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

/** Creates a UTF-8 database with Indian-English sorting (ICU), whatever the cluster default is. */
async function createUtf8Database(client, name) {
  const ident = '"' + name.replace(/"/g, '""') + '"';
  try {
    await client.query(`CREATE DATABASE ${ident} WITH TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'en-IN' LC_COLLATE 'C' LC_CTYPE 'C'`);
  } catch (err) {
    if (/already exists/.test(err.message)) throw err;
    // PostgreSQL built without ICU: byte-order sorting, still UTF-8.
    await client.query(`CREATE DATABASE ${ident} WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  }
}

const firstRun = !existsSync(path.join(databaseDir, 'PG_VERSION'));
if (firstRun) {
  console.log('Initialising a new local database in', databaseDir);
  await pg.initialise();
}
await pg.start();

const client = pg.getPgClient();
await client.connect();
const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
if (exists.rowCount === 0) {
  await createUtf8Database(client, database);
  console.log(`Created database "${database}" (UTF-8)`);
} else {
  const enc = await client.query('SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = $1', [database]);
  if (enc.rows[0].enc !== 'UTF8') console.warn(`WARNING: database "${database}" is ${enc.rows[0].enc}, not UTF-8 — Tamil/Hindi text cannot be stored.`);
}
await client.end();

console.log(`PostgreSQL ready on port ${port} — database "${database}"`);
console.log(`DATABASE_URL=postgresql://holysai:holysai_dev@localhost:${port}/${database}`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
