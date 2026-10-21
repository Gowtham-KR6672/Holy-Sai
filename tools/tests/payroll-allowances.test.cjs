// Payroll allowances: the school's rules (auto calculate as % of basic, or fixed amounts for everyone) and an
// employee's own amounts. Runs ONLY against the test API (port 4001).
// Usage (repo root, test API running: node tools/test-api.mjs): node tools/tests/payroll-allowances.test.cjs
const { base, call, check, failed, newSchool } = require('./helpers.cjs');

(async () => {
  const A = await newSchool('Payroll');
  const W = A.token;
  const campus = await call('POST', '/setup/campuses', { code: 'pay', name: 'Pay Campus', place: 'Chennai' }, W);
  const campusId = campus.data?.id;
  check('campus created', !!campusId, `${campus.status} ${campus.message}`);

  const staff = (fullName, basicSalary, extra = {}) => call('POST', '/workforce/employees', {
    fullName, campusId, department: 'Academics', designation: 'Teacher', employeeType: 'teaching', category: 'Teachers', joinDate: '2026-01-01', basicSalary, ...extra,
  }, W);
  const ruled = await staff('Rule Follower', 10000);
  const own = await staff('Own Amounts', 20000, { customAllowances: true, hraAmount: 3000, conveyanceAmount: 500, specialAllowanceAmount: 0 });
  check('employees created', !!ruled.data?.id && !!own.data?.id, `${ruled.status} ${own.status} ${own.message}`);
  const ownDetail = await call('GET', `/workforce/employees/${own.data.id}`, undefined, W);
  const od = ownDetail.data?.employee ?? ownDetail.data;
  check("an employee's own amounts are saved", od?.customAllowances === true && od?.hraAmount === 3000 && od?.conveyanceAmount === 500, JSON.stringify({ c: od?.customAllowances, h: od?.hraAmount, v: od?.conveyanceAmount }));

  const rules = await call('GET', '/payroll/rules', undefined, W);
  check('default rules: auto calculate, 40% / 10% of basic, ₹1,600 conveyance', rules.data?.autoCalculate === true && rules.data?.hraPercent === 40 && rules.data?.specialPercent === 10 && rules.data?.conveyance === 1600, JSON.stringify(rules.data));
  check('the rules count employees with their own amounts', rules.data?.employeesWithOwnAmounts === 1, `${rules.data?.employeesWithOwnAmounts}`);

  // A payroll run for last month (no attendance marks: everyone is paid for every working day).
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const run = await call('POST', '/payroll/runs', { campusId, payMonth: last }, W);
  const runId = run.data?.run?.id;
  check('payroll run opened', !!runId, `${run.status} ${run.message}`);
  await call('POST', `/payroll/runs/${runId}/inputs`, undefined, W);
  const lines = async () => {
    const slips = await A.db.workforcePayslip.findMany({ where: { runId } });
    const by = (id) => Object.fromEntries((slips.find((s) => s.employeeId === id)?.earnings ?? []).map((l) => [l.label, l.amount]));
    return { ruled: by(ruled.data.id), own: by(own.data.id) };
  };

  const calc1 = await call('POST', `/payroll/runs/${runId}/calculate`, undefined, W);
  check('payroll calculated', calc1.status === 200, `${calc1.status} ${calc1.message}`);
  let p = await lines();
  check('auto calculate: HRA 40% and special 10% of basic, conveyance ₹1,600', p.ruled['House rent allowance'] === 4000 && p.ruled['Special allowance'] === 1000 && p.ruled.Conveyance === 1600, JSON.stringify(p.ruled));
  check("own amounts are used instead of the school's rules (a 0 line is left out)", p.own['House rent allowance'] === 3000 && p.own.Conveyance === 500 && !('Special allowance' in p.own), JSON.stringify(p.own));

  // Only a role with settings.manage may change the rules.
  const hrEmail = `hr.${A.code}@example.test`;
  const hrUser = await call('POST', '/users', { fullName: 'Pay HR', email: hrEmail, roleKey: 'hr', password: 'TestPass2026x', campusId }, W);
  const hrLogin = await call('POST', '/auth/login', { identifier: hrEmail, password: 'TestPass2026x', clientType: 'mobile' });
  if (hrUser.data && hrLogin.data?.accessToken) {
    const hrPut = await call('PUT', '/payroll/rules', { autoCalculate: false, hraPercent: 40, specialPercent: 10, conveyance: 0, fixedHra: 1, fixedSpecial: 1 }, hrLogin.data.accessToken);
    check('HR cannot change the allowance rules', hrPut.status === 403, `${hrPut.status}`);
  } else {
    check('HR user for the permission check', false, `${hrUser.status} ${hrUser.message} / ${hrLogin.status} ${hrLogin.message}`);
  }
  const badPct = await call('PUT', '/payroll/rules', { autoCalculate: true, hraPercent: 140, specialPercent: 10, conveyance: 1600, fixedHra: 0, fixedSpecial: 0 }, W);
  check('a percentage over 100 is refused', badPct.status === 400 && badPct.details?.some?.((d) => d.field === 'hraPercent'), `${badPct.status} ${JSON.stringify(badPct.details)}`);

  // Auto calculate off: fixed amounts for everyone without their own amounts.
  const put = await call('PUT', '/payroll/rules', { autoCalculate: false, hraPercent: 40, specialPercent: 10, conveyance: 1200, fixedHra: 2500, fixedSpecial: 750 }, W);
  check('Workspace Admin turns auto calculate off with fixed amounts', put.status === 200 && put.data?.autoCalculate === false && put.data?.fixedHra === 2500, `${put.status} ${put.message}`);
  const audit = await A.db.auditLog.findFirst({ where: { entityId: 'payroll.allowances' }, orderBy: { createdAt: 'desc' } });
  check('the change is in the audit trail', /auto calculate off/.test(audit?.description ?? ''), audit?.description);
  await call('POST', `/payroll/runs/${runId}/calculate`, undefined, W);
  p = await lines();
  check('fixed amounts: HRA ₹2,500, conveyance ₹1,200, special ₹750 whatever the basic', p.ruled['House rent allowance'] === 2500 && p.ruled.Conveyance === 1200 && p.ruled['Special allowance'] === 750, JSON.stringify(p.ruled));
  check('own amounts still win', p.own['House rent allowance'] === 3000 && p.own.Conveyance === 500, JSON.stringify(p.own));

  // The employee goes back to the school's rules.
  const back = await call('PUT', `/workforce/employees/${own.data.id}`, {
    fullName: 'Own Amounts', campusId, department: 'Academics', designation: 'Teacher', employeeType: 'teaching', category: 'Teachers', joinDate: '2026-01-01', basicSalary: 20000, customAllowances: false,
  }, W);
  check('employee switched back to the school rules', back.status === 200, `${back.status} ${back.message}`);
  await call('POST', `/payroll/runs/${runId}/calculate`, undefined, W);
  p = await lines();
  check('they now get the school\'s fixed amounts', p.own['House rent allowance'] === 2500 && p.own.Conveyance === 1200 && p.own['Special allowance'] === 750, JSON.stringify(p.own));

  await A.db.$disconnect();
  const n = failed();
  console.log(n ? `\n${n} check(s) failed` : '\nAll checks passed');
  process.exit(n ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
