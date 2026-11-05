// K12Plus Monitor, part 3: funders, how grants are used, and learners who need attention.
// Database rules on PGlite with every migration loaded; every figure is checked by hand.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql',
  '20261031_pilot_evaluator_export.sql', '20261101_pilot_offline_lessons.sql', '20261102_pilot_ussd.sql', '20261103_plan_allowance.sql',
  '20261105_monitoring.sql', '20261106_monitor_accounts.sql', '20261107_funders_attention.sql'].map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 700)); } };

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  await db.exec('alter table auth.users add column banned_until timestamptz, add column last_sign_in_at timestamptz, add column raw_app_meta_data jsonb');
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key.toLowerCase() + '@school.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, school_id) values ($1,$2,$3,$4,$5,$6)', [U[key], o.name || key, role, o.grade || null, 'Namibia', o.school || null]);
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
  for (const [k, name, reg] of [['T', 'Tsandi Secondary School', 10], ['O', 'Outapi Secondary School', 10]])
    S[k] = (await db.query("insert into schools (name, region, country, region_id) values ($1, 'x', 'Namibia', $2) returning id", [name, reg])).rows[0].id;
  const set = (await v('admin', 'select pilot_setup_region(10::smallint, $1::jsonb)', [JSON.stringify([{ school_id: S.T, setting: 'rural' }, { school_id: S.O, setting: 'urban' }])])).v;
  const cls = {}; for (const sc of set.schools) for (const c of sc.classes) cls[sc.id + c.grade] = c;
  await mk('teacher', 'educator', { name: 'Ms Amutenya', school: S.T });
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [cls[S.T + 11].id, 'teacher@school.na']);
  await mk('principalO', 'educator', { name: 'Mr Outapi', school: S.O }); await db.query("update profiles set role = 'principal' where id = $1", [U.principalO]);
  await mk('funderA', 'educator', { name: 'Ms Funder A' }); await mk('funderB', 'educator', { name: 'Mr Funder B' }); await mk('nobody', 'educator');
  for (const k of ['T', 'O']) await consent({ kind: 'school', school_id: S[k], given_by_relation: 'principal' });

  // Tsandi Grade 11: 6 learners. L0 inactive for 20 days, L1 accuracy 20%, L2 weak at Trigonometry, L3 low baseline, L4 and L5 fine.
  // Outapi Grade 11: 5 learners, all fine.
  let ref = 0;
  const ago = (d) => new Date(Date.now() - d * 86400e3).toISOString();
  const ev = (k, c, kind, at, o = {}) => db.query('insert into learning_events (learner_id, class_id, kind, topic, correct, attempted, bytes, client_ref, occurred_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [U[k], c, kind, o.topic || null, o.correct ?? null, o.attempted ?? null, o.bytes ?? null, 'f-' + String(++ref).padStart(6, '0'), at]);
  const names = [];
  for (const [sch, n] of [['T', 6], ['O', 5]]) for (let i = 0; i < n; i++) {
    const k = sch + i; names.push('Learner ' + k);
    await mk(k, 'learner', { name: 'Learner ' + k, grade: 11 });
    await v(k, 'select pilot_join_class($1)', [cls[S[sch] + 11].code]);
    await consent({ kind: 'guardian', learner_id: U[k] });
    const c = cls[S[sch] + 11].id;
    if (k === 'T0') { await ev(k, c, 'practice', ago(20), { topic: 'Algebra', correct: 8, attempted: 10 }); continue; }
    await ev(k, c, 'practice', ago(2), { topic: 'Algebra', correct: k === 'T1' ? 2 : 8, attempted: 10 });
    await ev(k, c, 'quiz', ago(2), { topic: 'Trigonometry', correct: k === 'T2' ? 1 : k === 'T1' ? 2 : 7, attempted: 10 });
    for (let j = 0; j < 5; j++) await ev(k, c, 'data', ago(2), { bytes: 100e6 }); // 0.5 GB each
  }
  const tid = (await db.query("insert into tests (code, grade, syllabus, form, purpose, title, status) values ('B', 11, '6131', 'A', 'baseline', 'Baseline', 'approved') returning id")).rows[0].id;
  await db.query("insert into test_attempts (test_id, learner_id, mode, submitted_at, score, max_score) values ($1,$2,'phone',now(),6,20)", [tid, U.T3]);
  await db.query("insert into learning_events (learner_id, class_id, kind, client_ref, occurred_at) values ($1, $2, 'ussd', 'u-1', now() - interval '1 day')", [U.O0, cls[S.O + 11].id]);

  console.log('\n1. Learners who need attention');
  let r = await v('teacher', "select monitor_attention_for('class', $1::uuid)", [cls[S.T + 11].id]);
  const by = Object.fromEntries((r.v.rows || []).map((x) => [x.name, x.reasons.join('; ')]));
  ok(r.v.named && r.v.count === 4, 'the teacher sees four learners who need attention, by name', r.v);
  ok(/not active for 20 days/.test(by['Learner T0']) && /practice accuracy 2\d%/.test(by['Learner T1']) && /struggling with Trigonometry/.test(by['Learner T2']) && /start of year test 30%/.test(by['Learner T3']),
    'each with the reason and where they struggle', by);
  ok(!by['Learner T4'] && !by['Learner T5'], 'learners doing well are not listed');
  ok(r.v.rows.find((x) => x.name === 'Learner T2').weak[0].topic === 'Trigonometry' && r.v.rows.find((x) => x.name === 'Learner T2').weak[0].accuracy === 10, 'the weak topic comes with its accuracy');
  r = await v('principalO', "select monitor_attention_for('school', $1::uuid)", [S.O]);
  ok(r.v.named && r.v.count === 0 && r.v.learners === 5, 'the Outapi principal: nobody needs attention');
  r = await v('principalO', "select monitor_attention_for('school', $1::uuid)", [S.T]);
  ok(r.err, 'and cannot open Tsandi\'s list');
  r = await v('admin', "select monitor_attention_for('class', $1::uuid)", [cls[S.T + 11].id]);
  ok(!r.v.named && r.v.count === 4 && !r.v.rows && !JSON.stringify(r.v).includes('Learner T') && r.v.topics.some((x) => x.topic === 'Trigonometry'), 'a national viewer sees the number and the topics, never names', r.v);
  r = await v('admin', "select monitor_attention_areas(10::smallint)");
  ok(r.v.length === 2 && r.v[0].name.startsWith('Tsandi') && r.v[0].share === 67 && r.v[1].share === 0, 'schools in the region ranked by the share needing attention (Tsandi 4 of 6)', r.v);
  r = await v('admin', 'select monitor_attention_areas()');
  ok(r.v.length === 1 && r.v[0].name === 'Omusati' && r.v[0].count === 4 && r.v[0].learners === 11, 'regions in Namibia ranked the same way', r.v);
  r = await v('teacher', 'select monitor_attention_areas()');
  ok(r.err, 'a teacher cannot rank the regions');

  console.log('\n2. Funders: people, grants, budget lines, expenses (administrator only)');
  r = await v('teacher', "select funds_admin('save_funder', '{\"name\":\"Sneaky\"}'::jsonb)");
  ok(r.err && /administrators/.test(r.err), 'only administrators can add funders');
  const FA = (await v('admin', "select funds_admin('save_funder', $1::jsonb)", [JSON.stringify({ name: 'Namibia Education Trust', website: 'https://example.org' })])).v.id;
  const FB = (await v('admin', "select funds_admin('save_funder', $1::jsonb)", [JSON.stringify({ name: 'Second Foundation' })])).v.id;
  ok(FA && FB, 'two funders are added');
  ok((await v('admin', "select funds_admin('add_person', $1::jsonb)", [JSON.stringify({ identifier: 'funderA@school.na', funder_id: FA })])).v.ok, 'a person is linked to the first funder');
  await v('admin', "select funds_admin('add_person', $1::jsonb)", [JSON.stringify({ identifier: 'funderB@school.na', funder_id: FB })]);
  r = await v('admin', "select funds_admin('add_person', $1::jsonb)", [JSON.stringify({ identifier: 'T4@school.na', funder_id: FA })]);
  ok(r.err && /learner/.test(r.err), 'a learner cannot be given funder access');
  const start = new Date(Date.now() - 60 * 86400e3).toISOString().slice(0, 10), end = new Date(Date.now() + 300 * 86400e3).toISOString().slice(0, 10);
  const GA = (await v('admin', "select funds_admin('save_grant', $1::jsonb)", [JSON.stringify({ funder_id: FA, title: 'Pilot 2027', currency: 'NAD', per_usd: 18, amount: 500000, starts_on: start, ends_on: end, running_costs: true })])).v.id;
  const GB = (await v('admin', "select funds_admin('save_grant', $1::jsonb)", [JSON.stringify({ funder_id: FB, title: 'Devices', currency: 'USD', amount: 10000, starts_on: start, ends_on: end })])).v.id;
  const L1 = (await v('admin', "select funds_admin('save_line', $1::jsonb)", [JSON.stringify({ grant_id: GA, category: 'Teacher training', planned: 120000 })])).v.id;
  await v('admin', "select funds_admin('save_line', $1::jsonb)", [JSON.stringify({ grant_id: GA, category: 'Regional champions', planned: 80000 })]);
  const d1 = new Date(Date.now() - 40 * 86400e3).toISOString().slice(0, 10), d2 = new Date(Date.now() - 5 * 86400e3).toISOString().slice(0, 10);
  await v('admin', "select funds_admin('add_expense', $1::jsonb)", [JSON.stringify({ grant_id: GA, budget_line_id: L1, spent_on: d1, amount: 30000, description: 'Training workshop, Oshakati', reference: 'INV-101' })]);
  await v('admin', "select funds_admin('add_expense', $1::jsonb)", [JSON.stringify({ grant_id: GA, budget_line_id: L1, spent_on: d2, amount: 12500, description: 'Champion travel' })]);
  r = await v('admin', "select funds_admin('add_expense', $1::jsonb)", [JSON.stringify({ grant_id: GB, budget_line_id: L1, spent_on: d2, amount: 10, description: 'Wrong line' })]);
  ok(r.err && /another grant/.test(r.err), 'an expense cannot use another grant\'s budget line');
  r = await v('admin', "select funds_admin('add_expense', $1::jsonb)", [JSON.stringify({ grant_id: GA, spent_on: '2099-01-01', amount: 10, description: 'Future' })]);
  ok(r.err && /future/.test(r.err), 'an expense cannot be in the future');
  await v('admin', "select funds_admin('add_expense', $1::jsonb)", [JSON.stringify({ grant_id: GB, spent_on: d2, amount: 2400, description: '20 tablets' })]);

  console.log('\n3. What each funder sees');
  // running costs: 10 learners used 0.5 GB each = 5 GB at US$1.20 = US$6.00, one USSD session US$0.03 → US$6.03 × 18 = N$108.54
  r = await v('funderA', 'select funds_overview()');
  const g = r.v.grants;
  ok(g.length === 1 && g[0].title === 'Pilot 2027' && g[0].funder === 'Namibia Education Trust', 'the first funder sees only its own grant', g.map((x) => x.title));
  const running = Number(g[0].lines.find((x) => x.automatic).spent);
  ok(Math.abs(running - 108.54) < 0.01, 'the pilot\'s running costs are worked out and converted to N$ (5 GB of data and one USSD session)', running);
  ok(Math.abs(Number(g[0].spent) - (42500 + 108.54)) < 0.01 && Math.abs(Number(g[0].remaining) - (500000 - 42608.54)) < 0.01 && g[0].used_pct === 9, 'spent, remaining and the share used', g[0]);
  const tt = g[0].lines.find((x) => x.category === 'Teacher training');
  ok(Number(tt.planned) === 120000 && Number(tt.spent) === 42500, 'each budget line shows planned against spent');
  ok(g[0].expenses.length === 2 && g[0].expenses[0].description === 'Champion travel' && g[0].expenses[1].reference === 'INV-101', 'every expense is listed, newest first');
  ok(g[0].learners === 11 && Math.abs(Number(g[0].per_learner) - Math.round(42608.54 / 11 * 100) / 100) < 0.01, 'cost per learner taking part', g[0].per_learner);
  ok(Number(g[0].monthly.at(-1).cumulative).toFixed(2) === Number(g[0].spent).toFixed(2), 'the monthly running total ends at the amount spent', g[0].monthly);
  ok(!r.v.funders, 'a funder does not see the list of other funders');
  r = await v('funderB', 'select funds_overview()');
  ok(r.v.grants.length === 1 && Number(r.v.grants[0].spent) === 2400 && !r.v.grants[0].lines.some((x) => x.automatic), 'the second funder sees its own grant, without the running costs');
  r = await v('funderA', 'select funds_overview($1::uuid)', [GB]);
  ok(r.v.grants.length === 0, 'a funder cannot open another funder\'s grant');
  r = await v('admin', 'select funds_overview()');
  ok(r.v.grants.length === 2 && r.v.funders.length === 2 && r.v.funders.find((f) => f.name === 'Second Foundation').people[0].name === 'Mr Funder B', 'the administrator sees every grant and funder');
  r = await v('nobody', 'select funds_overview()');
  ok(r.err && /funders and K-12 EdTech/.test(r.err), 'nobody else sees the funds');
  await v('admin', "select funds_admin('save_grant', $1::jsonb)", [JSON.stringify({ id: GB, funder_id: FB, title: 'Devices', currency: 'USD', amount: 10000, starts_on: start, ends_on: end, running_costs: true })]);
  ok((await db.query('select count(*)::int n from grants where running_costs')).rows[0].n === 1, 'only one grant pays the running costs at a time, so they are never counted twice');

  console.log('\n4. Funders in Monitor: the whole pilot, no names');
  r = await v('funderA', 'select monitor_whoami()');
  ok(r.v.views.some((x) => x.kind === 'country') && r.v.funds && r.v.funder.name === 'Namibia Education Trust' && r.v.title === 'Namibia Education Trust', 'the funder sees Namibia and the Funds page, under the funder\'s name', r.v);
  r = await v('funderA', "select monitor_country('week')");
  ok(r.v && !names.some((n) => JSON.stringify(r.v).includes(n)), 'the country view has no learner names');
  r = await v('funderA', "select monitor_class($1::uuid, 'week')", [cls[S.T + 11].id]);
  ok(r.v && !r.v.named && r.v.learner_rows === null, 'a class shows figures only');
  r = await v('funderA', 'select monitor_learner($1::uuid)', [U.T1]);
  ok(r.err, 'a funder cannot open a learner');
  r = await v('funderA', "select account_list('country')");
  ok(r.err, 'and has no say over accounts');
  await v('admin', "select funds_admin('remove_person', $1::jsonb)", [JSON.stringify({ user_id: U.funderA })]);
  r = await v('funderA', 'select monitor_whoami()');
  ok(!r.v.views.length && !r.v.funds, 'removed from the funder, the person sees nothing at once');

  console.log('\n5. Closed doors');
  for (const f of ["funds_running_costs(current_date, current_date)", 'monitor_attention(array[]::uuid[], \'week\')']) {
    r = await v('teacher', 'select ' + f);
    ok(r.err && /permission denied/.test(r.err), 'internal helper closed: ' + f.split('(')[0], r);
  }
  for (const t of ['funders', 'grants', 'expenses', 'budget_lines', 'funder_users']) {
    r = await v('funderB', 'select count(*) from ' + t);
    ok(r.err || Number(r.v) === 0, 'table closed to direct reading: ' + t, r);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
