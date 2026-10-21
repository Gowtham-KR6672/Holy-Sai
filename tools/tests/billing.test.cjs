// Subscriptions and billing: plans, trial, manual payments with invoices, signed Razorpay and Stripe webhooks
// (including replays), expiry with grace (school users blocked, Workspace Admin can renew, support gets in), and
// renewal. Gateway accounts use made-up test keys: webhooks are verified with secrets set here, and nothing is charged.
// Runs ONLY against the test API (port 4001). Usage: node tools/tests/billing.test.cjs
const crypto = require('crypto');
const { base, call, check, failed, newSchool, root, TEST_DB } = require('./helpers.cjs');
const path = require('path');

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const hmac = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

function platformDb() {
  const { PrismaClient } = require(path.join(root, 'node_modules/.prisma/platform-client'));
  const url = new URL(TEST_DB);
  url.searchParams.set('schema', 'platform');
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

(async () => {
  const A = await newSchool('Billing');
  const P = A.platform;
  const pdb = platformDb();

  // Plans, tax and gateways (made-up keys; webhook secrets known to this test).
  check('plans exist', ((await call('GET', '/platform/plans', undefined, P)).data ?? []).length === 4);
  await call('PUT', '/platform/plans/monthly', { priceInr: 1000, priceUsd: 15 }, P);
  await call('PUT', '/platform/plans/annual', { priceInr: 10000, priceUsd: 150 }, P);
  await call('PUT', '/platform/settings', { 'billing.tax_percent_inr': 18, 'billing.legal_name': 'We School Test Billing', 'billing.address': 'Chennai, India', 'billing.tax_id': '33TEST0000T1Z5' }, P);
  const rzpSecret = `rzp_wh_${crypto.randomBytes(8).toString('hex')}`;
  const stripeSecret = `whsec_${crypto.randomBytes(12).toString('hex')}`;
  const rzp = await call('PUT', '/platform/gateways/razorpay', { isEnabled: true, mode: 'test', config: { keyId: 'rzp_test_FAKE0000000000' }, secrets: { keySecret: 'fake_secret', webhookSecret: rzpSecret } }, P);
  check('Razorpay settings saved', rzp.status === 200, `${rzp.status} ${rzp.message}`);
  const st = await call('PUT', '/platform/gateways/stripe', { isEnabled: true, mode: 'test', config: { publishableKey: 'pk_test_FAKE' }, secrets: { secretKey: 'sk_test_FAKE', webhookSecret: stripeSecret } }, P);
  check('Stripe settings saved', st.status === 200, `${st.status} ${st.message}`);
  const masked = (await call('GET', '/platform/gateways', undefined, P)).data?.find((g) => g.gateway === 'razorpay');
  check('gateway secrets are never sent back', masked?.secrets?.keySecret === '••••••••' && !JSON.stringify(masked).includes(rzpSecret));
  const test = await call('POST', '/platform/gateways/razorpay/test', undefined, P);
  check('Test button reports bad keys clearly', test.status === 400, test.message);

  // No subscription yet: not enforced.
  const me0 = await call('GET', '/auth/me', undefined, A.token);
  check('a school without a subscription works (status none)', me0.data?.subscription?.status === 'none', me0.data?.subscription?.status);

  // Trial, then a manual annual payment.
  const trial = await call('POST', `/platform/workspaces/${A.id}/subscription/start`, { planCode: 'monthly', trialDays: 14 }, P);
  check('14-day trial started', trial.status === 201 || trial.status === 200, trial.message);
  const sub1 = await call('GET', `/platform/workspaces/${A.id}/subscription`, undefined, P);
  check('trial shows as expiring (within 15 days)', sub1.data?.status?.status === 'expiring' && sub1.data?.status?.endsOn === plusDays(today(), 13), JSON.stringify(sub1.data?.status));
  const manual = await call('POST', `/platform/workspaces/${A.id}/payments`, { planCode: 'annual', amount: 11800, method: 'bank', reference: 'UTR-TEST-1' }, P);
  check('manual payment extends from the end of the trial', manual.data?.startsOn === plusDays(today(), 14), `${manual.status} ${manual.message}`);
  check('annual period ends a year later', manual.data?.endsOn === plusDays(plusDays(today(), 14).replace(/^(\d{4})/, (y) => String(+y + 1)), -1), manual.data?.endsOn);
  const pdf = await fetch(`${base}/platform/invoices/${manual.data?.invoiceId}/pdf`, { headers: { authorization: `Bearer ${P}` } });
  const bytes = Buffer.from(await pdf.arrayBuffer());
  check('invoice PDF downloads', pdf.status === 200 && bytes.subarray(0, 4).toString() === '%PDF', `${pdf.status} ${bytes.length} bytes`);
  const inv = await pdb.invoice.findUnique({ where: { id: manual.data.invoiceId } });
  check('invoice splits 18% tax', Number(inv.subtotal) === 10000 && Number(inv.taxAmount) === 1800 && /WS-INV-\d{4}-\d{4}/.test(inv.number), `${inv.number} ${inv.subtotal} + ${inv.taxAmount}`);
  const schoolView = await call('GET', '/subscription', undefined, A.token);
  check("the school's own Subscription page shows it", schoolView.data?.status?.status === 'active' && schoolView.data?.invoices?.length === 1, schoolView.message);
  const schoolPdf = await fetch(`${base}/subscription/invoices/${manual.data?.invoiceId}/pdf`, { headers: { authorization: `Bearer ${A.token}` } });
  check('the school can download its invoice', schoolPdf.status === 200);

  // Razorpay webhook (an online payment the school started).
  const orderId = `order_TEST${crypto.randomBytes(5).toString('hex')}`;
  const rp = await pdb.payment.create({ data: { workspaceId: A.id, planCode: 'monthly', amount: 1180, currency: 'INR', gateway: 'razorpay', status: 'initiated', gatewayOrderId: orderId } });
  const rzBody = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: `pay_${crypto.randomBytes(5).toString('hex')}`, order_id: orderId, method: 'upi' } } } });
  const send = (body, sig, eventId) => fetch(`${base}/platform/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId }, body });
  check('a forged Razorpay webhook is refused', (await send(rzBody, hmac('wrong', rzBody), 'evt_forged')).status === 401);
  const evt = `evt_${crypto.randomBytes(6).toString('hex')}`;
  const r1 = await send(rzBody, hmac(rzpSecret, rzBody), evt).then((r) => r.json());
  check('Razorpay webhook settles the payment', r1.data?.outcome === 'settled', JSON.stringify(r1.data ?? r1));
  const periodsAfter = await pdb.subscriptionPeriod.count({ where: { workspaceId: A.id } });
  const r2 = await send(rzBody, hmac(rzpSecret, rzBody), evt).then((r) => r.json());
  check('the same event again is ignored', r2.data?.duplicate === true);
  await send(rzBody, hmac(rzpSecret, rzBody), `${evt}_retry`);
  check('a second event for the same payment adds no period', (await pdb.subscriptionPeriod.count({ where: { workspaceId: A.id } })) === periodsAfter);
  check('payment marked paid with an invoice', (await pdb.payment.findUnique({ where: { id: rp.id } })).status === 'paid');

  // Stripe webhook for a USD school.
  const B = await newSchool('Dollar', 'USD');
  const sessionId = `cs_test_${crypto.randomBytes(6).toString('hex')}`;
  await pdb.payment.create({ data: { workspaceId: B.id, planCode: 'monthly', amount: 15, currency: 'USD', gateway: 'stripe', status: 'initiated', gatewayOrderId: sessionId } });
  const sBody = JSON.stringify({ id: `evt_${crypto.randomBytes(6).toString('hex')}`, type: 'checkout.session.completed', data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_test_1' } } });
  const t = Math.floor(Date.now() / 1000);
  const stale = await fetch(`${base}/platform/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t - 3600},v1=${hmac(stripeSecret, `${t - 3600}.${sBody}`)}` }, body: sBody });
  check('an old Stripe signature is refused', stale.status === 400);
  const s1 = await fetch(`${base}/platform/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${hmac(stripeSecret, `${t}.${sBody}`)}` }, body: sBody }).then((r) => r.json());
  check('Stripe webhook settles the USD payment', s1.data?.outcome === 'settled', JSON.stringify(s1.data ?? s1));
  const bSub = await call('GET', '/subscription', undefined, B.token);
  check('USD school sees a USD invoice', bSub.data?.currency === 'USD' && bSub.data?.invoices?.[0]?.currency === 'USD');
  check('USD school is offered the USD gateway only', (bSub.data?.gateways ?? []).every((g) => g.gateway !== 'razorpay'), JSON.stringify(bSub.data?.gateways));

  // Expiry: an ended trial past its grace period.
  const C = await newSchool('Expiry');
  const pw = 'TestPass2026x';
  const officeEmail = `office.${C.code}@example.test`;
  await call('POST', '/users', { fullName: 'Front Office', email: officeEmail, roleKey: 'office', password: pw }, C.token);
  await call('POST', `/platform/workspaces/${C.id}/subscription/start`, { planCode: 'monthly', startsOn: plusDays(today(), -40), trialDays: 30 }, P);
  const office = await call('POST', '/auth/login', { identifier: officeEmail, password: pw, clientType: 'mobile' });
  check('after the grace period staff cannot sign in', office.status === 403 && office.error === 'SUBSCRIPTION_EXPIRED', `${office.status} ${office.error}`);
  const adminLogin = await call('POST', '/auth/login', { identifier: C.adminEmail, password: C.password, clientType: 'mobile' });
  check('the Workspace Admin can still sign in', adminLogin.status === 200, `${adminLogin.status}`);
  const blockedPage = await call('GET', '/students', undefined, adminLogin.data?.accessToken);
  check('…but only to renew (other pages answer 402)', blockedPage.status === 402 && blockedPage.error === 'SUBSCRIPTION_EXPIRED', `${blockedPage.status}`);
  check('…and the Subscription page opens', (await call('GET', '/subscription', undefined, adminLogin.data?.accessToken)).status === 200);
  const code = await call('POST', `/platform/workspaces/${C.id}/support`, undefined, P);
  const sup = await call('POST', '/platform/support/exchange', { code: code.data.code });
  check('support still gets in to an expired school', (await call('GET', '/students', undefined, sup.data?.accessToken)).status === 200);
  const renew = await call('POST', `/platform/workspaces/${C.id}/payments`, { planCode: 'monthly', amount: 1180, method: 'upi', reference: 'UPI-RENEW' }, P);
  check('renewal after expiry starts today', renew.data?.startsOn === today(), `${renew.data?.startsOn}`);
  const officeAgain = await call('POST', '/auth/login', { identifier: officeEmail, password: pw, clientType: 'mobile' });
  check('staff sign in again after renewal', officeAgain.status === 200, `${officeAgain.status} ${officeAgain.message}`);

  // Online checkout with made-up keys fails clearly (the payment is marked failed).
  const co = await call('POST', '/subscription/checkout', { planCode: 'monthly', gateway: 'razorpay' }, A.token);
  check('checkout with bad gateway keys gives a clear error', co.status === 502, `${co.status} ${co.message}`);

  // Clean up the shared gateway settings so they do not affect other runs.
  await call('PUT', '/platform/gateways/razorpay', { isEnabled: false }, P);
  await call('PUT', '/platform/gateways/stripe', { isEnabled: false }, P);
  await pdb.$disconnect();
  for (const s of [A, B, C]) await s.db.$disconnect();
  const n = failed();
  console.log(n ? `\n${n} check(s) failed` : '\nAll checks passed');
  process.exit(n ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
