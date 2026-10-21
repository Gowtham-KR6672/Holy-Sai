// API smoke test: signs in as the platform Super Admin (credentials from apps/api/.env, never printed), opens a school
// through support access, and calls every GET endpoint the web app uses (docs/api-inventory.txt) that has no path
// parameters, inside that school. Reports status codes and failures.
// Usage: node tools/smoke-api.mjs [baseUrl] [schoolCode]   (default http://localhost:4000/api, the first school)
import { readFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:4000/api';
const env = readFileSync('apps/api/.env', 'utf8');
const get = (k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();

const login = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: get('SEED_ADMIN_EMAIL'), password: get('SEED_ADMIN_PASSWORD'), clientType: 'web' }),
});
const lj = await login.json();
if (!lj.success || lj.data?.kind !== 'platform') {
  console.error('Platform sign-in failed:', lj.message);
  process.exit(1);
}
const auth = { authorization: `Bearer ${lj.data.accessToken}`, 'content-type': 'application/json' };
const schools = (await (await fetch(`${base}/platform/workspaces`, { headers: auth })).json()).data ?? [];
const school = schools.find((s) => s.code === process.argv[3]) ?? schools.filter((s) => s.status === 'active').at(-1);
if (!school) {
  console.error('No school to check — create one in the console first.');
  process.exit(1);
}
const code = (await (await fetch(`${base}/platform/workspaces/${school.id}/support`, { method: 'POST', headers: auth })).json()).data?.code;
const support = await (await fetch(`${base}/platform/support/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })).json();
if (!support.data?.accessToken) {
  console.error('Support access failed:', support.message);
  process.exit(1);
}
console.log(`Checking ${school.name} (${school.code}) through support access\n`);
const token = support.data.accessToken;

const lines = readFileSync('docs/api-inventory.txt', 'utf8').split(/\r?\n/).filter(Boolean);
const paths = new Set();
for (const line of lines) {
  const [method, path] = line.trim().split(/\s+/);
  if (!/^(GET|get|getPaged|GET\(paged\))$/.test(method)) continue;
  for (const p of path.split('|').map((s) => s.trim())) {
    if (!p.startsWith('/') || p.includes(':p') || p.includes('<') || p.includes('${')) continue;
    paths.add(p.replace(/\?.*$/, ''));
  }
}

const results = [];
for (const p of [...paths].sort()) {
  const t0 = Date.now();
  let status = 0;
  let note = '';
  try {
    const res = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${token}`, 'x-client-type': 'web' } });
    status = res.status;
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      if (!j.success) note = `${j.error}: ${j.message}`;
      else if (Array.isArray(j.data)) note = `${j.data.length} rows${j.meta ? ` (total ${j.meta.total})` : ''}`;
      else note = j.data && typeof j.data === 'object' ? `keys: ${Object.keys(j.data).slice(0, 6).join(',')}` : String(j.data).slice(0, 40);
    } catch {
      note = text.slice(0, 80);
    }
  } catch (e) {
    note = e.message;
  }
  results.push({ p, status, ms: Date.now() - t0, note });
}

const bad = results.filter((r) => r.status >= 400 || r.status === 0);
for (const r of results) console.log(`${String(r.status).padEnd(4)} ${String(r.ms).padStart(5)}ms  ${r.p.padEnd(48)} ${r.note}`);
console.log(`\n${results.length} endpoints · ${results.length - bad.length} OK · ${bad.length} failing`);
for (const code of [404, 500, 403, 400]) {
  const n = bad.filter((r) => r.status === code).length;
  if (n) console.log(`  ${code}: ${n}`);
}
