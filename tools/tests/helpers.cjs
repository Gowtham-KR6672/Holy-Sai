// Shared helpers for the end-to-end tests. Everything runs against the TEST API (port 4001, database holysai_test);
// each test creates its own throw-away school through the We School console API.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const TEST_DB = 'postgresql://holysai:holysai_dev@localhost:5433/holysai_test';
const base = process.env.TEST_API ?? 'http://localhost:4001/api';
const envFile = fs.readFileSync(path.join(root, 'apps/api/.env'), 'utf8');
const getEnv = (k) => envFile.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();

/** fetch wrapper: returns { status, ...envelope, cookie } (mobile client, so refresh tokens come back in the body). */
async function call(method, p, body, token, extraHeaders = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-client-type': 'mobile', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, ...json, cookie: r.headers.get('set-cookie') };
}

let failures = 0;
function check(name, cond, extra = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const failed = () => failures;

/** Signs in as the platform Super Admin (web client: platform admins cannot use the mobile app). */
async function platformToken() {
  const r = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: getEnv('SEED_ADMIN_EMAIL'), password: getEnv('SEED_ADMIN_PASSWORD'), clientType: 'web' }),
  });
  const j = await r.json();
  if (j?.data?.kind !== 'platform') throw new Error(`Platform sign-in failed: ${r.status} ${j?.message}`);
  return j.data.accessToken;
}

/** A Prisma client for one school's schema in the test database. */
function schoolDb(schema) {
  const { PrismaClient } = require(path.join(root, 'node_modules/@prisma/client'));
  const url = new URL(TEST_DB);
  url.searchParams.set('schema', schema);
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

/**
 * Creates a fresh test school and signs in as its Workspace Admin (changing the temporary password first).
 * Returns { code, id, schema, token, adminEmail, password, db, platform }.
 */
async function newSchool(label = 'Test', currency = 'INR') {
  const platform = await platformToken();
  const tag = (Date.now().toString(36) + Math.random().toString(36).slice(2, 5)).slice(-9);
  const code = `t${tag}`;
  const adminEmail = `admin.${code}@example.test`;
  const created = await call('POST', '/platform/workspaces', { name: `${label} School ${tag}`, code, currency, admin: { fullName: `${label} Admin`, email: adminEmail } }, platform);
  if (!created.data?.admin?.temporaryPassword) throw new Error(`Creating school failed: ${created.status} ${created.message} ${JSON.stringify(created.details ?? '')}`);
  const temp = created.data.admin.temporaryPassword;
  const first = await call('POST', '/auth/login', { identifier: adminEmail, password: temp, clientType: 'mobile' });
  const password = `Aa1${tag}Zz9xQ`;
  await call('POST', '/auth/change-password', { currentPassword: temp, newPassword: password }, first.data.accessToken);
  const again = await call('POST', '/auth/login', { identifier: adminEmail, password, clientType: 'mobile' });
  if (!again.data?.accessToken) throw new Error(`School admin sign-in failed: ${again.status} ${again.message}`);
  return {
    code, id: created.data.workspace.id, schema: `ws_${code}`, token: again.data.accessToken, refreshToken: again.data.refreshToken,
    adminEmail, password, temporaryPassword: temp, firstLogin: first, db: schoolDb(`ws_${code}`), platform,
  };
}

module.exports = { base, call, check, failed, getEnv, newSchool, platformToken, schoolDb, root, TEST_DB };
