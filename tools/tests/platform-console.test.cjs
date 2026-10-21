// We School console test: school details and edits, support access (with audit in both trails), suspend / resume,
// extra Workspace Admins, admin password resets and platform admins. Runs ONLY against the test API (port 4001).
// Usage (repo root, test API running: node tools/test-api.mjs): node tools/tests/platform-console.test.cjs
const { base, call, check, failed, newSchool } = require('./helpers.cjs');

(async () => {
  const A = await newSchool('Console');
  const P = A.platform;

  // Details and edits.
  const detail = await call('GET', `/platform/workspaces/${A.code}`, undefined, P);
  check('school details include usage and its admin', detail.data?.usage && detail.data?.admins?.some((a) => a.email === A.adminEmail), `${detail.status}`);
  check('the support account is not listed as an admin', !detail.data?.admins?.some((a) => /support/.test(a.email)));
  const renamed = await call('PATCH', `/platform/workspaces/${A.id}`, { name: `Renamed ${A.code}`, contactName: 'Bursar' }, P);
  check('school renamed', renamed.status === 200, renamed.message);
  const cfg = await fetch(`${base}/w/${A.code}/public/config`).then((r) => r.json());
  check("the school's own name follows the rename", cfg.data?.schoolName === `Renamed ${A.code}`, cfg.data?.schoolName);

  // Support access.
  const code = await call('POST', `/platform/workspaces/${A.id}/support`, undefined, P);
  check('support code created', !!code.data?.code && code.data?.path?.startsWith('/support#code='), `${code.status}`);
  const ex = await call('POST', '/platform/support/exchange', { code: code.data.code });
  check('support code exchanged for a session', !!ex.data?.accessToken, `${ex.status} ${ex.message}`);
  const again = await call('POST', '/platform/support/exchange', { code: code.data.code });
  check('a support code works only once', again.status === 401, `${again.status}`);
  const S = ex.data.accessToken;
  const me = await call('GET', '/auth/me', undefined, S);
  check('support session is marked and named', me.data?.support?.adminName && me.data?.workspace?.code === A.code, JSON.stringify(me.data?.support));
  check('support session has full admin access', (await call('GET', '/users', undefined, S)).status === 200);
  const pw = await call('POST', '/auth/change-password', { currentPassword: 'x', newPassword: 'Whatever12345' }, S);
  check('a support session cannot change passwords', pw.status === 403, `${pw.status}`);
  const schoolAudit = await A.db.auditLog.findFirst({ where: { action: 'support_access' } });
  check("the school's own audit trail records the support visit", !!schoolAudit, schoolAudit?.description);
  const platformAudit = await call('GET', `/platform/audit?workspaceId=${A.id}`, undefined, P);
  check('the platform audit trail records it too', platformAudit.data?.some((r) => /for support/.test(r.description)), `${platformAudit.data?.length} rows`);

  // Suspension.
  const susp = await call('POST', `/platform/workspaces/${A.id}/suspend`, { reason: 'Test suspension' }, P);
  check('school suspended', susp.status === 200, susp.message);
  await new Promise((r) => setTimeout(r, 200));
  const blockedLogin = await call('POST', '/auth/login', { identifier: A.adminEmail, password: A.password, clientType: 'mobile' });
  check('sign-in to a suspended school is refused', blockedLogin.status === 403 && blockedLogin.error === 'WORKSPACE_SUSPENDED', `${blockedLogin.status} ${blockedLogin.error}`);
  const blockedToken = await call('GET', '/setup', undefined, A.token);
  check("an existing session in a suspended school is refused", blockedToken.status === 403, `${blockedToken.status}`);
  check('support still works in a suspended school', (await call('GET', '/setup', undefined, S)).status === 200);
  const res = await call('POST', `/platform/workspaces/${A.id}/resume`, undefined, P);
  check('school resumed', res.status === 200, res.message);
  const back = await call('POST', '/auth/login', { identifier: A.adminEmail, password: A.password, clientType: 'mobile' });
  check('sign-in works again after resuming', back.status === 200, `${back.status} ${back.message}`);

  // Extra admin and password reset.
  const extraEmail = `second.${A.code}@example.test`;
  const added = await call('POST', `/platform/workspaces/${A.id}/admins`, { fullName: 'Second Admin', email: extraEmail }, P);
  check('another Workspace Admin added', !!added.data?.temporaryPassword, `${added.status} ${added.message}`);
  const second = await call('POST', '/auth/login', { identifier: extraEmail, password: added.data.temporaryPassword, clientType: 'mobile' });
  check('the new admin signs in with the temporary password', second.status === 200 && second.data?.user?.mustChangePassword === true);
  const reset = await call('POST', `/platform/workspaces/${A.id}/admins/${second.data.user.id}/reset-password`, undefined, P);
  check('admin password reset', !!reset.data?.temporaryPassword, reset.message);
  const oldPw = await call('POST', '/auth/login', { identifier: extraEmail, password: added.data.temporaryPassword, clientType: 'mobile' });
  check('the old password no longer works', oldPw.status === 401);
  const newPw = await call('POST', '/auth/login', { identifier: extraEmail, password: reset.data.temporaryPassword, clientType: 'mobile' });
  check('the new temporary password works', newPw.status === 200);

  // Platform admins.
  const paEmail = `pa.${A.code}@example.test`;
  const pa = await call('POST', '/platform/admins', { fullName: 'Second Platform Admin', email: paEmail }, P);
  check('platform admin added', !!pa.data?.temporaryPassword, `${pa.status} ${pa.message}`);
  const paLogin = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: paEmail, password: pa.data.temporaryPassword, clientType: 'web' }) }).then((r) => r.json());
  check('they sign in to the console and must change the password', paLogin.data?.kind === 'platform' && paLogin.data?.user?.mustChangePassword === true);
  const clash = await call('POST', '/users', { fullName: 'X', email: paEmail, roleKey: 'office', password: 'TestPass2026x' }, A.token);
  check("a platform admin's email cannot be used in a school", clash.status === 400, `${clash.status}`);
  const disable = await call('PATCH', `/platform/admins/${pa.data.id}`, { status: 'disabled' }, P);
  check('platform admin disabled', disable.status === 200);

  await A.db.$disconnect();
  const n = failed();
  console.log(n ? `\n${n} check(s) failed` : '\nAll checks passed');
  process.exit(n ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
