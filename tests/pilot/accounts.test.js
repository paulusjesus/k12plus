// K12Plus Monitor, part 2: registrations, periods and account management (database rules).
//
// The people in this test:
//   admin      K-12 EdTech administrator (the whole country, can do everything)
//   national   a ministry official given country rights by the administrator
//   director   a regional director given rights for Omusati, allowed to give rights
//   principal  principal of Tsandi Secondary School (school rights by role)
//   deputy     a Tsandi teacher the principal makes a school manager
//   tA         teacher of the Tsandi Grade 11 pilot class (class rights by teaching)
//   tO         a teacher at Outapi, also in Omusati
//   tK         a teacher at Karibib, in Erongo
//   learners   at Tsandi, Outapi and Karibib, plus some who registered without a class
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql',
  '20261031_pilot_evaluator_export.sql', '20261101_pilot_offline_lessons.sql', '20261102_pilot_ussd.sql', '20261103_plan_allowance.sql',
  '20261105_monitoring.sql', '20261106_monitor_accounts.sql'].map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 700)); } };

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  // the live auth.users table has these columns; the stand-in needs them too
  await db.exec('alter table auth.users add column banned_until timestamptz, add column last_sign_in_at timestamptz, add column raw_app_meta_data jsonb');
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [o.email || key + '@school.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, class_letter, country, learner_uid, school_id, phone, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [U[key], o.name || key, role, o.grade || null, o.letter || null, o.country || 'Namibia', o.uid || null, o.school || null, o.phone || null, o.at || new Date()]);
  };
  const as = (who, sql, params = []) => db.transaction(async (tx) => {
    const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated';
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who === 'service' || who === 'anon' ? { role } : { sub: U[who], role })]);
    await tx.query(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
  const v = async (who, sql, params) => { try { return { v: Object.values((await as(who, sql, params))[0])[0] }; } catch (e) { return { err: e.message }; } };
  const consent = (b) => v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-09-01', ...b })]);

  await mk('admin', 'learner'); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  for (const [k, name, reg] of [['T', 'Tsandi Secondary School', 10], ['O', 'Outapi Secondary School', 10], ['K', 'Karibib Secondary School', 1], ['X', 'Oshakati Secondary School', 11]])
    S[k] = (await db.query("insert into schools (name, region, country, region_id) values ($1, 'x', 'Namibia', $2) returning id", [name, reg])).rows[0].id;
  const cls = {};
  for (const [reg, a, b] of [[10, 'T', 'O'], [1, 'K', 'X']]) {
    const set = (await v('admin', 'select pilot_setup_region($1::smallint, $2::jsonb)', [reg, JSON.stringify([{ school_id: S[a], setting: 'rural' }, { school_id: S[b], setting: 'urban' }])])).v;
    if (!set) continue;
    for (const sc of set.schools) for (const c of sc.classes) cls[sc.id + c.grade] = c;
  }
  await mk('national', 'educator', { name: 'Dr National' });
  await mk('director', 'educator', { name: 'Mr Director' });
  await mk('principal', 'educator', { name: 'Mrs Principal', school: S.T });
  await db.query("update profiles set role = 'principal' where id = $1", [U.principal]);
  await mk('deputy', 'educator', { name: 'Mr Deputy', school: S.T });
  await mk('tA', 'educator', { name: 'Ms Amutenya', school: S.T });
  await mk('tO', 'educator', { name: 'Mr Outapi', school: S.O });
  await mk('tK', 'educator', { name: 'Ms Karibib', school: S.K });
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [cls[S.T + 11].id, 'tA@school.na']);
  await consent({ kind: 'school', school_id: S.T, given_by_relation: 'principal' });

  // registrations: Tsandi 11A x 4, 11B x 3, 12A x 2 (one in the pilot class with consent, one without);
  // Outapi 10C x 6; Karibib 12A x 5; two Namibian learners with no school; one South African learner.
  const old = new Date(Date.now() - 200 * 86400e3), recent = new Date(Date.now() - 3 * 86400e3);
  let n = 0;
  const reg = async (sch, grade, letter, count, at) => { for (let i = 0; i < count; i++, n++) await mk('L' + n, 'learner', { name: 'Learner ' + n, grade, letter, school: S[sch], uid: 'K12-NA-' + String(n).padStart(6, '0'), at }); };
  await reg('T', 11, 'A', 4, old); await reg('T', 11, 'B', 3, recent); await reg('T', 12, 'A', 2, recent);
  await reg('O', 10, 'C', 6, recent); await reg('K', 12, 'A', 5, old);
  await mk('noschool1', 'learner', { name: 'No School One', grade: 9 }); await mk('noschool2', 'learner', { name: 'No School Two', grade: 9 });
  await mk('za', 'learner', { name: 'South African Learner', grade: 10, country: 'South Africa' });
  await mk('parent', 'parent', { name: 'A Parent', school: S.T });
  // pilot class: L0..L5 join Tsandi Grade 11 (only L0 to L4 get consent)
  for (let i = 0; i < 6; i++) {
    await db.query("update profiles set grade = 11 where id = $1", [U['L' + i]]);
    await v('L' + i, 'select pilot_join_class($1)', [cls[S.T + 11].code]);
    if (i < 5) await consent({ kind: 'guardian', learner_id: U['L' + i] });
  }

  console.log('\n1. Periods');
  for (const [g, len] of [['day', 30], ['week', 12], ['month', 12], ['quarter', 8], ['year', 5]]) {
    const r = await v('admin', 'select monitor_country($1)', [g]);
    ok(r.v && r.v.registrations.series.length === len && r.v.grain === g, `${g}: ${len} points`, r.err || r.v.registrations.series.length);
  }
  let r = await v('admin', "select monitor_country('month')");
  const months = r.v.registrations.series.map((x) => x.start);
  ok(months.every((m) => m.endsWith('-01')), 'months start on the first day', months);
  ok(r.v.registrations.series.at(-1).total === r.v.registrations.total, 'the running total ends at today\'s total');

  console.log('\n2. Registrations: numbers for every account, groups under five hidden for officials');
  const nat = 4 + 3 + 2 + 6 + 5 + 2 + 1 + 7; // learners with a school or none, parent, and staff (not the administrator, not South Africa)
  r = await v('admin', "select monitor_country('week')");
  ok(r.v.registrations.total === nat, 'the country counts every Namibian account', { got: r.v.registrations.total, want: nat });
  ok(r.v.registrations.learners === 22 && r.v.registrations.teachers === 6 && r.v.registrations.leaders === 1 && r.v.registrations.parents === 1, 'by role: learners, teachers, school leaders, parents', r.v.registrations);
  ok(r.v.registrations.by_grade['11'] === 7 && r.v.registrations.by_grade['12'] === 7 && r.v.registrations.by_grade['10'] === 6 && r.v.registrations.by_grade['9'] === 2, 'learners by grade', r.v.registrations.by_grade);
  ok(r.v.registrations.new_period === 3 + 2 + 6 + 2 + 1 + 7, 'new accounts in the last 12 weeks (the 9 created 200 days ago are not new)', r.v.registrations.new_period);
  ok(r.v.no_school === 2, 'learners who have not chosen a school are counted separately');
  const om = r.v.children.find((x) => x.name === 'Omusati'), er = r.v.children.find((x) => x.name === 'Erongo'), os = r.v.children.find((x) => x.name === 'Oshana');
  ok(om.registered.total === 13 + 7 && er.registered.total === 6, 'each region counts its schools\' accounts', { om: om.registered, er: er.registered });
  ok(os.registered.total === 0 && !os.registered.too_few, 'an empty region shows zero');
  r = await v('admin', "select monitor_region(10::smallint, 'week')");
  const tsandi = r.v.children.find((x) => x.name.startsWith('Tsandi'));
  ok(r.v.children.length === 2 && tsandi.registered.total === 9 + 1 + 3, 'schools in the region with accounts or in the pilot', r.v.children.map((x) => [x.name, x.registered]));
  r = await v('admin', "select monitor_school($1::uuid, 'week')", [S.T]);
  ok(JSON.stringify(r.v.reg_classes.map((c) => [c.grade, c.letter, c.learners ?? 'hidden'])) === JSON.stringify([[11, 'A', 'hidden'], [11, 'B', 'hidden'], [11, null, 'hidden'], [12, 'A', 'hidden']])
     || r.v.reg_classes.some((c) => c.too_few), 'officials do not see classes of fewer than five', r.v.reg_classes);
  r = await v('principal', "select monitor_school($1::uuid, 'week')", [S.T]);
  ok(r.v.named && r.v.reg_classes.find((c) => c.grade === 11 && c.letter === 'B').learners === 3 && r.v.registrations.total === 13, 'the principal sees every class count', r.v.reg_classes);
  r = await v('tA', "select monitor_class($1::uuid, 'week')", [cls[S.T + 11].id]);
  ok(r.v.registrations.joined === 6 && r.v.registrations.with_consent === 5, 'the class shows who joined and who has consent', r.v.registrations);
  ok(r.v.learner_rows.length === 5, 'learning figures still count consented learners only');

  console.log('\n3. Rights: who holds what');
  r = await v('admin', "select account_grant('national@school.na', 'country', null, true)");
  ok(r.v && r.v.ok, 'the administrator gives the national official country rights', r);
  r = await v('national', "select account_grant('director@school.na', 'region', '10', true)");
  ok(r.v && r.v.ok, 'the national official makes the director a manager for Omusati who may give rights', r);
  r = await v('director', "select account_grant('tK@school.na', 'region', '10')");
  ok(r.err && /another region/.test(r.err), 'the director cannot give Omusati rights to a teacher in Erongo', r);
  r = await v('director', "select account_grant('principal@school.na', 'region', '10', true)");
  ok(r.err && /only someone above/.test(r.err), 'the director cannot let others give region rights (only someone above the region can)', r);
  r = await v('principal', "select account_grant('deputy@school.na', 'school', $1)", [S.T]);
  ok(r.v && r.v.ok, 'the principal makes the deputy a school manager', r);
  r = await v('deputy', "select account_grant('tA@school.na', 'school', $1)", [S.T]);
  ok(r.err && /cannot give rights/.test(r.err), 'the deputy was not allowed to give rights, so cannot', r);
  r = await v('principal', "select account_grant('tO@school.na', 'school', $1)", [S.T]);
  ok(r.err && /does not belong to this school/.test(r.err), 'school rights only go to staff of that school', r);
  r = await v('principal', "select account_grant('L0@school.na', 'class', $1)", [cls[S.T + 11].id]);
  ok(r.err && /Only staff/.test(r.err), 'learners cannot be given rights', r);
  r = await v('tA', "select account_grant('deputy@school.na', 'class', $1)", [cls[S.T + 11].id]);
  ok(r.err, 'a teacher cannot give rights', r);
  r = await v('principal', "select account_grant('principal@school.na', 'school', $1)", [S.T]);
  ok(r.err && /own rights/.test(r.err), 'nobody changes their own rights', r);
  const who = await v('director', 'select monitor_whoami()');
  ok(who.v.manage.some((m) => m.scope === 'region' && m.name === 'Omusati Region' && m.can_grant) && who.v.views.some((x) => x.kind === 'region' && x.id === 10), 'the director now manages Omusati and sees it in Monitor', who.v);
  const dep = await v('deputy', 'select monitor_whoami()');
  ok(dep.v.views.some((x) => x.kind === 'school') && dep.v.manage.some((m) => m.scope === 'school' && !m.can_grant), 'the deputy sees the school, named, without giving rights', dep.v);

  console.log('\n4. Listing accounts');
  r = await v('tA', "select account_list('class', $1)", [cls[S.T + 11].id]);
  ok(r.v.total === 6 && r.v.rows.every((x) => x.role === 'learner') && r.v.learners_shown, 'the teacher lists the six learners in the class (with or without consent)', r.v && r.v.rows.map((x) => x.name));
  ok(r.v.rows.every((x) => x.can_manage), 'and can manage each of them');
  r = await v('principal', "select account_list('school', $1)", [S.T]);
  ok(r.v.total === 9 + 1 + 2 && r.v.rows.some((x) => x.role === 'parent') && !r.v.rows.some((x) => x.name === 'Mrs Principal'), 'the principal lists every account at the school except their own', r.v.rows.map((x) => x.name));
  r = await v('principal', "select account_list('school', $1, 'learner 1')", [S.T]);
  ok(r.v.rows.length >= 1 && r.v.rows.every((x) => x.name.toLowerCase().includes('learner 1')), 'search by name works', r.v.rows.map((x) => x.name));
  r = await v('principal', "select account_list('school', $1, null, 'educator')", [S.T]);
  ok(r.v.rows.length === 2 && r.v.rows.every((x) => x.role === 'educator'), 'filter by role works');
  r = await v('director', "select account_list('region', '10')");
  ok(r.v.rows.every((x) => !['learner', 'parent'].includes(x.role)) && r.v.rows.length === 4 && !r.v.learners_shown && r.v.counts.learners === 15, 'the director lists staff only, with the number of learners', r.v);
  r = await v('director', "select account_list('school', $1)", [S.T]);
  ok(r.v.rows.every((x) => x.role !== 'learner') && !r.v.learners_shown, 'even when the director opens a school, learners are not listed');
  r = await v('national', "select account_list('country')");
  ok(r.v.rows.every((x) => !['learner', 'parent'].includes(x.role)) && r.v.rows.some((x) => x.name === 'Ms Karibib'), 'the national official lists staff in every region');
  r = await v('admin', "select account_list('country', null, 'no school')");
  ok(r.v.rows.length === 2 && r.v.learners_shown, 'the administrator can find learners anywhere (for support)');
  r = await v('tO', "select account_list('school', $1)", [S.T]);
  ok(r.err && /do not manage/.test(r.err), 'a teacher from another school is refused', r);
  r = await v('L0', "select account_list('class', $1)", [cls[S.T + 11].id]);
  ok(r.err, 'a learner is refused');

  console.log('\n5. Editing accounts');
  r = await v('tA', "select account_update($1::uuid, $2::jsonb)", [U.L1, JSON.stringify({ name: 'Learner One Updated', class_letter: 'c' })]);
  ok(r.v && r.v.ok && (await db.query('select username, class_letter from profiles where id = $1', [U.L1])).rows[0].class_letter === 'C', 'the teacher corrects a learner\'s name and class letter', r);
  r = await v('tA', "select account_update($1::uuid, $2::jsonb)", [U.L7, JSON.stringify({ name: 'x y' })]);
  ok(r.err, 'but not a learner outside the class', r);
  r = await v('director', "select account_update($1::uuid, $2::jsonb)", [U.L1, JSON.stringify({ name: 'Changed by director' })]);
  ok(r.err, 'the director cannot edit a learner', r);
  r = await v('director', "select account_update($1::uuid, $2::jsonb)", [U.tO, JSON.stringify({ phone: '081 555 1234' })]);
  ok(r.v && r.v.ok, 'the director edits a teacher in the region', r);
  r = await v('principal', "select account_update($1::uuid, $2::jsonb)", [U.tA, JSON.stringify({ role: 'principal' })]);
  ok(r.err && /regional or national/.test(r.err), 'a principal cannot make another principal', r);
  r = await v('director', "select account_update($1::uuid, $2::jsonb)", [U.deputy, JSON.stringify({ role: 'hod' })]);
  ok(r.v && r.v.ok, 'the director makes the deputy a head of department', r);
  r = await v('deputy', "select account_update($1::uuid, $2::jsonb)", [U.principal, JSON.stringify({ name: 'Taken over' })]);
  ok(r.err, 'a deputy cannot edit the principal (as senior as they are)', r);
  r = await v('principal', "select account_update($1::uuid, $2::jsonb)", [U.L2, JSON.stringify({ school_id: S.O })]);
  ok(r.err && /school you manage/.test(r.err), 'a principal cannot move a learner to another school', r);
  r = await v('director', "select account_update($1::uuid, $2::jsonb)", [U.tO, JSON.stringify({ school_id: S.T })]);
  ok(r.v && r.v.ok, 'the director moves a teacher between two schools in the region', r);
  r = await v('director', "select account_update($1::uuid, $2::jsonb)", [U.national, JSON.stringify({ name: 'x' })]);
  ok(r.err, 'the director cannot edit the national official');
  r = await v('national', "select account_update($1::uuid, $2::jsonb)", [U.admin, JSON.stringify({ name: 'x' })]);
  ok(r.err, 'nobody edits the administrator');

  console.log('\n6. Steps for the account service: reset, switch off, create, logo');
  r = await v('tA', "select account_authorise('reset_password', $1::uuid)", [U.L3]);
  ok(r.v && r.v.ok && r.v.audit_id, 'the teacher may reset a learner\'s password', r);
  await v('service', "select account_finish($1::bigint, true, '{}'::jsonb)", [r.v.audit_id]);
  r = await v('tA', "select account_authorise('reset_password', $1::uuid)", [U.tO]);
  ok(r.err, 'but not a teacher\'s');
  r = await v('principal', "select account_authorise('disable', $1::uuid)", [U.tA]);
  ok(r.v && r.v.ok, 'the principal may switch off a teacher\'s account');
  r = await v('principal', "select account_authorise('create', null, $1::jsonb)", [JSON.stringify({ role: 'learner', name: 'New Learner', school_id: S.T, class_id: cls[S.T + 11].id, grade: 11, class_letter: 'b', phone: '0812223344' })]);
  ok(r.v && r.v.ok && /^K12-NA-[A-Z0-9]{6}$/.test(r.v.learner_uid) && r.v.email === r.v.learner_uid.toLowerCase() + '@learners.k12edu.io' && r.v.class_letter === 'B', 'creating a learner gives a k12plus ID and a private sign-in address', r);
  const newId = (await db.query("insert into auth.users (email) values ($1) returning id", [r.v.email])).rows[0].id;
  let f = await v('service', 'select account_finish($1::bigint, true, $2::jsonb)', [r.v.audit_id, JSON.stringify({ user_id: newId })]);
  const np = (await db.query('select p.username, p.role, p.school_id, e.status from profiles p left join enrolments e on e.learner_id = p.id where p.id = $1', [newId])).rows[0];
  ok(f.v && np && np.username === 'New Learner' && np.school_id === S.T && np.status === 'active', 'after the service creates the sign-in, the profile is written and the learner joins the class', { f, np });
  r = await v('tA', "select account_authorise('create', null, $1::jsonb)", [JSON.stringify({ role: 'educator', name: 'New Teacher', school_id: S.T })]);
  ok(r.err && /school managers/.test(r.err), 'a teacher cannot add teachers', r);
  r = await v('tA', "select account_authorise('create', null, $1::jsonb)", [JSON.stringify({ role: 'learner', name: 'Wrong Grade', school_id: S.T, class_id: cls[S.T + 11].id, grade: 12 })]);
  ok(r.err && /Grade 11/.test(r.err), 'a learner in the wrong grade for the class is refused before any account is made', r);
  r = await v('director', "select account_authorise('create', null, $1::jsonb)", [JSON.stringify({ role: 'learner', name: 'By Director', school_id: S.T })]);
  ok(r.err, 'the director cannot add learners', r);
  r = await v('director', "select account_authorise('create', null, $1::jsonb)", [JSON.stringify({ role: 'educator', name: 'New Teacher', school_id: S.O, email: 'new.teacher@school.na' })]);
  ok(r.v && r.v.email === 'new.teacher@school.na', 'the director adds a teacher with their own email address', r);
  r = await v('admin', "select account_authorise('create', null, $1::jsonb)", [JSON.stringify({ role: 'admin', name: 'Sneaky', school_id: S.T })]);
  ok(r.err && /learners or teachers/.test(r.err), 'no other kind of account can be created here');
  r = await v('tA', "select account_authorise('logo', null, $1::jsonb)", [JSON.stringify({ school_id: S.T })]);
  ok(r.err, 'a teacher cannot change the school logo');
  r = await v('principal', "select account_authorise('logo', null, $1::jsonb)", [JSON.stringify({ school_id: S.T })]);
  ok(r.v && r.v.ok, 'the principal can');
  await v('service', 'select account_finish($1::bigint, true, $2::jsonb)', [r.v.audit_id, JSON.stringify({ url: 'https://x/school-logos/t.png' })]);
  ok((await v('principal', 'select monitor_whoami()')).v.views.find((x) => x.kind === 'school').logo === 'https://x/school-logos/t.png', 'the logo is saved on the school');
  r = await v('principal', 'select account_finish(1, true)');
  ok(r.err && /permission denied/.test(r.err), 'only the service can finish a step');

  console.log('\n7. Removing rights and the history');
  const deputyRight = (await db.query("select id from account_rights where user_id = $1", [U.deputy])).rows[0].id;
  r = await v('deputy', 'select account_revoke($1::bigint)', [deputyRight]);
  ok(r.err && /own rights/.test(r.err), 'the deputy cannot remove their own right');
  r = await v('principal', 'select account_revoke($1::bigint)', [deputyRight]);
  ok(r.v && r.v.ok && !(await v('deputy', 'select monitor_whoami()')).v.manage.some((m) => m.source === 'given'), 'the principal removes it at once (the deputy keeps school rights only as head of department)');
  const dirRight = (await db.query("select id from account_rights where user_id = $1", [U.director])).rows[0].id;
  ok((await v('principal', 'select account_revoke($1::bigint)', [dirRight])).err, 'a principal cannot remove a regional right');
  r = await v('principal', "select account_history('school', $1)", [S.T]);
  const acts = r.v.map((x) => x.action);
  ok(['grant', 'revoke', 'edit', 'logo'].every((a) => acts.includes(a)) && r.v.every((x) => x.by) && !r.v.some((x) => x.details), 'the school history shows who did what, and never a password', acts);
  r = await v('tA', "select account_history('class', $1)", [cls[S.T + 11].id]);
  ok(r.v.some((x) => x.action === 'reset_password' && x.target === 'Learner 3') && r.v.some((x) => x.action === 'edit'), 'the class history shows the reset and the edit', r.v);

  r = await v('director', "select account_history('region', '10')");
  ok(r.v.length > 0 && !r.v.some((x) => /Learner/.test(x.target || '')) && r.v.some((x) => x.target === 'a learner'), 'the region history shows "a learner", never a learner\'s name', r.v.map((x) => x.target));
  const before = (await db.query('select count(*)::int n from account_audit')).rows[0].n;
  r = await v('principal', "select account_update($1::uuid, $2::jsonb)", [U.L2, JSON.stringify({ name: 'Learner 2' })]);
  ok(r.v.changed.length === 0 && (await db.query('select count(*)::int n from account_audit')).rows[0].n === before, 'saving without a change records nothing');

  console.log('\n8. Closed doors');
  for (const fn of ['account_scopes($1::uuid)', 'account_can_manage($1::uuid, $1::uuid)', 'account_seniority($1::uuid)', "monitor_reg(array[$1::uuid], 'week')", "monitor_stats(array[$1::uuid], 'week')"]) {
    r = await v('principal', 'select ' + fn, [U.tA]);
    ok(r.err && /permission denied/.test(r.err), 'internal helper closed: ' + fn.split('(')[0], r);
  }
  r = await v('principal', 'select count(*) from account_rights');
  ok(r.err || Number(r.v) === 0, 'the rights table cannot be read directly', r);
  r = await v('principal', 'select count(*) from account_audit');
  ok(r.err || Number(r.v) === 0, 'nor the history table', r);
  r = await v('anon', "select account_list('country')");
  ok(r.err && /permission denied/.test(r.err), 'nobody signed out gets anything');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
