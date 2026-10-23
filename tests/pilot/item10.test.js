// Item 10 acceptance tests: data export for the independent evaluator.
// "Done when: an evaluator could analyse the export without asking us what any column
//  means, and no learner can be identified from it."
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql',
  '20261031_pilot_evaluator_export.sql'].map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };
const NA = (s) => new Date(s + '+02:00').toISOString();

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@school.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, learner_uid, phone) values ($1,$2,$3,$4,$5,$6,$7)',
      [U[key], o.name || key, role, o.grade || null, 'Namibia', o.uid || null, o.phone || null]);
  };
  const as = (who, sql, params = []) => db.transaction(async (tx) => {
    const role = who === 'service' ? 'service_role' : 'authenticated';
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who === 'service' ? { role } : { sub: U[who], role })]);
    await tx.query(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
  const v = async (who, sql, params) => { try { return { v: Object.values((await as(who, sql, params))[0])[0] }; } catch (e) { return { err: e.message }; } };
  const consent = (b) => v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'Mrs Parent', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-09-01', ...b })]);
  await mk('admin', 'learner'); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('teacher', 'educator', { name: 'Ms Amutenya' });
  const names = [];
  // Omusati: Tsandi (rural, 6 + 3 learners) and Outapi (urban, 5 + 5); Erongo: Karibib (rural, 5 + 0) and Swakopmund (urban, 0 + 7)
  const plan = { Tsandi: [10, 'rural', 6, 3], Outapi: [10, 'urban', 5, 5], Karibib: [1, 'rural', 5, 0], Swakopmund: [1, 'urban', 0, 7] };
  for (const [nm, [reg]] of Object.entries(plan)) S[nm] = (await db.query("insert into schools (name, region, country, region_id) values ($1, 'x', 'Namibia', $2) returning id", [nm + ' Secondary School', reg])).rows[0].id;
  const cls = {};
  for (const [reg, a, b] of [[10, 'Tsandi', 'Outapi'], [1, 'Karibib', 'Swakopmund']]) {
    const set = (await v('admin', 'select pilot_setup_region($1::smallint, $2::jsonb)', [reg, JSON.stringify([{ school_id: S[a], setting: plan[a][1] }, { school_id: S[b], setting: plan[b][1] }])])).v;
    for (const sc of set.schools) cls[sc.id] = sc.classes;
  }
  const L = [];
  for (const [nm, [, , g11, g12]] of Object.entries(plan)) {
    await consent({ kind: 'school', school_id: S[nm], given_by_relation: 'principal' });
    for (const [grade, n] of [[11, g11], [12, g12]]) for (let i = 0; i < n; i++) {
      const key = `${nm}${grade}_${i}`;
      const name = ['Ndapewa', 'Tomas', 'Selma', 'Petrus', 'Maria', 'Johannes', 'Hilma'][i % 7] + ' ' + nm + 'son';
      names.push(name);
      await mk(key, 'learner', { name, grade, phone: '+26481' + String(L.length).padStart(7, '0'), uid: 'K12-NA-' + String(L.length).padStart(6, '0') });
      await v(key, 'select pilot_join_class($1)', [cls[S[nm]].find((c) => c.grade === grade).code]);
      await consent({ kind: 'guardian', learner_id: U[key] });
      L.push({ key, nm, grade, cls: cls[S[nm]].find((c) => c.grade === grade) });
    }
  }
  // one learner without consent, one whose consent is withdrawn later
  await mk('nocon', 'learner', { name: 'Hidden Learner', grade: 11, phone: '+264819999999', uid: 'K12-NA-HIDDEN' });
  await v('nocon', 'select pilot_join_class($1)', [cls[S.Tsandi].find((c) => c.grade === 11).code]);

  // activity: tests, events, a text, an agent exchange with free text
  const tid = {};
  for (const [code, grade, purpose] of [['PILOT27-G11-A', 11, 'baseline'], ['PILOT27-G12-A', 12, 'baseline']]) {
    tid[grade] = (await db.query("insert into tests (code, grade, syllabus, form, purpose, title, status) values ($1, $2, '6131', 'A', $3, 'Test', 'approved') returning id", [code, grade, purpose])).rows[0].id;
    for (let p = 1; p <= 3; p++) await db.query("insert into test_items (test_id, position, topic, sub_topic, question, kind, answer) values ($1, $2, $3, $4, 'Q', 'short', $5)", [tid[grade], p, 'Topic ' + p, grade === 11 ? 'Sub ' + p : null, String(p * 7)]);
  }
  await v('admin', "select pilot_set_test_window($1::uuid, null, now() - interval '1 day', now() + interval '1 day')", [tid[11]]);
  await v('admin', "select pilot_set_test_window($1::uuid, null, now() - interval '1 day', now() + interval '1 day')", [tid[12]]);
  const scores = {};
  for (const [i, l] of L.entries()) {
    const st = await v(l.key, 'select pilot_start_test($1::uuid)', [tid[l.grade]]);
    const items = st.v.items;
    const ans = { [items[0].id]: '7', [items[1].id]: i % 2 ? '14' : 'my secret answer', [items[2].id]: '' };
    await v(l.key, 'select pilot_submit_test($1::bigint, $2::jsonb)', [st.v.attempt_id, JSON.stringify(ans)]);
    scores[l.key] = 1 + (i % 2);
  }
  await db.query('update test_attempts set submitted_at = $1', [NA('2026-10-14T10:00:00')]); // sat in the week of 12 October
  let ref = 0;
  const ev = (k, kind, at, o = {}) => db.query('insert into learning_events (learner_id, class_id, kind, topic, attempted, duration_seconds, bytes, client_ref, occurred_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [U[k], L.find((x) => x.key === k).cls.id, kind, o.topic || null, o.attempted || null, o.duration || null, o.bytes || null, 'ex-' + String(++ref).padStart(6, '0'), at]);
  const K = L[0].key; // a learner with known activity in the week of Monday 5 October 2026
  await ev(K, 'question', NA('2026-10-06T15:00:00'), { topic: 'Algebra' });
  await ev(K, 'question', NA('2026-10-06T15:20:00'), { topic: 'Algebra' });
  await ev(K, 'practice', NA('2026-10-06T16:00:00'), { topic: 'Geometry', attempted: 6 });
  await ev(K, 'active', NA('2026-10-06T16:01:00'), { duration: 1500 });
  await ev(K, 'data', NA('2026-10-06T16:05:00'), { bytes: 2345678 });
  await ev(K, 'ussd', NA('2026-10-09T10:00:00'));
  await db.query("insert into message_log (recipient_kind, learner_id, channel, purpose, body, status, created_at, delivered_at) values ('learner', $1, 'sms', 'follow_up', 'Hi Ndapewa, try question 3', 'sent', $2, $2)", [U[K], NA('2026-10-07T16:00:00')]);
  await db.query("insert into agent_exchanges (learner_id, class_id, kind, question, reply) values ($1, $2, 'chat', 'My name is Ndapewa and I live in Tsandi', 'Hello Ndapewa')", [U[K], L[0].cls.id]);
  await db.query("update enrolments set enrolled_at = $1", [NA('2026-09-28T09:00:00')]);

  console.log('\n1. The export');
  ok(/administrators/.test((await v('teacher', "select pilot_evaluator_export('2026-09-28', '2026-10-18')")).err || ''), 'only K-12 EdTech administrators can export');
  let r = await v('admin', "select pilot_evaluator_export('2026-09-28', '2026-10-18')");
  const ex = r.v;
  const F = ex && ex.files;
  ok(F && ['learners.csv', 'test_scores.csv', 'test_items.csv', 'usage_weekly.csv', 'schools.csv', 'costs_monthly.csv'].every((f) => F[f]), 'one call gives six data files', ex ? Object.keys(F) : r.err);
  ok(ex.learners === L.length && F['learners.csv'].rows.length === L.length, `${L.length} learners with consent are included, and the learner without consent is not`);

  console.log('\n2. Every column is explained');
  const dict = ex.dictionary.map((d) => d[0] + '|' + d[1]);
  const cols = Object.entries(F).flatMap(([f, x]) => x.columns.map((c) => f + '|' + c));
  ok(cols.every((c) => dict.includes(c)), 'every column of every file has an entry in the data dictionary', cols.filter((c) => !dict.includes(c)));
  ok(dict.every((d) => cols.includes(d)), 'and the dictionary describes nothing that is not in the files', dict.filter((d) => !cols.includes(d)));
  ok(ex.dictionary.every((d) => ['text', 'integer', 'number', 'date'].includes(d[2]) && d[3].length >= 20), 'each entry gives the type and a plain description');
  ok(F['usage_weekly.csv'].columns.length === 11 && ex.rates && Number(ex.rates.budget_per_learner_usd) === 2.5, 'the export carries the prices and budget used for the costs (for the README)');

  console.log('\n3. No learner can be identified');
  const all = JSON.stringify(F);
  const pii = [...names, 'Hidden Learner', 'Mrs Parent', 'Ms Amutenya', '+26481', '26481', 'K12-NA-', '@school.na', 'Secondary School', 'secret answer', 'live in Tsandi', 'try question 3',
    ...Object.values(U), ...Object.values(cls).flat().map((c) => c.code)];
  const found = pii.filter((x) => all.includes(x));
  ok(found.length === 0, 'no names, phone numbers, K12Plus IDs, emails, account IDs, school names, class join codes or free text anywhere in the data', found.slice(0, 5));
  const lr = F['learners.csv'];
  const ci = (n) => lr.columns.indexOf(n);
  const small = lr.rows.filter((x) => x[ci('small_group')] === 1);
  ok(small.length === 3 && small.every((x) => x[ci('region')] === null && x[ci('setting')] === null && x[ci('school_code')] === null && x[ci('class_code')] === null),
    'the 3 Grade 12 learners at a school with fewer than 5 in that grade appear without region, setting, school or class', small);
  const groups = {};
  for (const x of lr.rows.filter((x) => x[ci('small_group')] === 0)) { const k = [x[ci('region')], x[ci('setting')], x[ci('school_code')], x[ci('grade')]].join('|'); groups[k] = (groups[k] || 0) + 1; }
  ok(Object.values(groups).every((n) => n >= 5), 'every group of learners described by region, setting, school and grade has at least 5 learners', groups);
  const sch = F['schools.csv'];
  const tsandi = sch.rows.find((x) => x[3] === 6);
  ok(sch.rows.length === 4 && tsandi && tsandi[4] === null && sch.rows.every((x) => /^S[0-9A-F]{5}$/.test(x[0])), 'schools appear only as codes, and a count of 1 to 4 learners is left blank', sch.rows);
  const dates = [...new Set(F['usage_weekly.csv'].rows.map((x) => x[1]))];
  ok(dates.every((d) => new Date(d + 'T00:00:00Z').getUTCDay() === 1) && lr.rows.every((x) => new Date(x[ci('enrolled_week')] + 'T00:00:00Z').getUTCDay() === 1), 'activity and enrolment are given by week (Mondays), not by time of day');
  r = await v('admin', 'select pilot_school_key()');
  ok(r.v.length === 4 && r.v.every((x) => /Secondary School/.test(x.school)), 'the key from school codes to school names is a separate download for K-12 EdTech only');
  ok(/administrators/.test((await v('teacher', 'select pilot_school_key()')).err || ''), 'nobody else can see the key');
  r = await v('admin', "select pilot_evaluator_export('2026-09-28', '2026-10-18')");
  ok(JSON.stringify(r.v.files['schools.csv'].rows.map((x) => x[0]).sort()) === JSON.stringify(sch.rows.map((x) => x[0]).sort()), 'school codes stay the same from one export to the next');

  console.log('\n4. The figures are right');
  const pidOf = async (k) => (await db.query('select pseudo_id from enrolments where learner_id = $1', [U[k]])).rows[0].pseudo_id;
  const pk = await pidOf(K);
  const ts = F['test_scores.csv'];
  const row = ts.rows.find((x) => x[0] === pk);
  ok(ts.rows.length === L.length && row && row[1] === 'PILOT27-G11-A' && row[2] === 'baseline' && row[4] === 'phone' && row[6] === scores[K] && row[7] === 3 && Number(row[8]) === Math.round(1000 * scores[K] / 3) / 10,
    'each submitted test has its score, out of how many, the percentage and how it was sat', row);
  const ti = F['test_items.csv'];
  const itemsK = ti.rows.filter((x) => x[0] === pk);
  ok(ti.rows.length === L.length * 3 && itemsK.length === 3 && itemsK[0][6] === 1 && itemsK[0][7] === 1 && itemsK[2][6] === 0 && itemsK[2][7] === 0 && itemsK[0][4] === 'Sub 1',
    'each question shows whether it was answered and whether it was right, with topic and sub-topic', itemsK);
  const uw = F['usage_weekly.csv'];
  const wk = uw.rows.find((x) => x[0] === pk && x[1] === '2026-10-05');
  ok(wk && wk[2] === 1 && wk[3] === 3 && wk[4] === 25 && wk[5] === 2 && wk[6] === 6 && wk[7] === 2 && wk[8] === 1 && Number(wk[9]) === 2.35 && wk[10] === 1,
    'the weekly figures for a learner match: 3 sessions, 25 minutes, 2 questions, 6 practice answers, 2 topics, 1 USSD session, 2.35 MB, 1 text', wk);
  const weeksK = uw.rows.filter((x) => x[0] === pk).map((x) => x[1]);
  ok(JSON.stringify(weeksK) === JSON.stringify(['2026-09-28', '2026-10-05', '2026-10-12']) && uw.rows.filter((x) => x[0] === pk && x[2] === 0).length === 2, 'every week from enrolment to the end of the period has a row, including weeks with no activity', weeksK);
  const cm = F['costs_monthly.csv'];
  const all2 = cm.rows.filter((x) => x[1] === 'ALL');
  ok(all2.length === 2 && all2.map((x) => x[0]).join() === '2026-09-01,2026-10-01' && all2[1][2] === L.length && all2[1][5] === 1, 'monthly costs come for each month and for the whole pilot', all2);

  console.log('\n5. Withdrawal');
  await v('admin', 'select pilot_withdraw_guardian_consent($1::uuid, $2)', [U[K], 'parent asked']);
  r = await v('admin', "select pilot_evaluator_export('2026-09-28', '2026-10-18')");
  ok(!JSON.stringify(r.v.files).includes(pk) && r.v.learners === L.length - 1, 'a learner whose consent is withdrawn is left out of the next export straight away');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
