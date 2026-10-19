// End-to-end test of the school setup → student → logins → discontinue → re-enrol flow, with Tamil and Hindi text.
// Runs ONLY against the test API (port 4001, database holysai_test).
const fs = require('fs');
const path = require('path');
// Usage (from the repo root, with the test API running on port 4001): node tools/tests/student-lifecycle.test.cjs
const root = process.argv[2] ?? process.cwd();
const env = fs.readFileSync(path.join(root, 'apps/api/.env'), 'utf8');
const get = (k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))[1].trim();
const base = 'http://localhost:4001/api';
let token;
const call = async (method, p, body, tok) => {
  if (tok === undefined) tok = token;
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, 'x-client-type': 'mobile' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 200) }; }
  return { status: r.status, ...j };
};
const check = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
const login = (identifier, password) => call('POST', '/auth/login', { identifier, password, clientType: 'mobile' }, '');

(async () => {
  const health = await fetch(base + '/public/health');
  if (!health.ok) throw new Error('test API not running');
  const admin = await login(get('SEED_ADMIN_EMAIL'), get('SEED_ADMIN_PASSWORD'));
  token = admin.data.accessToken;
  const tag = Date.now().toString(36).slice(-5);

  // School setup with Tamil / Hindi text (UTF-8 check)
  const campus = await call('POST', '/setup/campuses', { code: `g${tag}`.toLowerCase(), name: `Holy Sai Guduvanchery ${tag}`, shortName: 'கூடுவாஞ்சேரி', place: 'Guduvanchery', curriculum: 'Cambridge' });
  check('campus with Tamil short name is saved', campus.status < 300 && campus.data?.shortName === 'கூடுவாஞ்சேரி', `${campus.status} ${campus.message}`);
  const campusId = campus.data?.id;
  const year = await call('POST', '/setup/academic-years', { label: `${2030 + Math.floor(Math.random() * 60)}-${tag}`.slice(0, 20), startsOn: '2026-06-01', endsOn: '2027-04-30' });
  check('academic year created', year.status < 300, `${year.status} ${year.message}`);
  const cls = await call('POST', '/setup/classes', { campusId, name: 'Grade 6', gradeLevel: 6, stage: 'Lower Secondary', sections: ['A'] });
  check('class with section created', cls.status < 300, `${cls.status} ${cls.message}`);
  const lookups = await call('GET', '/lookups');
  const section = lookups.data?.classes?.find((c) => c.campusId === campusId)?.sections?.[0];
  check('lookups returns the new section', !!section);

  // Student with Tamil name and a Hindi-named guardian
  const phone = `+9198${String(Date.now()).slice(-8)}`;
  const st = await call('POST', '/students', {
    firstName: 'அனன்யா', lastName: 'ராஜ்', dateOfBirth: '2014-03-12', gender: 'F', campusId, sectionId: section?.id,
    guardians: [{ fullName: 'राजेश कुमार', phone, relationship: 'Father', isPrimary: true }],
  });
  check('student with Tamil name created', st.status < 300 && !!st.data?.id, `${st.status} ${st.message} ${JSON.stringify(st.details ?? '')}`);
  const studentId = st.data?.id;
  const profile = await call('GET', `/students/${studentId}/profile`);
  check('profile reads back Tamil name', profile.data?.student?.fullName?.includes('அனன்யா'), profile.data?.student?.fullName);
  const guardianId = profile.data?.guardians?.[0]?.id;
  check('guardian with Hindi name linked', profile.data?.guardians?.[0]?.fullName === 'राजेश कुमार', profile.data?.guardians?.[0]?.fullName);

  // Logins linked to the records
  const pw = 'TestPass2026x';
  const su = await call('POST', '/users', { fullName: 'அனன்யா ராஜ்', email: `ananya.${tag}@example.test`, roleKey: 'student', password: pw, linkId: studentId });
  const pu = await call('POST', '/users', { fullName: 'राजेश कुमार', email: `rajesh.${tag}@example.test`, roleKey: 'parent', password: pw, linkId: guardianId });
  check('student and parent logins created', su.status < 300 && pu.status < 300, `${su.message} / ${pu.message}`);
  const parentLogin = await login(`rajesh.${tag}@example.test`, pw);
  check('parent can sign in', parentLogin.status === 200);
  const me = await call('GET', '/parents/me', null, parentLogin.data?.accessToken ?? 'none');
  check('parent sees the child in /parents/me', me.data?.children?.some((c) => c.id === studentId), `${me.status} ${me.message ?? ''}`);
  const fees = await call('GET', `/family/children/${studentId}/fees`, null, parentLogin.data?.accessToken ?? 'none');
  check('parent can open fees', fees.status === 200, `${fees.status} ${fees.message}`);

  // Discontinue → logins disabled
  const leave = await call('PATCH', `/students/${studentId}/status`, { status: 'discontinued', reason: 'குடும்பம் இடமாற்றம் — family relocating' });
  check('student marked as discontinued', leave.status < 300, `${leave.status} ${leave.message}`);
  const sAfter = await login(`ananya.${tag}@example.test`, pw);
  const pAfter = await login(`rajesh.${tag}@example.test`, pw);
  check('student login refused after leaving', sAfter.status >= 400, `${sAfter.status} ${sAfter.message}`);
  check('parent login refused (no other child enrolled)', pAfter.status >= 400, `${pAfter.status} ${pAfter.message}`);
  const oldToken = await call('GET', '/auth/me', null, parentLogin.data?.accessToken ?? 'none');
  check('parent existing session no longer works', oldToken.status >= 400, `${oldToken.status}`);
  const reenable = await call('PATCH', `/users/${su.data?.id}`, { status: 'active' });
  check('admin cannot re-activate the student login directly', reenable.status === 400, `${reenable.status} ${reenable.message}`);
  const stillThere = await call('GET', `/students/${studentId}/profile`);
  check('record is kept for school files', stillThere.status === 200 && stillThere.data?.student?.status === 'discontinued');

  // Re-enrol → logins restored
  const back = await call('PATCH', `/students/${studentId}/status`, { status: 'active', reason: 'Returned' });
  check('student re-enrolled', back.status < 300, `${back.status} ${back.message}`);
  const sBack = await login(`ananya.${tag}@example.test`, pw);
  const pBack = await login(`rajesh.${tag}@example.test`, pw);
  check('student login works again', sBack.status === 200, `${sBack.status} ${sBack.message}`);
  check('parent login works again', pBack.status === 200, `${pBack.status} ${pBack.message}`);

  // Rupee sign and Tamil text in free text fields
  const note = await call('POST', `/students/${studentId}/observations`, { observation: 'கணிதத்தில் சிறப்பு — fee ₹12,500 cleared' });
  check('observation with ₹ and Tamil saved', note.status < 300, `${note.status} ${note.message}`);
})().catch((e) => { console.error(e); process.exit(1); });
