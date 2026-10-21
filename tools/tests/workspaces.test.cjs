// We School multi-school isolation test. Runs ONLY against the test API (port 4001, database holysai_test).
// Creates two throw-away schools and checks that nothing crosses between them: sign-in, lists, records by id,
// interleaved concurrent requests, refresh tokens, school addresses (/api/w/<code>/…), GPS device tokens, the
// sign-in directory (one email = one school) and that each school's tables live in its own schema.
// Usage (repo root, test API running: node tools/test-api.mjs): node tools/tests/workspaces.test.cjs
const { base, call, check, failed, newSchool, platformToken } = require('./helpers.cjs');

(async () => {
  const A = await newSchool('Alpha');
  const B = await newSchool('Beta');
  check('two schools created and their admins signed in', !!A.token && !!B.token, `${A.code}, ${B.code}`);
  check('first sign-in asks for a new password', A.firstLogin.data?.user?.mustChangePassword === true);
  check('/auth/me names the school', (await call('GET', '/auth/me', undefined, A.token)).data?.workspace?.code === A.code);

  // Each school's tables are in its own schema.
  const [schemaA] = await A.db.$queryRawUnsafe('select current_schema() as s');
  check('school A tables are in its own schema', schemaA.s === A.schema, schemaA.s);

  // Campuses in each school.
  const campusA = await call('POST', '/setup/campuses', { code: 'alp', name: `Alpha Campus ${A.code}`, place: 'Chennai' }, A.token);
  const campusB = await call('POST', '/setup/campuses', { code: 'bet', name: `Beta Campus ${B.code}`, place: 'Madurai' }, B.token);
  check('campus created in A', campusA.status < 300, `${campusA.status} ${campusA.message}`);
  check('campus created in B', campusB.status < 300, `${campusB.status} ${campusB.message}`);
  const setupA = await call('GET', '/setup', undefined, A.token);
  const setupB = await call('GET', '/setup', undefined, B.token);
  const namesA = (setupA.data?.campuses ?? []).map((c) => c.name);
  const namesB = (setupB.data?.campuses ?? []).map((c) => c.name);
  check('A sees only its campus', namesA.length === 1 && namesA[0].startsWith('Alpha'), namesA.join(', '));
  check('B sees only its campus', namesB.length === 1 && namesB[0].startsWith('Beta'), namesB.join(', '));
  const idB = setupB.data?.campuses?.[0]?.id;
  const crossEdit = await call('PUT', `/setup/campuses/${idB}`, { code: 'bet', name: 'Hijacked', place: 'Nowhere' }, A.token);
  check("A cannot edit B's campus by id", crossEdit.status === 404, `${crossEdit.status} ${crossEdit.message}`);

  // Interleaved concurrent requests keep their own school.
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) => {
      const s = i % 2 ? B : A;
      return call('GET', '/setup', undefined, s.token).then((r) => ({ want: s === A ? 'Alpha' : 'Beta', got: r.data?.campuses?.map((c) => c.name) ?? [] }));
    }),
  );
  const crossed = results.filter((r) => r.got.length !== 1 || !r.got[0].startsWith(r.want));
  check('40 interleaved concurrent requests never cross schools', crossed.length === 0, `${crossed.length} crossed`);

  // A token is only valid in its own school, even at another school's address.
  const viaAddress = await fetch(base.replace(/\/api$/, '') + `/api/w/${B.code}/setup`, { headers: { authorization: `Bearer ${A.token}` } });
  check("A's token is refused at B's address", viaAddress.status === 401, String(viaAddress.status));
  const platform = await platformToken();
  check('a platform token is refused on school pages', (await call('GET', '/setup', undefined, platform)).status === 401);

  // Refresh tokens carry their school.
  check('refresh token starts with the school code', A.refreshToken?.startsWith(`${A.code}.`), A.refreshToken?.split('.')[0]);
  const refreshed = await call('POST', '/auth/refresh', { refreshToken: A.refreshToken });
  check('refresh stays in the school', refreshed.status === 200 && refreshed.data?.user?.workspace?.code === A.code, `${refreshed.status} ${refreshed.message}`);
  const forged = await call('POST', '/auth/refresh', { refreshToken: `${B.code}.${A.refreshToken.split('.')[1]}` });
  check("A's refresh secret does not work under B's code", forged.status === 401, `${forged.status}`);

  // One email / mobile signs in to one school only.
  const pw = 'TestPass2026x';
  const sharedEmail = `shared.${A.code}@example.test`;
  const uA = await call('POST', '/users', { fullName: 'Shared Person', email: sharedEmail, phone: `+91 9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, roleKey: 'office', password: pw }, A.token);
  check('user created in A', uA.status < 300, `${uA.status} ${uA.message}`);
  const uB = await call('POST', '/users', { fullName: 'Shared Person', email: sharedEmail, roleKey: 'office', password: pw }, B.token);
  check('the same email is refused in B', uB.status === 400 && uB.details?.[0]?.field === 'email', `${uB.status} ${uB.details?.[0]?.message ?? uB.message}`);
  const sameEmailPlatform = await call('POST', '/users', { fullName: 'X', email: A.adminEmail, roleKey: 'office', password: pw }, B.token);
  check("another school's admin email is refused", sameEmailPlatform.status === 400, `${sameEmailPlatform.status}`);
  const signIn = await call('POST', '/auth/login', { identifier: sharedEmail, password: pw, clientType: 'mobile' });
  check('the shared person signs in to A', signIn.data?.user?.workspace?.code === A.code, `${signIn.status} ${signIn.message}`);
  const usersA = await call('GET', '/users', undefined, A.token);
  check('the support account is hidden from the users list', !(usersA.data ?? []).some((u) => /support/.test(u.email)), `${usersA.data?.length} users`);

  // GPS devices: the token alone finds the school.
  const dev = await call('POST', '/devices', { deviceType: 'gps_tracker' }, A.token);
  check('device registered in A', !!dev.data?.token, `${dev.status} ${dev.message}`);
  const ping = await fetch(`${base}/tracking/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${dev.data?.token}` },
    body: JSON.stringify({ latitude: 12.8213, longitude: 80.0436, recordedAt: new Date().toISOString() }),
  });
  check('device location accepted without a school address', ping.status === 200 || ping.status === 201, String(ping.status));
  const seen = await A.db.trackingDevice.findFirst({ where: { deviceCode: dev.data?.device?.deviceCode } });
  check('the fix was recorded in A', !!seen?.lastSeenAt);
  const badDevice = await fetch(`${base}/tracking/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-device-token-1234567890' }, body: '{}' });
  check('an unknown device token gets a clear 4xx', badDevice.status >= 400 && badDevice.status < 500, String(badDevice.status));

  // School addresses for webhooks and public pages.
  const cfgA = await fetch(`${base}/w/${A.code}/public/config`).then((r) => r.json());
  check("/api/w/<code>/public/config is that school's", cfgA.data?.workspace?.code === A.code);
  const unknown = await fetch(`${base}/w/nosuchschool/public/config`);
  check('an unknown school address is 404', unknown.status === 404);
  const noSchool = await fetch(`${base}/gate/webhooks/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('a school webhook without a school address is a clear 400', noSchool.status === 400, String(noSchool.status));

  await A.db.$disconnect();
  await B.db.$disconnect();
  const n = failed();
  console.log(n ? `\n${n} check(s) failed` : '\nAll checks passed');
  process.exit(n ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
