// K12Plus Monitor, part 4: parents, coins on the server, monthly funder reports, and
// administrators no longer managing learner accounts. PGlite with every migration loaded.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql',
  '20261031_pilot_evaluator_export.sql', '20261101_pilot_offline_lessons.sql', '20261102_pilot_ussd.sql', '20261103_plan_allowance.sql',
  '20261105_monitoring.sql', '20261106_monitor_accounts.sql', '20261107_funders_attention.sql', '20261108_parents_coins_reports.sql']
  .map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 700)); } };

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  await db.exec('alter table auth.users add column banned_until timestamptz, add column last_sign_in_at timestamptz, add column raw_app_meta_data jsonb');
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [o.email || key.toLowerCase() + '@school.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, school_id, learner_uid, phone, linked_children) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [U[key], o.name || key, role, o.grade || null, 'Namibia', o.school || null, o.uid || null, o.phone || null, o.children || null]);
  };
  const as = (who, sql, params = []) => db.transaction(async (tx) => {
    const role = who === 'service' ? 'service_role' : 'authenticated';
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who === 'service' ? { role } : { sub: U[who], role })]);
    await tx.query(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
  const v = async (who, sql, params) => { try { return { v: Object.values((await as(who, sql, params))[0])[0] }; } catch (e) { return { err: e.message }; } };
  const consent = (b) => v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-09-01', ...b })]);

  await mk('admin', 'learner'); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  for (const [k, name] of [['T', 'Tsandi Secondary School'], ['O', 'Outapi Secondary School']])
    S[k] = (await db.query("insert into schools (name, region, country, region_id) values ($1, 'x', 'Namibia', 10) returning id", [name])).rows[0].id;
  const set = (await v('admin', 'select pilot_setup_region(10::smallint, $1::jsonb)', [JSON.stringify([{ school_id: S.T, setting: 'rural' }, { school_id: S.O, setting: 'urban' }])])).v;
  const cls = {}; for (const sc of set.schools) for (const c of sc.classes) cls[sc.id + c.grade] = c;
  await mk('teacher', 'educator', { name: 'Ms Amutenya', school: S.T });
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [cls[S.T + 11].id, 'teacher@school.na']);
  await mk('principalO', 'educator', { name: 'Mr Outapi', school: S.O }); await db.query("update profiles set role = 'principal' where id = $1", [U.principalO]);
  for (const k of ['T', 'O']) await consent({ kind: 'school', school_id: S[k], given_by_relation: 'principal' });
  for (let i = 0; i < 6; i++) {
    const k = 'T' + i;
    await mk(k, 'learner', { name: 'Learner ' + k, grade: 11, uid: 'K12-NA-' + k + 'AAAA' });
    await v(k, 'select pilot_join_class($1)', [cls[S.T + 11].code]);
    await consent({ kind: 'guardian', learner_id: U[k], guardian_phone: k === 'T0' ? '081 123 4567' : null });
  }
  await mk('O0', 'learner', { name: 'Learner O0', grade: 11, uid: 'K12-NA-O0AAAA' });
  await v('O0', 'select pilot_join_class($1)', [cls[S.O + 11].code]);
  await consent({ kind: 'guardian', learner_id: U.O0 });

  console.log('\n1. Learner accounts belong to their class and school');
  let r = await v('admin', "select account_authorise('reset_password', $1::uuid)", [U.T1]);
  ok(r.err && /cannot change/.test(r.err), 'the administrator can no longer reset a learner\'s password', r);
  r = await v('admin', "select account_authorise('disable', $1::uuid)", [U.T1]);
  ok(r.err && /cannot change/.test(r.err), 'or switch a learner\'s account off');
  r = await v('teacher', "select account_authorise('reset_password', $1::uuid)", [U.T1]);
  ok(r.v && r.v.ok, 'the class teacher still can', r);
  await v('service', 'select account_finish($1::bigint, true)', [r.v.audit_id]);
  r = await v('admin', "select account_authorise('create', null, $1::jsonb)", [JSON.stringify({ role: 'learner', name: 'New Learner', school_id: S.T, class_id: cls[S.T + 11].id, grade: 11 })]);
  ok(r.err && /cannot add learners/.test(r.err), 'the administrator cannot add learners', r);
  r = await v('admin', "select account_authorise('create', null, $1::jsonb)", [JSON.stringify({ role: 'educator', name: 'New Teacher', school_id: S.T })]);
  ok(r.v && r.v.ok, 'but still adds teachers', r);
  r = await v('admin', "select account_history('country')");
  ok(r.v.some((x) => x.target === 'a learner') && !r.v.some((x) => x.target === 'Learner T1'), 'in history, the administrator sees "a learner", not the name', r.v);
  r = await v('teacher', "select account_history('class', $1)", [cls[S.T + 11].id]);
  ok(r.v.some((x) => x.target === 'Learner T1'), 'the class teacher sees the name');

  console.log('\n2. Parents');
  await mk('P1', 'parent', { name: 'Mrs Nangolo', phone: '+264811234567', children: ['K12-NA-T0AAAA'] }); // phone matches the consent
  await mk('P2', 'parent', { name: 'Mr Haufiku', phone: '+264819999999', children: ['K12-NA-T1AAAA'] }); // no match
  await mk('P3', 'parent', { name: 'Someone Else', children: ['K12-NA-T2AAAA', 'K12-NA-NOPE00'] });
  await mk('P4', 'parent', { name: 'Ms Outapi Parent', children: ['K12-NA-O0AAAA'] });
  r = await v('P1', 'select monitor_whoami()');
  let kid = (r.v.views || []).find((x) => x.kind === 'child');
  ok(kid && kid.name === 'Learner T0' && kid.status === 'confirmed' && kid.taking_part, 'a parent whose phone matches the guardian consent is linked straight away', r.v.views);
  r = await v('P1', 'select monitor_learner($1::uuid)', [U.T0]);
  ok(r.v && r.v.taking_part && r.v.child && r.v.name === 'Learner T0', 'and sees the child\'s progress', r);
  ok(r.v.class_id == null && r.v.parents == null, 'without a link to the class, and without the list of parents');
  r = await v('P1', 'select monitor_learner($1::uuid)', [U.T4]);
  ok(r.err && /own children/.test(r.err), 'a parent cannot open another learner', r);
  r = await v('P1', 'select monitor_class($1::uuid)', [cls[S.T + 11].id]);
  ok(r.err, 'or the class');
  r = await v('P2', 'select monitor_whoami()');
  kid = (r.v.views || []).find((x) => x.kind === 'child');
  ok(kid && kid.status === 'waiting', 'a parent whose phone does not match waits for the school', r.v.views);
  ok(kid.name === 'K12-NA-T1AAAA' && JSON.stringify(r.v).indexOf('Learner T1') < 0, 'and sees only the K12Plus ID they typed, not the learner\'s name', kid);
  r = await v('P2', 'select monitor_learner($1::uuid)', [U.T1]);
  ok(r.err, 'and cannot open the child yet');
  r = await v('P3', 'select monitor_whoami()');
  ok(r.v.views.filter((x) => x.kind === 'child').length === 1, 'a K12Plus ID that does not exist is ignored', r.v.views);

  r = await v('teacher', 'select monitor_class($1::uuid)', [cls[S.T + 11].id]);
  ok(r.v.parents_waiting === 2, 'the class teacher sees that two parents are waiting', r.v.parents_waiting);
  r = await v('teacher', 'select monitor_learner($1::uuid)', [U.T1]);
  ok(r.v.parents.length === 1 && r.v.parents[0].name === 'Mr Haufiku' && r.v.parents[0].status === 'waiting', 'the learner\'s page lists the parent waiting', r.v.parents);
  r = await v('teacher', 'select monitor_learner($1::uuid)', [U.T0]);
  ok(r.v.parents[0].status === 'confirmed' && r.v.parents[0].by_phone, 'and shows a parent linked by the consent phone', r.v.parents);
  r = await v('principalO', 'select parent_link_decide($1::uuid, $2::uuid, true)', [U.P2, U.T1]);
  ok(r.err && /class teacher or school/.test(r.err), 'a principal of another school cannot confirm', r);
  r = await v('P2', 'select parent_link_decide($1::uuid, $2::uuid, true)', [U.P2, U.T1]);
  ok(r.err, 'a parent cannot confirm themselves');
  r = await v('teacher', 'select parent_link_decide($1::uuid, $2::uuid, true)', [U.P2, U.T1]);
  ok(r.v && r.v.ok, 'the class teacher confirms the parent', r);
  r = await v('P2', 'select monitor_learner($1::uuid)', [U.T1]);
  ok(r.v && r.v.taking_part && r.v.name === 'Learner T1', 'now the parent sees the child', r);
  r = await v('teacher', 'select parent_link_decide($1::uuid, $2::uuid, false)', [U.P3, U.T2]);
  ok(r.v && r.v.ok, 'the class teacher refuses someone who is not the parent');
  r = await v('P3', 'select monitor_whoami()');
  ok(!r.v.views.some((x) => x.kind === 'child'), 'a refused link disappears for that person', r.v.views);
  r = await v('teacher', 'select parent_link_decide($1::uuid, $2::uuid, true)', [U.P3, U.T3]);
  ok(r.err && /not named/.test(r.err), 'a teacher cannot link a parent to a child they did not name', r);
  r = await v('teacher', "select account_history('class', $1)", [cls[S.T + 11].id]);
  ok(r.v.some((x) => x.action === 'parent_confirmed') && r.v.some((x) => x.action === 'parent_refused'), 'both decisions are in the history', r.v.map((x) => x.action));
  r = await v('P4', 'select monitor_whoami()');
  ok(r.v.views[0].status === 'waiting', 'an Outapi parent waits for Outapi');
  r = await v('principalO', 'select parent_link_decide($1::uuid, $2::uuid, true)', [U.P4, U.O0]);
  ok(r.v && r.v.ok, 'and the Outapi principal can confirm', r);
  r = await v('admin', 'select parent_link_decide($1::uuid, $2::uuid, true)', [U.P2, U.T1]);
  ok(r.err, 'the administrator cannot confirm parents');

  console.log('\n3. Coins on the server');
  const today = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
  let n = 0; const id = () => 'ev-' + String(++n).padStart(6, '0');
  const sync = (who, evs) => v(who, 'select coins_sync($1::jsonb)', [JSON.stringify(evs)]);
  const prac = Array.from({ length: 7 }, () => ({ id: id(), why: 'practice', n: 60, day: today }));
  r = await sync('T4', prac);
  ok(r.v.balance === 300 && r.v.practice_today === 300 && r.v.done.length === 7, 'practice: at most 300 coins a day', r.v);
  r = await sync('T4', prac);
  ok(r.v.balance === 300, 'sending the same events again changes nothing');
  r = await sync('T4', [{ id: id(), why: 'practice', n: 500, day: '2026-01-01' }]);
  ok(r.v.balance === 360, 'an old day counts as a week ago at most, and one answer earns 60 at most', r.v.balance);
  const q = { id: id(), why: 'quiz', n: 35, once: 'quiz:Mathematics:' + today };
  r = await sync('T4', [q, { ...q, id: id() }]);
  ok(r.v.balance === 395 && r.v.once.includes(q.once), 'a quiz earns once', r.v);
  r = await sync('T4', [{ id: id(), why: 'quiz', n: 35 }]);
  ok(r.v.balance === 395, 'a quiz without its key earns nothing');
  const tid = (await db.query("insert into tests (code, grade, syllabus, form, purpose, title, status) values ('B', 11, '6131', 'A', 'baseline', 'Baseline', 'approved') returning id")).rows[0].id;
  const tev = { id: id(), why: 'test', n: 50, once: 'test:' + tid, at: Date.now() };
  r = await sync('T4', [tev]);
  ok(r.v.balance === 395 && !r.v.done.includes(tev.id), 'a test reward waits while the test is not on the server', r.v);
  await db.query("insert into test_attempts (test_id, learner_id, mode, submitted_at, score, max_score) values ($1,$2,'phone',now(),9,20)", [tid, U.T4]);
  r = await sync('T4', [{ ...tev, n: 500 }]);
  ok(r.v.balance === 445 && r.v.done.includes(tev.id), 'once the test is submitted, it earns exactly 50', r.v.balance);
  r = await sync('T4', [{ id: id(), why: 'test', n: 50, once: 'test:' + tid }]);
  ok(r.v.balance === 445, 'and only once');
  r = await sync('T4', [{ id: id(), why: 'test', n: 50, once: 'test:00000000-0000-0000-0000-000000000000', at: Date.now() - 20 * 86400e3 }]);
  ok(r.v.done.length === 1, 'a test reward older than two weeks that never arrived is dropped');
  r = await sync('T4', [{ id: id(), why: 'game', n: -30 }, { id: id(), why: 'game', n: -999 }, { id: id(), why: 'game', n: 40 }]);
  ok(r.v.balance === 415, 'a game costs 20, 25 or 30 coins; nothing else counts', r.v.balance);
  r = await sync('T5', [{ id: id(), why: 'game', n: -20 }]);
  ok(r.v.balance === 0, 'a learner without coins cannot spend them');
  r = await sync('T5', [{ id: id(), why: 'start', n: 2000 }, { id: id(), why: 'start', n: 100 }]);
  ok(r.v.balance === 500, 'coins from before the server are brought across once, 500 at most', r.v.balance);
  r = await sync('T5', [{ id: id(), why: 'bonus', n: 100 }, { id: 'bad id!', why: 'practice', n: 10 }]);
  ok(r.v.balance === 500, 'unknown reasons and bad ids count for nothing');
  r = await sync('teacher', [{ id: id(), why: 'practice', n: 10 }]);
  ok(r.v.balance === null, 'only learners keep coins');
  r = await v('T5', 'select count(*)::int from coin_events');
  ok(r.v === 1, 'a learner can read only her own coin records', r);
  r = await v('T4', 'select coins_state($1::uuid)', [U.T5]);
  ok(r.err, 'and cannot ask for another learner\'s purse');
  r = await v('teacher', 'select monitor_class($1::uuid)', [cls[S.T + 11].id]);
  ok(r.v.learner_rows.find((x) => x.name === 'Learner T4').coins === 415, 'the class teacher sees each learner\'s coins');
  r = await v('teacher', 'select monitor_learner($1::uuid)', [U.T4]);
  ok(r.v.coins.balance === 415 && r.v.coins.spent === 30 && r.v.coins.earned === 445, 'and on the learner\'s page, earned and spent', r.v.coins);
  r = await v('P2', 'select monitor_learner($1::uuid)', [U.T1]);
  ok(r.v.coins && r.v.coins.balance === 0, 'a parent sees their child\'s coins too');

  console.log('\n4. Monthly funder reports');
  await mk('funderA', 'educator', { name: 'Ms Funder A' }); await mk('funderB', 'educator', { name: 'Mr Funder B' });
  await mk('funderA2', 'educator', { name: 'Signin Only', email: 'k12-na-zzzz@staff.k12edu.io' });
  const FA = (await v('admin', "select funds_admin('save_funder', $1::jsonb)", [JSON.stringify({ name: 'Namibia Education Trust' })])).v.id;
  const FB = (await v('admin', "select funds_admin('save_funder', $1::jsonb)", [JSON.stringify({ name: 'Second Foundation' })])).v.id;
  await v('admin', "select funds_admin('save_funder', $1::jsonb)", [JSON.stringify({ name: 'Funder With Nobody' })]);
  await v('admin', "select funds_admin('add_person', $1::jsonb)", [JSON.stringify({ identifier: 'funderA@school.na', funder_id: FA })]);
  await v('admin', "select funds_admin('add_person', $1::jsonb)", [JSON.stringify({ identifier: 'k12-na-zzzz@staff.k12edu.io', funder_id: FA })]);
  await v('admin', "select funds_admin('add_person', $1::jsonb)", [JSON.stringify({ identifier: 'funderB@school.na', funder_id: FB })]);
  const start = new Date(Date.now() - 60 * 86400e3).toISOString().slice(0, 10), end = new Date(Date.now() + 300 * 86400e3).toISOString().slice(0, 10);
  await v('admin', "select funds_admin('save_grant', $1::jsonb)", [JSON.stringify({ funder_id: FA, title: 'Pilot 2027', currency: 'NAD', per_usd: 18, amount: 500000, starts_on: start, ends_on: end })]);
  await v('admin', "select funds_admin('save_grant', $1::jsonb)", [JSON.stringify({ funder_id: FB, title: 'Devices', currency: 'USD', amount: 10000, starts_on: start, ends_on: end })]);
  r = await v('funderA', 'select funds_build_reports_now()');
  ok(r.err && /Only K-12 EdTech/.test(r.err), 'a funder cannot build reports', r);
  r = await v('funderA', 'select funds_build_reports()');
  ok(r.err, 'or call the builder directly');
  r = await v('service', 'select funds_build_reports()');
  ok(r.v === 2, 'the monthly job builds one report for each funder that has people', r);
  r = await v('admin', 'select funds_build_reports_now()');
  ok(r.v === 2, 'an administrator can build them again; the same month is replaced, not doubled', r);
  r = await v('funderA', 'select funds_reports()');
  ok(r.v.length === 1 && r.v[0].funder === 'Namibia Education Trust' && r.v[0].email_status === 'waiting', 'a funder lists only their own reports', r.v);
  const RA = r.v[0].id;
  r = await v('funderA', 'select funds_report($1::bigint)', [RA]);
  const lastMonth = new Date(new Date(Date.now() + 2 * 3600e3).getUTCFullYear(), new Date(Date.now() + 2 * 3600e3).getUTCMonth() - 1, 1);
  ok(r.v.funder === 'Namibia Education Trust' && r.v.month.slice(0, 7) === `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`, 'the report is for last month', r.v.month);
  ok(r.v.grants.length === 1 && r.v.grants[0].title === 'Pilot 2027' && r.v.grants[0].expenses === undefined, 'it holds only this funder\'s grant, without the expense list', r.v.grants.map((g) => g.title));
  ok(r.v.pilot.learners === 7 && JSON.stringify(r.v).indexOf('Learner T') < 0, 'the pilot in numbers, with no learner names', r.v.pilot.learners);
  r = await v('admin', 'select funds_reports()');
  ok(r.v.length === 2, 'the administrator sees every report');
  r = await v('funderB', 'select funds_report($1::bigint)', [RA]);
  ok(r.err && /not found/.test(r.err), 'another funder cannot open it', r);
  r = await v('teacher', 'select funds_reports()');
  ok(r.err, 'nor can a teacher');
  r = await v('service', 'select funds_reports_to_send()');
  const forA = r.v.find((x) => x.id === RA);
  ok(r.v.length === 2 && forA.to.length === 1 && forA.to[0] === 'fundera@school.na', 'reports to send go to the funder\'s people, not made-up sign-in addresses', forA && forA.to);
  r = await v('funderA', 'select funds_reports_to_send()');
  ok(r.err, 'only the email service can ask for the list');
  await v('service', "select funds_report_mark($1::bigint, 'sent')", [RA]);
  r = await v('service', 'select funds_reports_to_send()');
  ok(r.v.length === 1, 'a sent report is not sent again');
  await v('service', 'select funds_build_reports()');
  r = await v('funderA', 'select funds_reports()');
  ok(r.v[0].email_status === 'sent', 'rebuilding keeps it marked as sent');
  r = await v('service', "select funds_cron_ok('x')");
  ok(r.v === false, 'the job secret is refused when it does not match');
  r = await v('funderA', "select funds_cron_ok('x')");
  ok(r.err, 'and only the email service can check it');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
