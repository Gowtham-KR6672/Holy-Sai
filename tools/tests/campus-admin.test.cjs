// Campus admins see and change only their own campus. Runs ONLY against the test API (port 4001).
// Usage (repo root, test API running: node tools/test-api.mjs): node tools/tests/campus-admin.test.cjs
const { call, check, failed, newSchool } = require('./helpers.cjs');

(async () => {
  const S = await newSchool('Campus');
  const W = S.token;
  const db = S.db;
  const pw = 'TestPass2026x';

  // Two campuses, each with a class, a section and a student.
  const north = await call('POST', '/setup/campuses', { code: 'nth', name: 'North Campus', place: 'Chennai' }, W);
  const south = await call('POST', '/setup/campuses', { code: 'sth', name: 'South Campus', place: 'Madurai' }, W);
  const northId = north.data?.id;
  const southId = south.data?.id;
  check('two campuses created', !!northId && !!southId);
  const studentIn = async (campusId, tag) => {
    const cls = await db.schoolClass.create({ data: { campusId, name: `Grade 4 ${tag}`, gradeLevel: 4, stage: 'Primary' } });
    const section = await db.section.create({ data: { classId: cls.id, campusId, name: 'A' } });
    return db.student.create({ data: { sectionId: section.id, admissionNo: `CA-${tag}-${S.code}`, firstName: tag, lastName: 'Kid', fullName: `${tag} Kid`, dateOfBirth: new Date('2017-03-01'), gender: 'M', campusId } });
  };
  const northKid = await studentIn(northId, 'North');
  const southKid = await studentIn(southId, 'South');

  // A campus admin needs a campus.
  const noCampus = await call('POST', '/users', { fullName: 'No Campus', email: `nocampus.${S.code}@example.test`, roleKey: 'campus_admin', password: pw }, W);
  check('a campus admin must have a campus', noCampus.status === 400 && noCampus.details?.[0]?.field === 'campusId', `${noCampus.status} ${noCampus.message}`);
  const caEmail = `north.admin.${S.code}@example.test`;
  const ca = await call('POST', '/users', { fullName: 'North Admin', email: caEmail, roleKey: 'campus_admin', campusId: northId, password: pw }, W);
  check('campus admin created by the Workspace Admin', ca.status < 300, `${ca.status} ${ca.message}`);
  const login = await call('POST', '/auth/login', { identifier: caEmail, password: pw, clientType: 'mobile' });
  const C = login.data?.accessToken;
  check('campus admin signs in', !!C && login.data?.user?.role?.key === 'campus_admin', `${login.status} ${login.message}`);

  // Lists show only the own campus.
  const lookups = await call('GET', '/lookups', undefined, C);
  const lookupCampuses = (lookups.data?.campuses ?? []).map((c) => c.id);
  check('campus selector lists only the own campus', lookupCampuses.length === 1 && lookupCampuses[0] === northId, JSON.stringify(lookupCampuses));
  const setup = await call('GET', '/setup', undefined, C);
  check('School Setup shows only the own campus', (setup.data?.campuses ?? []).length === 1);
  const students = await call('GET', '/students', undefined, C);
  const ids = (students.data ?? []).map((s) => s.id);
  check('student list has only own-campus students', ids.includes(northKid.id) && !ids.includes(southKid.id), `${ids.length} students`);
  const allView = await call('GET', '/students?campusId=all', undefined, C);
  check('"all campuses" still means only the own campus', !(allView.data ?? []).some((s) => s.id === southKid.id));
  const otherCampus = await call('GET', `/students?campusId=${southId}`, undefined, C);
  check('asking for another campus is refused', otherCampus.status === 403, `${otherCampus.status}`);

  // Records by id.
  const southProfile = await call('GET', `/students/${southKid.id}/profile`, undefined, C);
  check("another campus's student cannot be opened by id", southProfile.status === 404 || southProfile.status === 403, `${southProfile.status}`);
  const northProfile = await call('GET', `/students/${northKid.id}/profile`, undefined, C);
  check("own campus's student opens", northProfile.status === 200, `${northProfile.status} ${northProfile.message}`);
  const editSouth = await call('PUT', `/setup/campuses/${southId}`, { code: 'sth', name: 'Taken over', place: 'Madurai' }, C);
  check("another campus cannot be edited", editSouth.status === 404 || editSouth.status === 403, `${editSouth.status}`);
  const newCampus = await call('POST', '/setup/campuses', { code: 'est', name: 'East Campus', place: 'Trichy' }, C);
  check('a campus admin cannot add campuses', newCampus.status === 403, `${newCampus.status} ${newCampus.message}`);

  // Accounts.
  const office = await call('POST', '/users', { fullName: 'Front Office', email: `office.${S.code}@example.test`, roleKey: 'office', password: pw }, C);
  check('campus admin creates an office account', office.status < 300 && office.data?.campusId === northId, `${office.status} ${office.data?.campusId === northId ? 'on own campus' : office.message}`);
  const elevate = await call('POST', '/users', { fullName: 'Boss', email: `boss.${S.code}@example.test`, roleKey: 'school_admin', password: pw }, C);
  check('campus admin cannot create school-wide admins', elevate.status === 403, `${elevate.status}`);
  const southUser = await call('POST', '/users', { fullName: 'South Office', email: `south.office.${S.code}@example.test`, roleKey: 'office', campusId: southId, password: pw }, W);
  const touch = await call('PATCH', `/users/${southUser.data?.id}`, { title: 'Changed' }, C);
  check("another campus's account cannot be changed", touch.status === 403 || touch.status === 404, `${touch.status}`);
  const workspaceAdmin = (await call('GET', '/users', undefined, W)).data?.find((u) => u.email === S.adminEmail);
  const touchAdmin = await call('PATCH', `/users/${workspaceAdmin?.id}`, { title: 'Changed' }, C);
  check('the Workspace Admin cannot be changed by a campus admin', touchAdmin.status === 403, `${touchAdmin.status}`);

  // Dashboards work for the campus.
  const dash = await call('GET', '/dashboard/command-center', undefined, C);
  check('campus dashboard loads', dash.status === 200, `${dash.status} ${dash.message}`);

  // The Workspace Admin still sees everything.
  const all = await call('GET', '/students', undefined, W);
  check('the Workspace Admin still sees both campuses', (all.data ?? []).length >= 2, `${all.data?.length}`);

  await db.$disconnect();
  const n = failed();
  console.log(n ? `\n${n} check(s) failed` : '\nAll checks passed');
  process.exit(n ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
