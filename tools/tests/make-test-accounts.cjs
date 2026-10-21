// Creates a test platform admin in the TEST database (via the test API on port 4001) with a generated password and
// writes it to .data/test-accounts.json (git-ignored), for signing in to the test web app (port 5174) in a browser.
// Usage: node tools/tests/make-test-accounts.cjs
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { call, platformToken, root } = require('./helpers.cjs');

(async () => {
  const file = path.join(root, '.data', 'test-accounts.json');
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const P = await platformToken();
  const email = `console.tester.${Date.now().toString(36)}@example.test`;
  const created = await call('POST', '/platform/admins', { fullName: 'Console Tester', email }, P);
  if (!created.data?.temporaryPassword) throw new Error(`Could not create the test admin: ${created.status} ${created.message}`);
  const password = `Tt${crypto.randomBytes(9).toString('base64url')}9a`;
  const login = await fetch('http://localhost:4001/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: email, password: created.data.temporaryPassword, clientType: 'web' }),
  }).then((r) => r.json());
  const changed = await call('POST', '/platform/auth/change-password', { currentPassword: created.data.temporaryPassword, newPassword: password }, login.data.accessToken);
  if (changed.status !== 200) throw new Error(`Could not set the password: ${changed.status} ${changed.message}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...existing, platform: { email, password, note: 'Test platform admin in holysai_test (test web app: http://localhost:5174)' } }, null, 2));
  console.log(`Test platform admin ready (${email}); credentials saved in .data/test-accounts.json`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
