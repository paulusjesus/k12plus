// Item 3 acceptance tests: baseline and endline tests.
// "Done when: a full class can sit the test on phones and on paper, and all scores
//  appear in one place, linked to the right learner, class and school."
//
// The real questions are kept out of this public repository. These tests use a small
// stand-in test. If K12_TEST_BANK points to the generated seed.sql (with bank.json next
// to it), the real four tests are loaded too and every answer key is checked.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql'].map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@test.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, learner_uid, phone) values ($1,$2,$3,$4,$5,$6,$7)',
      [U[key], o.name || key, role, o.grade || null, 'Namibia', o.uid || null, o.phone || null]);
  };
  S.A = (await db.query("insert into schools (name, region, country) values ('Tsandi SS', 'Omusati (Tsandi)', 'Namibia') returning id")).rows[0].id;
  S.B = (await db.query("insert into schools (name, region, country) values ('Okahao SS', 'Omusati (Okahao)', 'Namibia') returning id")).rows[0].id;
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  await mk('admin', 'learner'); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('tA', 'educator', { name: 'Ms Amutenya' }); await mk('tB', 'educator', { name: 'Mr Other' }); await mk('tC', 'educator', { name: 'Ms Okahao' });
  const as = (who, sql, params = []) => db.transaction(async (tx) => {
    const role = who === 'service' ? 'service_role' : 'authenticated';
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who === 'service' ? { role } : { sub: U[who], role })]);
    await tx.query(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
  const v = async (who, sql, params) => { try { return { v: Object.values((await as(who, sql, params))[0])[0] }; } catch (e) { return { err: e.message }; } };
  const consent = (body) => v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20', ...body })]);

  // two pilot schools, each with a Grade 11 and a Grade 12 class
  const setup = (await v('admin', 'select pilot_setup_region(10::smallint, $1::jsonb)', [JSON.stringify([{ school_id: S.A, setting: 'rural' }, { school_id: S.B, setting: 'urban' }])])).v;
  const cls = (sid, g) => setup.schools.find((x) => x.id === sid).classes.find((c) => c.grade === g);
  const [a11, a12, b11] = [cls(S.A, 11), cls(S.A, 12), cls(S.B, 11)];
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [a11.id, 'tA@test.na']);
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [a12.id, 'tB@test.na']);
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [b11.id, 'tC@test.na']);
  await consent({ kind: 'school', school_id: S.A, given_by_relation: 'principal' });
  await consent({ kind: 'school', school_id: S.B, given_by_relation: 'principal' });
  // a full Grade 11 class: 30 learners with consent (20 sit on phones, 10 on paper) and one without consent
  const full = [];
  for (let i = 1; i <= 30; i++) {
    const k = 'L' + i; full.push(k);
    await mk(k, 'learner', { name: 'Learner ' + String(i).padStart(2, '0'), grade: 11, phone: '08112345' + String(i).padStart(2, '0'), uid: 'K12-NA-' + String(i).padStart(4, '0') });
    await v(k, 'select pilot_join_class($1)', [a11.code]);
    await consent({ kind: 'guardian', learner_id: U[k] });
  }
  await mk('noConsent', 'learner', { name: 'No Consent', grade: 11 }); await v('noConsent', 'select pilot_join_class($1)', [a11.code]);
  await mk('g12', 'learner', { name: 'Grade Twelve', grade: 12 }); await v('g12', 'select pilot_join_class($1)', [a12.code]); await consent({ kind: 'guardian', learner_id: U.g12 });
  await mk('okahao', 'learner', { name: 'Okahao Learner', grade: 11 }); await v('okahao', 'select pilot_join_class($1)', [b11.code]); await consent({ kind: 'guardian', learner_id: U.okahao });

  // the stand-in test: 6 questions over 3 topics, written as the real bank is (draft first)
  const T = (await db.query(`insert into tests (code, grade, syllabus, form, purpose, title, minutes)
    values ('T-G11-A', 11, '6131', 'A', 'baseline', 'Grade 11 mathematics: start of the year test', 75) returning id`)).rows[0].id;
  const items = [
    ['Numbers and operations', 'choice', '["1.5","15","0.15","1.2"]', 'A', '[]'],
    ['Numbers and operations', 'short', null, '1020', '[]'],
    ['Algebra', 'short', null, '-3/4', '["-0.75"]'],
    ['Algebra', 'short', null, '11', '[]'],
    ['Statistics and probability', 'short', null, '2.5', '[]'],
    ['Statistics and probability', 'short', null, '3/28', '["0.107","0.11"]'],
  ];
  const I = [];
  for (let i = 0; i < items.length; i++) {
    const [topic, kind, opts, ans, acc] = items[i];
    I.push((await db.query('insert into test_items (test_id, position, topic, question, kind, options, answer, accepted) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb) returning id',
      [T, i + 1, topic, 'Question ' + (i + 1), kind, opts, ans, acc])).rows[0].id);
  }
  const allRight = { [I[0]]: 'A', [I[1]]: '1020', [I[2]]: '-0.75', [I[3]]: '11', [I[4]]: '2.5', [I[5]]: '3/28' };
  const iso = (ms) => new Date(ms).toISOString();
  const H = 3600e3;

  console.log('\n1. Answers stay on the server');
  let r = await (async () => { try { return await as('L1', 'select * from test_items'); } catch (e) { return e.message; } })();
  ok(Array.isArray(r) ? r.length === 0 : /permission/.test(r), 'a learner cannot read the questions table (where the answers are)', r);
  r = await (async () => { try { return await as('tA', 'select * from test_responses'); } catch (e) { return e.message; } })();
  ok(Array.isArray(r) ? r.length === 0 : /permission/.test(r), 'nobody reads or writes the answer tables directly');
  r = await v('L1', 'select pilot_test_preview($1::uuid)', [T]);
  ok(/administrators/.test(r.err || ''), 'only K-12 EdTech administrators can see the answer key', r);

  console.log('\n2. Draft, approval and test dates');
  r = await v('admin', 'select pilot_set_test_window($1::uuid, null, now(), now() + interval \'1 day\')', [T]);
  ok(/Approve the test/.test(r.err || ''), 'a draft test cannot be opened', r);
  r = await v('tA', 'select pilot_approve_test($1::uuid)', [T]);
  ok(/administrators/.test(r.err || ''), 'a teacher cannot approve a test', r);
  r = await v('admin', 'select pilot_approve_test($1::uuid)', [T]);
  ok(r.v && r.v.ok, 'an administrator approves the test', r);
  r = await v('admin', 'select pilot_set_test_window($1::uuid, $2::uuid, now() + interval \'1 day\', now() + interval \'2 days\')', [T, S.A]);
  ok(r.v && r.v.schools === 1, 'test dates can be set for one school', r);
  r = await v('L1', 'select pilot_my_tests()');
  ok(r.v.length === 1 && r.v[0].open === false && r.v[0].questions === 6, 'the learner sees the test before it opens, marked as not open yet', r.v);
  r = await v('L1', 'select pilot_start_test($1::uuid)', [T]);
  ok(/not open yet/.test(r.err || ''), 'it cannot be started before it opens', r);
  r = await v('okahao', 'select pilot_my_tests()');
  ok(r.v.length === 0, 'a learner at a school without test dates does not see it', r.v);
  r = await v('admin', 'select pilot_set_test_window($1::uuid, null, now() - interval \'1 hour\', now() + interval \'1 day\')', [T]);
  ok(r.v && r.v.schools === 2, 'or for every pilot school at once (both schools here)', r);

  console.log('\n3. Consent and grade come first');
  r = await v('noConsent', 'select pilot_my_tests()');
  ok(r.v.length === 0, 'a learner without parent or guardian consent sees no test', r.v);
  r = await v('noConsent', 'select pilot_start_test($1::uuid)', [T]);
  ok(/taking part/.test(r.err || ''), 'and cannot start one', r);
  r = await v('g12', 'select pilot_start_test($1::uuid)', [T]);
  ok(/Grade 11/.test(r.err || ''), 'a Grade 12 learner cannot sit the Grade 11 test', r);

  console.log('\n4. Sitting the test on a phone, in two sittings');
  r = await v('L1', 'select pilot_start_test($1::uuid)', [T]);
  const att1 = r.v.attempt_id;
  ok(r.v.items.length === 6 && !JSON.stringify(r.v.items).includes('"answer"') && !JSON.stringify(r.v.items).includes('accepted') && !JSON.stringify(r.v).includes('1020'),
    'the phone receives the questions without any answers', r.v.items[0]);
  ok((await v('L1', 'select pilot_my_test_lock()')).v === true && (await v('L2', 'select pilot_my_test_lock()')).v === false,
    'while the test is open on the phone, the agent lock is on for that learner only');
  r = await v('L1', 'select pilot_save_answers($1::bigint, $2::jsonb)', [att1, JSON.stringify({ [I[0]]: 'a', [I[1]]: 'N$ 1 020' })]);
  ok(r.v && r.v.saved === 2, 'answers are saved as the learner goes', r);
  r = await v('L1', 'select pilot_start_test($1::uuid)', [T]);
  ok(r.v.attempt_id === att1 && r.v.saved[I[1]] === 'N$ 1 020', 'a second sitting continues the same attempt with the saved answers', r.v.saved);
  r = await v('L2', 'select pilot_save_answers($1::bigint, $2::jsonb)', [att1, JSON.stringify({ [I[0]]: 'B' })]);
  ok(/not found/.test(r.err || ''), "a learner cannot save into someone else's test", r);
  r = await v('L1', 'select pilot_submit_test($1::bigint, $2::jsonb)', [att1, JSON.stringify({ [I[2]]: '−3/4', [I[3]]: 'x = 11', [I[4]]: '2.50 m/s²', [I[5]]: '0.2' })]);
  const a1 = (await db.query('select score, max_score, mode, class_id from test_attempts where id = $1', [att1])).rows[0];
  ok(r.v.submitted && a1.score === 5 && a1.max_score === 6 && a1.mode === 'phone' && a1.class_id === a11.id,
    'marking is fair: "a" for A, "N$ 1 020" for 1020, "−3/4" for -3/4, "x = 11", "2.50 m/s²" for 2.5; 0.2 for 3/28 is wrong', a1);
  ok(!JSON.stringify(r.v).includes('score'), 'the learner is not shown the score or answers after submitting', r.v);
  r = await v('L1', 'select pilot_save_answers($1::bigint, $2::jsonb)', [att1, JSON.stringify({ [I[5]]: '3/28' })]);
  ok(/already submitted/.test(r.err || ''), 'answers cannot be changed after submitting', r);
  ok((await v('L1', 'select pilot_my_test_lock()')).v === false, 'the agent is back as soon as the test is submitted');
  r = await v('L1', 'select pilot_start_test($1::uuid)', [T]);
  ok(/already submitted/.test(r.err || ''), 'the test cannot be sat twice', r);

  console.log('\n5. A full class: 20 on phones and 10 on paper');
  const variants = (i) => ({ [I[0]]: i % 4 === 0 ? 'B' : 'A', [I[1]]: i % 3 === 0 ? '1,020' : '1020', [I[2]]: '-3/4', [I[3]]: i % 5 === 0 ? '12' : '11', [I[4]]: '5/2', [I[5]]: i % 2 ? '0.107' : '6/56' });
  const expect = (i) => 6 - (i % 4 === 0 ? 1 : 0) - (i % 5 === 0 ? 1 : 0);
  let phoneOk = true;
  for (let i = 2; i <= 20; i++) {
    const k = 'L' + i;
    const s = await v(k, 'select pilot_start_test($1::uuid)', [T]);
    const sub = await v(k, 'select pilot_submit_test($1::bigint, $2::jsonb)', [s.v.attempt_id, JSON.stringify(variants(i))]);
    const got = (await db.query('select score from test_attempts where id = $1', [s.v.attempt_id])).rows[0].score;
    if (!sub.v || got !== expect(i)) { phoneOk = false; console.log('   ', k, sub, got, expect(i)); }
  }
  ok(phoneOk, '19 more learners sit it on phones; each score is exactly right (including 1,020 and 6/56)');
  r = await v('tB', 'select pilot_enter_paper($1::uuid, $2::uuid, $3::jsonb)', [T, U.L21, JSON.stringify(allRight)]);
  ok(/teachers/.test(r.err || ''), "a teacher of another class cannot enter this class's paper answers", r);
  r = await v('tA', 'select pilot_enter_paper($1::uuid, $2::uuid, $3::jsonb)', [T, U.L1, JSON.stringify(allRight)]);
  ok(/phone/.test(r.err || ''), 'paper answers cannot overwrite a test sat on a phone', r);
  r = await v('tA', 'select pilot_enter_paper($1::uuid, $2::uuid, $3::jsonb)', [T, U.noConsent, JSON.stringify(allRight)]);
  ok(/does not take part/.test(r.err || ''), 'paper answers are refused for a learner without consent', r);
  r = await v('tA', 'select pilot_paper_version($1::uuid)', [T]);
  ok(r.v && r.v.items.length === 6 && !JSON.stringify(r.v).includes('1020') && !JSON.stringify(r.v).includes('"answer"'), 'the teacher prints a paper version without the answers', r.v && r.v.items[0]);
  ok(/teachers/.test((await v('L2', 'select pilot_paper_version($1::uuid)', [T])).err || ''), 'a learner cannot get the paper version');
  let paperOk = true;
  for (let i = 21; i <= 30; i++) {
    const ans = variants(i);
    if (i === 30) { delete ans[I[4]]; delete ans[I[5]]; } // left two blank on paper
    const e = await v('tA', 'select pilot_enter_paper($1::uuid, $2::uuid, $3::jsonb)', [T, U['L' + i], JSON.stringify(ans)]);
    const want = expect(i) - (i === 30 ? 2 : 0);
    if (!e.v || e.v.score !== want || e.v.max !== 6) { paperOk = false; console.log('   ', i, e, want); }
  }
  ok(paperOk, '10 learners without a device sit it on paper; their teacher types the answers and each is marked the same way');
  r = await v('tA', 'select pilot_enter_paper($1::uuid, $2::uuid, $3::jsonb)', [T, U.L21, JSON.stringify({ [I[3]]: '11' })]);
  ok(r.v && r.v.score === expect(21) + (21 % 5 === 0 ? 1 : 0), 'a typing mistake in paper answers can be corrected', r);
  r = await v('L21', 'select pilot_start_test($1::uuid)', [T]);
  ok(/paper/.test(r.err || ''), 'a learner whose paper test was entered cannot also sit it on a phone', r);

  console.log('\n6. All scores in one place');
  r = await v('tA', 'select pilot_class_tests($1::uuid)', [a11.id]);
  const ct = r.v && r.v[0];
  const sub = ct ? ct.learners.filter((l) => l.status === 'submitted') : [];
  ok(ct && ct.learners.length === 30 && sub.length === 30 && sub.filter((l) => l.mode === 'paper').length === 10 && !ct.learners.some((l) => l.name === 'No Consent'),
    "the teacher sees all 30 learners taking part, each submitted, 10 on paper (and not the learner without consent)", ct && ct.learners.length);
  const l1row = ct.learners.find((l) => l.id === U.L1);
  ok(l1row && l1row.score === 5 && l1row.max === 6, "each learner's score is linked to the right learner in the teacher's view", l1row);
  ok(ct.topics.length === 3 && ct.topics.every((tp) => tp.answered > 0), 'the teacher sees results by topic', ct.topics);
  ok(/teachers/.test((await v('tC', 'select pilot_class_tests($1::uuid)', [a11.id])).err || ''), "a teacher at another school cannot see this class's scores");
  r = await v('admin', 'select pilot_test_scores($1::uuid)', [T]);
  const rows = r.v || [];
  const pseudo = (await db.query('select learner_id, pseudo_id from enrolments')).rows.reduce((m, x) => (m[x.learner_id] = x.pseudo_id, m), {});
  const row1 = rows.find((x) => x.pseudo_id === pseudo[U.L1]);
  ok(rows.length === 30 && row1 && row1.score === 5 && row1.school === 'Tsandi SS' && row1.class === a11.name && row1.setting === 'rural' && row1.mode === 'phone',
    'K-12 EdTech sees every score in one list, linked to the learner (pilot ID), class and school', row1);
  const txt = JSON.stringify(rows);
  ok(!txt.includes('Learner 0') && !txt.includes('081123') && !txt.includes('K12-NA-'), 'the score list has pilot IDs only: no names, phone numbers or K12Plus IDs');
  ok(rows.filter((x) => x.mode === 'paper').length === 10 && row1.topics['Algebra'] === '2/2', 'it shows how each score was sat, and the score for every topic', row1.topics);
  ok(/administrators/.test((await v('tA', 'select pilot_test_scores($1::uuid)', [T])).err || ''), 'teachers cannot see the national score list');
  r = await v('admin', 'select pilot_tests_admin()');
  ok(r.v[0].submitted === 30 && r.v[0].windows === 2 && r.v[0].topics === 3, 'the administrator overview counts submissions, schools and topics', r.v[0]);

  console.log('\n7. Weak signal and closing time');
  await mk('late', 'learner', { name: 'Late Learner', grade: 11 }); await v('late', 'select pilot_join_class($1)', [a11.code]); await consent({ kind: 'guardian', learner_id: U.late });
  const sl = await v('late', 'select pilot_start_test($1::uuid)', [T]);
  await db.query("update test_windows set closes_at = now() - interval '1 hour' where test_id = $1", [T]);
  r = await v('late', 'select pilot_submit_test($1::bigint, $2::jsonb)', [sl.v.attempt_id, JSON.stringify(allRight)]);
  ok(r.v && r.v.submitted, 'answers saved offline before closing are accepted up to 2 hours after the test closes', r);
  ok((await v('late', 'select pilot_my_test_lock()')).v === false, 'the agent lock ends when the test closes');
  await mk('tooLate', 'learner', { name: 'Too Late', grade: 11 }); await v('tooLate', 'select pilot_join_class($1)', [a11.code]); await consent({ kind: 'guardian', learner_id: U.tooLate });
  r = await v('tooLate', 'select pilot_start_test($1::uuid)', [T]);
  ok(/closed/.test(r.err || ''), 'a new test cannot be started after closing', r);
  await db.query("update test_windows set closes_at = now() - interval '3 hours', opens_at = now() - interval '5 hours' where test_id = $1", [T]);
  r = await v('tA', 'select pilot_enter_paper($1::uuid, $2::uuid, $3::jsonb)', [T, U.tooLate, JSON.stringify(allRight)]);
  ok(r.v && r.v.score === 6, 'paper answers can still be entered after the test closes', r);
  await db.query("update test_windows set closes_at = now() - interval '15 days', opens_at = now() - interval '16 days' where test_id = $1", [T]);
  r = await v('tA', 'select pilot_enter_paper($1::uuid, $2::uuid, $3::jsonb)', [T, U.L30, JSON.stringify(allRight)]);
  ok(/14 days/.test(r.err || ''), 'but not more than 14 days after it closes', r);

  console.log('\n8. Withdrawal removes test answers');
  await v('tA', 'select pilot_withdraw_guardian_consent($1::uuid, $2)', [U.L2, 'parent asked']);
  const rem = (await db.query('select id from data_removals where learner_id = $1', [U.L2])).rows[0].id;
  r = await v('admin', 'select pilot_remove_data($1::bigint)', [rem]);
  const left = (await db.query('select count(*)::int n from test_attempts where learner_id = $1', [U.L2])).rows[0].n;
  ok(r.v && r.v.ok && left === 0, "removing a learner's pilot data removes their test answers too", { r, left });
  r = await v('admin', 'select pilot_test_scores($1::uuid)', [T]);
  ok(r.v.length === 31 && !r.v.some((x) => x.pseudo_id === pseudo[U.L2]), 'and they no longer appear in the score list', r.v.length);

  console.log('\n9. Marking rules on their own');
  const same = async (a, b) => (await db.query('select pilot_same_answer($1, $2) v', [a, b])).rows[0].v;
  const cases = [['N$ 1,200', '1200', true], ['1,5', '1.5', true], ['1 020', '1020', true], ['12', '1.2', false], ['', '0', false], ['0', '0', true],
    ['x=-2', '-2', true], ['–5 °C', '-5', true], ['135°', '135', true], ['2/4', '1/2', true], ['1/0', '1', false], ['abc', '1', false], ['01:25', '01:25', true]];
  let mk2 = true;
  for (const [a, b, want] of cases) if ((await same(a, b)) !== want) { mk2 = false; console.log('    wrong:', a, b, want); }
  ok(mk2, 'units, spaces, thousands and decimal commas, "x =", minus signs and equal fractions are handled; an empty answer is never right');

  if (process.env.K12_TEST_BANK) {
    console.log('\n10. The real question bank');
    await db.exec(fs.readFileSync(process.env.K12_TEST_BANK, 'utf8'));
    const bank = JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.K12_TEST_BANK), 'bank.json'), 'utf8'));
    const tests = (await db.query("select code, grade, status, (select count(*)::int from test_items i where i.test_id = t.id) n, (select count(distinct topic || coalesce(sub_topic,''))::int from test_items i where i.test_id = t.id) topics from tests t where code like 'PILOT27-%' order by code")).rows;
    ok(tests.length === 4 && tests.every((t) => t.status === 'draft'), 'all four tests load as drafts', tests);
    ok(tests.filter((t) => t.grade === 11).every((t) => t.n === 38 && t.topics === 38) && tests.filter((t) => t.grade === 12).every((t) => t.n === 30 && t.topics === 15),
      'Grade 11: 38 questions, one for every sub-topic of NSSCO 6131; Grade 12: 30 questions, two for each of the 15 topics of NSSCAS 8227', tests);
    const keyOk = (await db.query("select count(*)::int bad from test_items i join tests t on t.id = i.test_id where t.code like 'PILOT27-%' and (not pilot_mark(i, i.answer) or exists (select 1 from jsonb_array_elements_text(i.accepted) a where not pilot_mark(i, a)))")).rows[0].bad;
    ok(keyOk === 0, 'every answer in the key, and every accepted form, is marked right by the marking rules', keyOk);
    const wrongOk = (await db.query("select count(*)::int bad from test_items i join tests t on t.id = i.test_id where t.code like 'PILOT27-%' and (pilot_mark(i, '') or (i.kind = 'short' and pilot_mark(i, '999999')) or (i.kind = 'choice' and pilot_mark(i, case when i.answer = 'A' then 'B' else 'A' end)))")).rows[0].bad;
    ok(wrongOk === 0, 'blank and wrong answers are never marked right', wrongOk);
    const same2 = bank[0].items.map((x) => x.topic + x.sub_topic).join() === bank[1].items.map((x) => x.topic + x.sub_topic).join() &&
      bank[2].items.map((x) => x.topic).join() === bank[3].items.map((x) => x.topic).join();
    ok(same2, 'Version A and Version B cover the same topics in the same order');
    await db.exec(fs.readFileSync(process.env.K12_TEST_BANK, 'utf8'));
    ok((await db.query("select count(*)::int n from test_items i join tests t on t.id = i.test_id where t.code like 'PILOT27-%'")).rows[0].n === 136, 'loading the bank twice changes nothing');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
