// Monitoring (monitor.k12plus.app) database rules.
// A learner sees their own progress; teachers see their classes by name; a principal sees
// the school by name; champions and regional officials see their region without names;
// national officials see the whole country without names. Only learners with consent are
// counted, groups of fewer than five learners are hidden from officials, and every figure
// is checked against a count made separately in this file.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql',
  '20261031_pilot_evaluator_export.sql', '20261101_pilot_offline_lessons.sql', '20261102_pilot_ussd.sql', '20261103_plan_allowance.sql',
  '20261105_monitoring.sql'].map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 600)); } };

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@school.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, learner_uid) values ($1,$2,$3,$4,$5,$6)',
      [U[key], o.name || key, role, o.grade || null, 'Namibia', o.uid || null]);
  };
  const as = (who, sql, params = []) => db.transaction(async (tx) => {
    const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated';
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who === 'service' || who === 'anon' ? { role } : { sub: U[who], role })]);
    await tx.query(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
  const v = async (who, sql, params) => { try { return { v: Object.values((await as(who, sql, params))[0])[0] }; } catch (e) { return { err: e.message }; } };
  const consent = (b) => v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'Mrs Parent', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-09-01', ...b })]);

  await mk('admin', 'learner'); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  // Omusati (10): Tsandi rural with 6 learners in Grade 11 and 3 in Grade 12, Outapi urban with 5 in Grade 11.
  // Erongo (1): Karibib rural with 5 in Grade 11 and Swakopmund urban with none yet.
  const plan = { Tsandi: [10, 'rural', 6, 3], Outapi: [10, 'urban', 5, 0], Karibib: [1, 'rural', 5, 0], Swakopmund: [1, 'urban', 0, 0] };
  for (const [nm, [reg]] of Object.entries(plan)) S[nm] = (await db.query("insert into schools (name, region, country, region_id) values ($1, 'x', 'Namibia', $2) returning id", [nm + ' Secondary School', reg])).rows[0].id;
  const cls = {};
  for (const [reg, a, b] of [[10, 'Tsandi', 'Outapi'], [1, 'Karibib', 'Swakopmund']]) {
    const set = (await v('admin', 'select pilot_setup_region($1::smallint, $2::jsonb)', [reg, JSON.stringify([{ school_id: S[a], setting: plan[a][1] }, { school_id: S[b], setting: plan[b][1] }])])).v;
    for (const sc of set.schools) cls[sc.id] = sc.classes;
  }
  const C = (nm, g) => cls[S[nm]].find((c) => c.grade === g);

  await mk('tA', 'educator', { name: 'Ms Amutenya' }); await mk('tK', 'educator', { name: 'Mr Karibib' });
  await mk('principal', 'educator', { name: 'Mr Principal' });
  await db.query("update profiles set role = 'principal', school_id = $2 where id = $1", [U.principal, S.Tsandi]);
  await mk('champion', 'educator', { name: 'Ms Champion' });
  await mk('regional', 'educator', { name: 'Mr Regional Director' });
  await mk('national', 'educator', { name: 'Dr National' });
  await mk('ministry', 'educator', { name: 'Ministry Account' }); await db.query("update profiles set role = 'ministry' where id = $1", [U.ministry]);
  await mk('nobody', 'educator', { name: 'Ms Nobody' });
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [C('Tsandi', 11).id, 'tA@school.na']);
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [C('Karibib', 11).id, 'tK@school.na']);
  await v('admin', 'select pilot_set_champion(10::smallint, $1)', ['champion@school.na']);

  const L = [];
  const first = ['Ndapewa', 'Tomas', 'Selma', 'Petrus', 'Maria', 'Johannes', 'Hilma'];
  for (const [nm, [, , g11, g12]] of Object.entries(plan)) {
    await consent({ kind: 'school', school_id: S[nm], given_by_relation: 'principal' });
    for (const [grade, n] of [[11, g11], [12, g12]]) for (let i = 0; i < n; i++) {
      const key = `${nm}${grade}_${i}`;
      await mk(key, 'learner', { name: first[i % 7] + ' ' + nm + 'son', grade, uid: 'K12-NA-' + String(L.length).padStart(6, '0') });
      await v(key, 'select pilot_join_class($1)', [C(nm, grade).code]);
      await consent({ kind: 'guardian', learner_id: U[key] });
      L.push({ key, nm, grade, region: plan[nm][0], setting: plan[nm][1], cls: C(nm, grade).id });
    }
  }
  await mk('nocon', 'learner', { name: 'Hidden Learner', grade: 11, uid: 'K12-NA-HIDDEN' });
  await v('nocon', 'select pilot_join_class($1)', [C('Tsandi', 11).code]);
  const names = L.map((l) => first[Number(l.key.split('_')[1]) % 7] + ' ' + l.nm + 'son');

  // activity: a fixed pattern, so the expected figures can be counted here
  let ref = 0;
  const ev = (k, kind, at, o = {}) => db.query('insert into learning_events (learner_id, class_id, kind, subject, topic, correct, attempted, duration_seconds, client_ref, occurred_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [U[k], (L.find((x) => x.key === k) || { cls: C('Tsandi', 11).id }).cls, kind, o.subject || null, o.topic || null, o.correct ?? null, o.attempted ?? null, o.duration ?? null, 'm-' + String(++ref).padStart(6, '0'), at]);
  const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString();
  const E = []; // what was recorded, for the separate count
  for (const [i, l] of L.entries()) {
    const days = i % 3 === 0 ? 20 : 2; // every third learner was last active 20 days ago
    const alg = { correct: 4 + (i % 5), attempted: 10 }, geo = { correct: i % 4, attempted: 10 };
    await ev(l.key, 'practice', ago(days), { subject: 'Mathematics', topic: 'Algebra', ...alg });
    await ev(l.key, 'quiz', ago(days), { subject: 'Mathematics', topic: 'Geometry', ...geo });
    await ev(l.key, 'active', ago(days), { duration: 300 + 60 * i });
    await ev(l.key, 'question', ago(days), { subject: 'Mathematics' });
    await ev(l.key, 'data', ago(days)); // data records are not activity
    E.push({ ...l, days, att: 20, cor: alg.correct + geo.correct, sec: 300 + 60 * i, q: 1, geoCor: geo.correct, algCor: alg.correct });
  }
  // the unconsented learner's activity (should never be stored, but even if it were, it is never counted)
  await ev('nocon', 'practice', ago(1), { topic: 'Algebra', correct: 10, attempted: 10 });
  // tests: a baseline for Grade 11 at Tsandi
  const tid = (await db.query("insert into tests (code, grade, syllabus, form, purpose, title, status) values ('PILOT27-G11-A', 11, '6131', 'A', 'baseline', 'Baseline test', 'approved') returning id")).rows[0].id;
  const tsandi11 = E.filter((e) => e.nm === 'Tsandi' && e.grade === 11);
  for (const [i, e] of tsandi11.entries()) await db.query("insert into test_attempts (test_id, learner_id, class_id, mode, submitted_at, score, max_score) values ($1,$2,$3,'phone',now() - interval '30 days',$4,20)", [tid, U[e.key], e.cls, 8 + i]);

  const expect = (rows) => {
    const att = rows.reduce((a, r) => a + r.att, 0), cor = rows.reduce((a, r) => a + r.cor, 0);
    return { learners: rows.length, active_week: rows.filter((r) => r.days < 7).length, active_period: rows.length,
      minutes: Math.round(rows.reduce((a, r) => a + r.sec, 0) / 60), questions: rows.length, attempted: att, correct: cor,
      accuracy: att ? Math.round(100 * cor / att) : null };
  };
  const same = (got, rows) => { const x = expect(rows); return Object.keys(x).every((k) => Number(got[k]) === x[k] || (x[k] === null && got[k] == null)); };
  const has = (j, s) => JSON.stringify(j).includes(s);
  const noNames = (j) => !names.some((n) => has(j, n)) && !has(j, 'Hidden Learner');

  console.log('\n1. Officials are added by administrators only');
  let r = await v('nobody', "select monitor_add_official('regional@school.na', 10::smallint, 'Regional Director')");
  ok(r.err && /administrators/.test(r.err), 'a teacher cannot make anyone an official', r);
  r = await v('admin', "select monitor_add_official('Tsandi11_0@school.na', 10::smallint)");
  ok(r.err && /learner/.test(r.err), 'a learner cannot be made an official', r);
  r = await v('admin', "select monitor_add_official('nosuch@school.na', 10::smallint)");
  ok(r.err && /No account/.test(r.err), 'an unknown account is refused', r);
  r = await v('admin', "select monitor_add_official('regional@school.na', 10::smallint, 'Regional Director of Education')");
  ok(r.v && r.v.ok, 'a regional official for Omusati is added', r);
  r = await v('admin', "select monitor_add_official('national@school.na', null, 'Director, National Examinations')");
  ok(r.v && r.v.ok, 'a national official is added', r);
  r = await v('admin', 'select monitor_officials_list()');
  ok(r.v.length === 2 && r.v[0].region === 'National' && r.v[1].region === 'Omusati', 'the list shows both, national first', r);
  r = await v('regional', 'select monitor_officials_list()');
  ok(r.err, 'an official cannot see the list of officials', r);

  console.log('\n2. Each person sees the right views');
  const views = async (k) => ((await v(k, 'select monitor_whoami()')).v.views || []).map((x) => x.kind + (x.name ? ':' + x.name : ''));
  ok(JSON.stringify(await views('Tsandi11_0')) === JSON.stringify(['learner:My progress']), 'a learner: their own progress', await views('Tsandi11_0'));
  ok(JSON.stringify(await views('tA')) === JSON.stringify(['class:' + C('Tsandi', 11).name]), 'a teacher: their class', await views('tA'));
  ok(JSON.stringify(await views('principal')) === JSON.stringify(['school:Tsandi Secondary School']), 'a principal: their school', await views('principal'));
  ok(JSON.stringify(await views('champion')) === JSON.stringify(['region:Omusati']), 'a champion: their region', await views('champion'));
  ok(JSON.stringify(await views('regional')) === JSON.stringify(['region:Omusati']), 'a regional official: their region', await views('regional'));
  ok(JSON.stringify(await views('national')) === JSON.stringify(['country:Namibia']), 'a national official: the country', await views('national'));
  ok(JSON.stringify(await views('ministry')) === JSON.stringify(['country:Namibia']), 'a ministry account: the country', await views('ministry'));
  ok(JSON.stringify(await views('admin')) === JSON.stringify(['country:Namibia']) && (await v('admin', 'select monitor_whoami()')).v.admin, 'an administrator: the country, and can manage officials');
  ok((await views('nobody')).length === 0, 'a teacher with no class sees nothing');
  r = await v('anon', 'select monitor_whoami()');
  ok(r.err && /permission denied/.test(r.err), 'someone not signed in cannot call it', r);

  console.log('\n3. A learner\'s own progress');
  const me0 = E[0];
  r = await v(me0.key, 'select monitor_learner()');
  ok(r.v.taking_part && same(r.v, [me0]), 'figures match the separate count', { got: r.v, want: expect([me0]) });
  ok(r.v.topics[0].topic === 'Geometry' && r.v.topics[0].accuracy === Math.round(100 * me0.geoCor / 10), 'the weakest topic comes first', r.v.topics);
  ok(r.v.weekly.length === 12 && r.v.weekly.every((w) => new Date(w.week + 'T00:00:00Z').getUTCDay() === 1), 'twelve weeks, each starting on a Monday', r.v.weekly);
  ok(r.v.weekly.reduce((a, w) => a + w.attempted, 0) === 20, 'the weekly trend adds up to the total');
  ok(r.v.test_results.length === 1 && r.v.test_results[0].percent === 40 && r.v.tests.baseline.average === 40, 'the baseline test result is shown', r.v.test_results);
  r = await v(me0.key, 'select monitor_learner(null, 4)');
  ok(r.v.weekly.length === 4, 'a shorter period can be chosen');
  r = await v('nocon', 'select monitor_learner()');
  ok(r.v.taking_part === false && !r.v.weekly, 'a learner without consent sees that they are not taking part, and no figures', r);
  r = await v(me0.key, 'select monitor_learner($1::uuid)', [U[E[1].key]]);
  ok(r.err, 'a learner cannot open another learner', r);

  console.log('\n4. A teacher sees their class by name');
  const t11 = E.filter((e) => e.nm === 'Tsandi' && e.grade === 11);
  r = await v('tA', 'select monitor_class($1::uuid)', [C('Tsandi', 11).id]);
  ok(r.v.named && same(r.v, t11), 'class figures match (the unconsented learner is not counted)', { got: r.v, want: expect(t11) });
  ok(r.v.learner_rows.length === 6 && !has(r.v, 'Hidden Learner') && r.v.learner_rows.every((x) => names.includes(x.name)), 'six named learners, the unconsented learner left out', r.v.learner_rows);
  const row = r.v.learner_rows.find((x) => x.id === U[t11[2].key]);
  ok(row && same(row, [t11[2]]), 'each learner row matches', row);
  ok(r.v.tests.baseline.sat === 6 && r.v.tests.baseline.average === Math.round(100 * (8 + 9 + 10 + 11 + 12 + 13) / 120), 'class baseline average', r.v.tests);
  ok((await v('tA', 'select monitor_learner($1::uuid)', [U[t11[3].key]])).v.name === names[3], 'the teacher opens a learner in their class');
  ok((await v('tA', 'select monitor_learner($1::uuid)', [U[E.find((e) => e.nm === 'Karibib').key]])).err, 'but not a learner in another school');
  ok((await v('tA', 'select monitor_learner($1::uuid)', [U.nocon])).err, 'nor the learner without consent');
  ok((await v('tA', 'select monitor_class($1::uuid)', [C('Karibib', 11).id])).err, 'nor another teacher\'s class');
  ok((await v('tA', 'select monitor_school($1::uuid)', [S.Tsandi])).err, 'a teacher does not get the school view');
  ok((await v('tA', 'select monitor_region(10::smallint)')).err && (await v('tA', 'select monitor_country()')).err, 'nor region or country');

  console.log('\n5. A principal sees the school by name');
  const ts = E.filter((e) => e.nm === 'Tsandi');
  r = await v('principal', 'select monitor_school($1::uuid)', [S.Tsandi]);
  ok(r.v.named && same(r.v, ts), 'school figures match', { got: r.v, want: expect(ts) });
  const g12 = r.v.children.find((c) => c.grade === 12);
  ok(r.v.children.length === 2 && g12 && !g12.too_few && same(g12, ts.filter((e) => e.grade === 12)), 'both classes, the class of three shown to the principal', r.v.children);
  r = await v('principal', 'select monitor_class($1::uuid)', [C('Tsandi', 12).id]);
  ok(r.v.named && r.v.learner_rows.length === 3, 'the principal opens a class and sees names');
  ok((await v('principal', 'select monitor_learner($1::uuid)', [U[ts[7].key]])).v.taking_part, 'and a learner');
  ok((await v('principal', 'select monitor_school($1::uuid)', [S.Outapi])).err, 'but not another school');
  ok((await v('principal', 'select monitor_learner($1::uuid)', [U[E.find((e) => e.nm === 'Outapi').key]])).err, 'nor a learner in another school');

  console.log('\n6. A champion and a regional official see their region, without names');
  const om = E.filter((e) => e.region === 10);
  for (const who of ['champion', 'regional']) {
    r = await v(who, 'select monitor_region(10::smallint)');
    ok(same(r.v, om) && noNames(r.v), `${who}: region figures match, no learner names`, { got: r.v, want: expect(om) });
    ok(r.v.children.length === 2 && same(r.v.children.find((c) => c.name.startsWith('Outapi')), om.filter((e) => e.nm === 'Outapi')), `${who}: each pilot school`, r.v.children);
    ok(same(r.v.settings.rural, om.filter((e) => e.setting === 'rural')) && same(r.v.settings.urban, om.filter((e) => e.setting === 'urban')), `${who}: rural and urban`);
    r = await v(who, 'select monitor_school($1::uuid)', [S.Tsandi]);
    ok(!r.v.named && r.v.children.find((c) => c.grade === 12).too_few === true && r.v.children.find((c) => c.grade === 12).accuracy === undefined, `${who}: a class of three is hidden`, r.v.children);
    r = await v(who, 'select monitor_class($1::uuid)', [C('Tsandi', 11).id]);
    ok(!r.v.named && r.v.learner_rows === null && noNames(r.v) && same(r.v, t11), `${who}: a class shows figures, no names`, r.v);
    ok((await v(who, 'select monitor_learner($1::uuid)', [U[t11[0].key]])).err, `${who}: cannot open a learner`);
    ok((await v(who, 'select monitor_region(1::smallint)')).err && (await v(who, 'select monitor_country()')).err, `${who}: not another region, not the country`);
    ok((await v(who, 'select monitor_school($1::uuid)', [S.Karibib])).err, `${who}: not a school in another region`);
  }

  console.log('\n7. National officials see the whole country, without names');
  for (const who of ['national', 'ministry', 'admin']) {
    r = await v(who, 'select monitor_country()');
    ok(same(r.v, E) && noNames(r.v), `${who}: country figures match, no learner names`, { got: r.v, want: expect(E) });
    ok(r.v.children.length === 14 && same(r.v.children.find((c) => c.name === 'Erongo'), E.filter((e) => e.region === 1))
       && r.v.children.find((c) => c.name === 'Zambezi').learners === 0 && r.v.children.find((c) => c.name === 'Zambezi').too_few, `${who}: all 14 regions, empty ones hidden`, r.v.children);
    ok(r.v.settings.rural.learners + r.v.settings.urban.learners === E.length, `${who}: rural and urban add up`);
    ok(same((await v(who, 'select monitor_region(1::smallint)')).v, E.filter((e) => e.region === 1)), `${who}: opens any region`);
    ok((await v(who, 'select monitor_learner($1::uuid)', [U[t11[0].key]])).err, `${who}: cannot open a learner`);
    ok(noNames((await v(who, 'select monitor_class($1::uuid)', [C('Karibib', 11).id])).v), `${who}: classes without names`);
  }
  r = await v('national', 'select monitor_country()');
  ok(r.v.topics[0].topic === 'Geometry' && r.v.topics.every((t) => t.learners >= 1), 'the weakest topic nationally comes first', r.v.topics);
  ok(r.v.weekly.at(-1).active === E.filter((e) => e.days < 7 && new Date(Date.now() - e.days * 86400e3) >= new Date(r.v.weekly.at(-1).week + 'T00:00:00+02:00')).length
     || r.v.weekly.slice(-2).reduce((a, w) => a + w.active, 0) >= 1, 'recent weeks show the recent activity');

  console.log('\n8. Consent withdrawn: gone from every view at once');
  await v('admin', 'select pilot_withdraw_guardian_consent($1::uuid, $2)', [U[t11[0].key], 'Parent asked']);
  const t11b = t11.slice(1);
  ok(same((await v('tA', 'select monitor_class($1::uuid)', [C('Tsandi', 11).id])).v, t11b), 'the class no longer counts the learner');
  ok(same((await v('national', 'select monitor_country()')).v, E.filter((e) => e.key !== t11[0].key)), 'nor does the country');
  ok((await v(t11[0].key, 'select monitor_learner()')).v.taking_part === false, 'the learner sees that they are not taking part');
  ok((await v('tA', 'select monitor_learner($1::uuid)', [U[t11[0].key]])).err, 'the teacher can no longer open the learner');

  console.log('\n9. Removing an official removes access at once; tables and helpers are closed');
  await v('admin', 'select monitor_remove_official($1::uuid)', [U.regional]);
  ok((await v('regional', 'select monitor_region(10::smallint)')).err && (await views('regional')).length === 0, 'the removed official sees nothing');
  r = await v('national', 'select count(*) from monitor_officials');
  ok(r.err || Number(r.v) === 0, 'officials cannot read the officials table directly', r);
  for (const f of ['monitor_stats(array[]::uuid[], 12, true)', 'monitor_me()', "monitor_ids(null, null, null)", "monitor_mask('{}'::jsonb, true)"]) {
    r = await v('national', 'select ' + f);
    ok(r.err && /permission denied/.test(r.err), 'internal helper is closed: ' + f.split('(')[0], r);
  }
  ok((await v('nobody', 'select monitor_region(10::smallint)')).err && (await v('nobody', 'select monitor_country()')).err, 'someone with no access is refused');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
