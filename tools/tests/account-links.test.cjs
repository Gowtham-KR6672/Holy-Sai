// Integration test for account ↔ record linking. Runs ONLY against the test API (port 4001, database holysai_test).
const path = require('path');
// Usage (from the repo root, with the test API running on port 4001): node tools/tests/account-links.test.cjs
const root = process.argv[2] ?? process.cwd();
process.env.DATABASE_URL = 'postgresql://holysai:holysai_dev@localhost:5433/holysai_test';
{ const engine = path.join(root, '.data/prisma-engine/query_engine-windows.dll.node'); if (require('fs').existsSync(engine)) process.env.PRISMA_QUERY_ENGINE_LIBRARY = engine; }
const { PrismaClient } = require(path.join(root, 'node_modules/@prisma/client'));
const fs = require('fs');
const env = fs.readFileSync(path.join(root, 'apps/api/.env'), 'utf8');
const get = (k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))[1].trim();
const base = 'http://localhost:4001/api';
const db = new PrismaClient();
let token;
const call = async (method, p, body, tok = token) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, 'x-client-type': 'mobile' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
};
const check = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);

(async () => {
  const dbName = (await db.$queryRawUnsafe('select current_database() as d'))[0].d;
  if (dbName !== 'holysai_test') throw new Error('Refusing to run outside holysai_test: ' + dbName);
  const login = await call('POST', '/auth/login', { identifier: get('SEED_ADMIN_EMAIL'), password: get('SEED_ADMIN_PASSWORD'), clientType: 'mobile' }, '');
  token = login.data.accessToken;

  const tag = Date.now().toString(36);
  const campus = await db.campus.create({ data: { code: `T${tag}`, name: `Test Campus ${tag}`, shortName: 'Test', place: 'Chennai', curriculum: 'Cambridge' } });
  const emp = await db.employee.create({ data: { code: `EMP-${tag}`, fullName: `Teacher ${tag}`, email: `teacher.${tag}@example.test`, campusId: campus.id, department: 'Academics', designation: 'Class Teacher', employeeType: 'teaching', category: 'Teaching', joinDate: new Date() } });
  const guardian = await db.guardian.create({ data: { fullName: `Parent ${tag}`, phone: `+9190000${tag.slice(-5)}` } });
  const cls = await db.schoolClass.create({ data: { campusId: campus.id, name: 'Grade 5', gradeLevel: 5, stage: 'Primary' } });
  const section = await db.section.create({ data: { classId: cls.id, campusId: campus.id, name: 'A' } });
  const student = await db.student.create({ data: { sectionId: section.id, admissionNo: `HS-T-${tag}`, firstName: 'Kid', lastName: tag, fullName: `Kid ${tag}`, dateOfBirth: new Date('2016-05-01'), gender: 'F', campusId: campus.id } });

  const pw = 'TestPass2026x';
  const cand = await call('GET', `/users/link-candidates?kind=parent&q=${encodeURIComponent('Parent ' + tag)}`);
  check('candidates finds the parent', cand.data?.some((c) => c.id === guardian.id), JSON.stringify(cand.data?.[0] ?? cand.message));

  const noLink = await call('POST', '/users', { fullName: 'P One', email: `p1.${tag}@example.test`, roleKey: 'parent', password: pw });
  check('parent without link is refused', noLink.status === 400 && noLink.details?.[0]?.field === 'linkId', `${noLink.status} ${noLink.message}`);

  const p1 = await call('POST', '/users', { fullName: 'P One', email: `p1.${tag}@example.test`, roleKey: 'parent', password: pw, linkId: guardian.id });
  check('parent with link is created and linked', p1.status === 201 || p1.status === 200 ? p1.data?.linked?.id === guardian.id : false, `${p1.status} ${p1.message}`);

  const dup = await call('POST', '/users', { fullName: 'P Two', email: `p2.${tag}@example.test`, roleKey: 'parent', password: pw, linkId: guardian.id });
  check('second account for the same parent is refused', dup.status === 409, `${dup.status} ${dup.message}`);

  const t1 = await call('POST', '/users', { fullName: 'T One', email: `teacher.${tag}@example.test`, roleKey: 'teacher', password: pw });
  check('teacher is auto-linked by email', t1.data?.linked?.id === emp.id, `${t1.status} ${JSON.stringify(t1.data?.linked)}`);
  check('teacher campus taken from staff record', (await db.user.findUnique({ where: { id: t1.data.id } })).campusId === campus.id);

  const s1 = await call('POST', '/users', { fullName: 'Kid', email: `kid.${tag}@example.test`, roleKey: 'student', password: pw, linkId: student.id });
  check('student is linked', s1.data?.linked?.id === student.id, `${s1.status} ${s1.message}`);

  const list = await call('GET', `/users?q=${tag}`);
  check('users list shows linked names', list.data?.filter((u) => u.linked).length === 3, `${list.data?.length} rows`);

  const unl = await call('PATCH', `/users/${s1.data.id}`, { linkId: null });
  check('unlink works', unl.data?.linked === null, unl.message);
  const rel = await call('PATCH', `/users/${s1.data.id}`, { linkId: student.id });
  check('relink works', rel.data?.linked?.id === student.id, rel.message);

  const pl = await call('POST', '/auth/login', { identifier: `p1.${tag}@example.test`, password: pw, clientType: 'mobile' }, '');
  check('linked parent can sign in and carries parentId', pl.data?.user?.parentId === guardian.id, `${pl.status} ${pl.message}`);

  await db.$disconnect();
})().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
