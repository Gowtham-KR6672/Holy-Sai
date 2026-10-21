// Deleting a school: only once suspended and with its code typed; the schema, sign-ins and uploads go, payments and
// invoices stay, and the code and emails can be used again by a new school that starts empty.
// Runs ONLY against the test API (port 4001).
// Usage (repo root, test API running: node tools/test-api.mjs): node tools/tests/delete-school.test.cjs
const fs = require('fs');
const path = require('path');
const { base, call, check, failed, getEnv, newSchool, root, TEST_DB } = require('./helpers.cjs');

(async () => {
  const A = await newSchool('Delete');
  const P = A.platform;
  const { Client } = require(path.join(root, 'node_modules/pg'));
  const pg = new Client({ connectionString: TEST_DB });
  await pg.connect();
  const schemaExists = async (schema) => (await pg.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schema])).rowCount === 1;

  // Something to delete: a campus, a payment with an invoice, an uploaded file.
  const campus = await call('POST', '/setup/campuses', { code: 'old', name: 'Old Campus', place: 'Chennai' }, A.token);
  check('campus created', campus.status === 201 || campus.status === 200, `${campus.status} ${campus.message}`);
  const paid = await call('POST', `/platform/workspaces/${A.id}/payments`, { planCode: 'monthly', amount: 1180, method: 'bank', reference: `UTR-${A.code}` }, P);
  check('payment recorded', !!paid.data?.invoiceId, `${paid.status} ${paid.message}`);
  const uploads = path.join(path.resolve(root, 'apps/api', getEnv('UPLOAD_DIR') || './uploads'), A.code);
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, 'note.txt'), 'test');

  // Guards.
  const active = await call('POST', `/platform/workspaces/${A.id}/delete`, { code: A.code }, P);
  check('an active school cannot be deleted', active.status === 400 && /Suspend/.test(active.message), `${active.status} ${active.message}`);
  await call('POST', `/platform/workspaces/${A.id}/suspend`, { reason: 'About to delete' }, P);
  const wrong = await call('POST', `/platform/workspaces/${A.id}/delete`, { code: 'notthecode' }, P);
  check('the code must be typed exactly', wrong.status === 400 && wrong.details?.some?.((d) => d.field === 'code'), `${wrong.status} ${JSON.stringify(wrong.details)}`);
  const school = await call('POST', `/platform/workspaces/${A.id}/delete`, { code: A.code }, A.token);
  check('a school token cannot delete', school.status === 401 || school.status === 403, `${school.status}`);
  check('nothing was deleted by the refused attempts', await schemaExists(A.schema));

  // Delete.
  const del = await call('POST', `/platform/workspaces/${A.id}/delete`, { code: A.code.toUpperCase() }, P);
  check('suspended school deleted (code is not case-sensitive)', del.status === 200, `${del.status} ${del.message}`);
  check('its schema is gone', !(await schemaExists(A.schema)));
  check('its uploads are gone', !fs.existsSync(uploads));
  check('it is no longer listed', !(await call('GET', '/platform/workspaces', undefined, P)).data?.some((w) => w.id === A.id));
  check('its page is gone', (await call('GET', `/platform/workspaces/${A.code}`, undefined, P)).status === 404);
  check('its subscription page is gone', (await call('GET', `/platform/workspaces/${A.id}/subscription`, undefined, P)).status === 404);
  const again = await call('POST', `/platform/workspaces/${A.id}/delete`, { code: A.code }, P);
  check('deleting twice is refused', again.status === 404, `${again.status}`);
  const login = await call('POST', '/auth/login', { identifier: A.adminEmail, password: A.password, clientType: 'mobile' });
  check('its admin can no longer sign in', login.status === 401, `${login.status} ${login.error}`);
  const token = await call('GET', '/auth/me', undefined, A.token);
  check('its existing sessions stop working', token.status === 401 || token.status === 403, `${token.status}`);
  const hook = await fetch(`${base}/w/${A.code}/gate/webhooks/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('its webhook address no longer reaches anything', hook.status >= 400, `${hook.status}`);

  // Kept: payments, invoices and the platform audit.
  const payments = await call('GET', `/platform/payments?workspaceId=${A.id}`, undefined, P);
  const kept = payments.data?.find((p) => p.reference === `UTR-${A.code}`);
  check('its payment is kept, marked as a deleted school', kept && kept.schoolDeleted === true && kept.schoolCode === null, JSON.stringify(kept));
  const pdf = await fetch(`${base}/platform/invoices/${paid.data.invoiceId}/pdf`, { headers: { authorization: `Bearer ${P}` } });
  check('its invoice still downloads', pdf.status === 200);
  const audit = await call('GET', `/platform/audit?workspaceId=${A.id}`, undefined, P);
  check('the platform audit trail records the deletion', audit.data?.some((r) => r.description === `Deleted school ${del.data?.name} (${A.code})`), audit.data?.[0]?.description);

  // The code and the admin email can be used again; the new school starts empty.
  const reborn = await call('POST', '/platform/workspaces', { name: `Reborn ${A.code}`, code: A.code, currency: 'INR', admin: { fullName: 'New Admin', email: A.adminEmail } }, P);
  check('a new school can reuse the code and the admin email', reborn.status === 201 || reborn.status === 200, `${reborn.status} ${reborn.message}`);
  const first = await call('POST', '/auth/login', { identifier: A.adminEmail, password: reborn.data?.admin?.temporaryPassword, clientType: 'mobile' });
  check('the new admin signs in', !!first.data?.accessToken, `${first.status} ${first.message}`);
  const setup = await call('GET', '/setup', undefined, first.data?.accessToken);
  check('the new school has none of the old data', setup.status === 200 && !JSON.stringify(setup.data).includes('Old Campus'), `${setup.status}`);
  const newPayments = await call('GET', `/platform/workspaces/${reborn.data?.workspace?.id}/subscription`, undefined, P);
  check("the old school's payments do not move to the new one", newPayments.status === 200 && !(newPayments.data?.payments ?? []).length, `${newPayments.data?.payments?.length}`);

  // Clean up the second school too.
  await call('POST', `/platform/workspaces/${reborn.data.workspace.id}/suspend`, { reason: 'Test clean-up' }, P);
  const cleanup = await call('POST', `/platform/workspaces/${reborn.data.workspace.id}/delete`, { code: A.code }, P);
  check('the reused code is deleted again', cleanup.status === 200 && !(await schemaExists(A.schema)), `${cleanup.status} ${cleanup.message}`);

  await pg.end();
  await A.db.$disconnect();
  const n = failed();
  console.log(n ? `\n${n} check(s) failed` : '\nAll checks passed');
  process.exit(n ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
