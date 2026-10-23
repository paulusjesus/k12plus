// Item 9 acceptance tests: teachers review a sample of the agent's feedback each month.
// "Done when: teachers in a test class can complete a review of ten samples in under
//  fifteen minutes, and the results are visible to the team."
// The time taken in a real browser is checked in item9.ui.test.js; here, the rules.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql']
  .map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };
const NA = (s) => new Date(s + '+02:00').toISOString();

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@test.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, learner_uid) values ($1,$2,$3,$4,$5,$6)', [U[key], o.name || key, role, o.grade || null, 'Namibia', o.uid || null]);
  };
  S.A = (await db.query("insert into schools (name, region, country) values ('Tsandi SS', 'Omusati (Tsandi)', 'Namibia') returning id")).rows[0].id;
  S.B = (await db.query("insert into schools (name, region, country) values ('Outapi SS', 'Omusati (Outapi)', 'Namibia') returning id")).rows[0].id;
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  const as = (who, sql, params = []) => db.transaction(async (tx) => {
    const role = who === 'service' ? 'service_role' : 'authenticated';
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who === 'service' ? { role } : { sub: U[who], role })]);
    await tx.query(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
  const v = async (who, sql, params) => { try { return { v: Object.values((await as(who, sql, params))[0])[0] }; } catch (e) { return { err: e.message }; } };
  const consent = (b) => v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-09-01', ...b })]);
  await mk('admin', 'learner'); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  for (const k of ['tA', 'tA2', 'tB', 'tNone']) await mk(k, 'educator', { name: { tA: 'Ms Amutenya', tA2: 'Mr CoTeacher', tB: 'Mr Outapi', tNone: 'Ms Quiet' }[k] });
  const setup = (await v('admin', 'select pilot_setup_region(10::smallint, $1::jsonb)', [JSON.stringify([{ school_id: S.A, setting: 'rural' }, { school_id: S.B, setting: 'urban' }])])).v;
  const cl = (sid, g) => setup.schools.find((x) => x.id === sid).classes.find((c) => c.grade === g);
  const a11 = cl(S.A, 11), a12 = cl(S.A, 12), b11 = cl(S.B, 11);
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [a11.id, 'tA@test.na']);
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [a11.id, 'tA2@test.na']);
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [b11.id, 'tB@test.na']);
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [a12.id, 'tNone@test.na']);
  for (const s of [S.A, S.B]) await consent({ kind: 'school', school_id: s, given_by_relation: 'principal' });
  const L = { a1: [a11, 11, true, 'Ndapewa Shikongo'], a2: [a11, 11, true, 'Tomas Haufiku'], a3: [a11, 11, false, 'No Consent'], b1: [b11, 11, true, 'Selma Nangolo'], c1: [a12, 12, true, 'Quiet Learner'] };
  for (const [k, [cls, g, c, name]] of Object.entries(L)) {
    await mk(k, 'learner', { name, grade: g, uid: 'K12-NA-' + k.toUpperCase() + 'XXX' });
    await v(k, 'select pilot_join_class($1)', [cls.code]);
    if (c) await consent({ kind: 'guardian', learner_id: U[k] });
  }

  console.log('\n1. Keeping the agent\'s replies to pilot learners');
  const save = (k, q, at) => v('service', 'select pilot_save_exchange($1::jsonb)', [JSON.stringify({ learner_id: U[k], kind: 'chat', subject: 'Mathematics', question: q, reply: 'Reply to: ' + q, model: 'claude-sonnet-5-5' })]);
  let r = await save('a1', 'What is a prime number?');
  ok(r.v && r.v.stored === true, 'the agent function stores a pilot learner\'s question and the reply');
  r = await save('a3', 'Secret question');
  ok(r.v && r.v.stored === false, 'nothing is stored for a learner without consent');
  r = await v('service', 'select pilot_save_exchange($1::jsonb)', [JSON.stringify({ learner_id: U.a1, question: '  ', reply: 'x' })]);
  ok(r.v.stored === false, 'an empty question is not stored');
  ok(/permission denied/.test((await v('a1', 'select pilot_save_exchange($1::jsonb)', [JSON.stringify({ learner_id: U.a1, question: 'fake', reply: 'fake' })])).err || ''), 'learners cannot add questions or replies themselves');
  r = await v('a1', 'select pilot_agent_context()');
  ok(r.v.taking_part === true && r.v.locked === false && r.v.learner_id === U.a1, 'the agent function learns, from the database, that the learner takes part');
  r = await v('a3', 'select pilot_agent_context()');
  ok(r.v.taking_part === false, 'and that a learner without consent does not');
  ok((await as('tA', 'select * from agent_exchanges')).length === 0, 'nobody can read the stored replies directly');

  // September: 25 replies for class A11 (tA and tA2), 4 for B11 (tB), none for A12 (tNone); some outside September
  await db.query('delete from agent_exchanges');
  const ins = (k, q, at) => db.query("insert into agent_exchanges (learner_id, class_id, kind, subject, question, reply, created_at) values ($1, $2, 'chat', 'Mathematics', $3, $4, $5) returning id", [U[k], L[k][0].id, q, 'Answer: ' + q, at]);
  for (let i = 1; i <= 25; i++) await ins(i % 2 ? 'a1' : 'a2', 'A question ' + i, NA(`2026-09-${String(1 + (i % 28)).padStart(2, '0')}T16:00:00`));
  for (let i = 1; i <= 4; i++) await ins('b1', 'B question ' + i, NA(`2026-09-1${i}T16:00:00`));
  await ins('a1', 'August question', NA('2026-08-31T23:30:00'));
  await ins('a1', 'October question', NA('2026-10-01T00:30:00'));
  await ins('a3', 'Before withdrawal', NA('2026-09-10T16:00:00')); // a3 has no consent: must never be sampled

  console.log('\n2. The monthly sample');
  r = await v('service', "select pilot_prepare_reviews(null, 10, $1::timestamptz)", [NA('2026-10-01T06:30:00')]);
  ok(r.v === 3, 'on 1 October the job prepares samples from September for the 3 teachers whose learners used the agent', r);
  const batches = (await db.query("select b.id, p.username, b.month::text m, (select count(*)::int from review_items i where i.batch_id = b.id) n from review_batches b join profiles p on p.id = b.teacher_id order by p.username")).rows;
  ok(batches.length === 3 && batches.every((b) => b.m === '2026-09-01') && batches.find((b) => b.username === 'Ms Amutenya').n === 10 && batches.find((b) => b.username === 'Mr CoTeacher').n === 10 && batches.find((b) => b.username === 'Mr Outapi').n === 4,
    'each teacher of a class with 25 replies gets 10; the teacher with 4 replies gets all 4; the teacher with none gets no sample', batches);
  const qs = (await db.query("select b.teacher_id, x.question from review_items i join review_batches b on b.id = i.batch_id join agent_exchanges x on x.id = i.exchange_id")).rows;
  ok(qs.filter((x) => x.teacher_id === U.tA).every((x) => /^A question/.test(x.question)) && qs.filter((x) => x.teacher_id === U.tB).every((x) => /^B question/.test(x.question)),
    "a teacher's sample only holds replies to learners in their own classes");
  ok(!qs.some((x) => /August|October|Before withdrawal/.test(x.question)), 'replies from outside the month, or to learners without consent, are never sampled');
  const orderA = qs.filter((x) => x.teacher_id === U.tA).map((x) => x.question).join();
  const orderA2 = qs.filter((x) => x.teacher_id === U.tA2).map((x) => x.question).join();
  ok(orderA !== orderA2, 'the sample is picked at random (two teachers of the same class get different samples)');
  r = await v('service', "select pilot_prepare_reviews(null, 10, $1::timestamptz)", [NA('2026-10-02T06:30:00')]);
  ok(r.v === 0 && (await db.query('select count(*)::int n from review_batches')).rows[0].n === 3, 'running the job again changes nothing: one sample per teacher a month');
  ok(/administrators/.test((await v('tA', "select pilot_prepare_reviews_now('2026-09-01')")).err || '') && /permission denied/.test((await v('tA', "select pilot_prepare_reviews('2026-09-01')")).err || ''), 'teachers cannot prepare samples');

  console.log('\n3. The teacher reviews ten replies');
  r = await v('tA', 'select pilot_my_review()');
  const rv = r.v;
  ok(rv && rv.items.length === 10 && rv.items.every((x) => x.question && x.reply && x.grade === 11 && x.subject === 'Mathematics'), 'the teacher sees 10 items: the question, the reply, grade and subject');
  const txt = JSON.stringify(rv);
  ok(!/Ndapewa|Tomas|K12-NA-/.test(txt) && !txt.includes(U.a1) && !txt.includes(U.a2), "the learner's name, K12Plus ID and account are not shown");
  ok(/not yours/.test((await v('tB', 'select pilot_review_item($1::bigint, $2, null)', [rv.items[0].id, 'correct'])).err || ''), "another teacher cannot mark this teacher's items");
  ok(/Choose correct, incorrect or unsuitable/.test((await v('tA', 'select pilot_review_item($1::bigint, $2, null)', [rv.items[0].id, 'great'])).err || ''), 'only the three verdicts are accepted');
  await v('tA', 'select pilot_start_review($1::bigint)', [rv.id]);
  await db.query("update review_batches set opened_at = now() - interval '9 minutes' where id = $1", [rv.id]); // as if opened 9 minutes ago
  const verdicts = ['correct', 'correct', 'incorrect', 'correct', 'unsuitable', 'correct', 'correct', 'correct', 'incorrect', 'correct'];
  let last;
  for (let i = 0; i < 10; i++) last = (await v('tA', 'select pilot_review_item($1::bigint, $2, $3)', [rv.items[i].id, verdicts[i], i === 2 ? 'The factorising step is wrong: it should be (x − 2)(x − 3).' : i === 4 ? 'Too advanced for Grade 11.' : null])).v;
  r = await v('tA', 'select pilot_my_review()');
  ok(last.left === 0 && r.v.completed_at && r.v.minutes >= 8.9 && r.v.minutes < 15, 'after the tenth verdict the review is complete, and the time taken is recorded (about 9 minutes here)', { left: last.left, minutes: r.v.minutes });
  const secs = (await db.query('select seconds from review_items i join review_batches b on b.id = i.batch_id where b.teacher_id = $1 order by position', [U.tA])).rows.map((x) => x.seconds);
  ok(secs[0] >= 539 && secs.slice(1).every((x) => x >= 0 && x < 60), 'the time on each item is kept too', secs);
  await v('tA', 'select pilot_review_item($1::bigint, $2, $3)', [rv.items[1].id, 'incorrect', 'On second thoughts, the units are missing.']);
  r = await v('tA', 'select pilot_my_review()');
  ok(r.v.items[1].verdict === 'incorrect' && r.v.items[1].comment === 'On second thoughts, the units are missing.', 'a teacher can change a verdict');

  console.log('\n4. Results for the team');
  r = await v('admin', "select pilot_review_results('2026-09-15')");
  const res = r.v;
  ok(res.counts.correct === 6 && res.counts.incorrect === 3 && res.counts.unsuitable === 1 && res.counts.waiting === 14, 'K-12 EdTech sees the counts: 6 correct, 3 incorrect, 1 unsuitable, 14 still to review', res.counts);
  const mine = res.teachers.find((t) => t.teacher === 'Ms Amutenya');
  ok(mine && mine.done === 10 && mine.items === 10 && mine.minutes >= 8.9 && mine.school === 'Tsandi SS' && res.teachers.length === 3, 'and, for each teacher, how many are done and how long it took', res.teachers);
  ok(res.items.length === 10 && res.items[0].verdict === 'unsuitable' && res.items.some((x) => x.comment && /factorising/.test(x.comment)) && res.items.every((x) => x.question && x.reply && x.school),
    'every reviewed reply is listed with the question, the reply, the verdict and the comment, worst first');
  ok(!/Ndapewa|Tomas|K12-NA-/.test(JSON.stringify(res)), 'without learners\' names or IDs');
  ok(/administrators/.test((await v('tA', "select pilot_review_results('2026-09-01')")).err || ''), 'teachers cannot see everyone\'s results');

  console.log('\n5. Withdrawal');
  await v('admin', 'select pilot_withdraw_guardian_consent($1::uuid, $2)', [U.a1, 'parent asked']);
  const rem = (await db.query('select id from data_removals where learner_id = $1', [U.a1])).rows[0].id;
  await v('admin', 'select pilot_remove_data($1::bigint)', [rem]);
  const left = (await db.query('select count(*)::int n from agent_exchanges where learner_id = $1', [U.a1])).rows[0].n;
  const itemsLeft = (await db.query('select count(*)::int n from review_items i join agent_exchanges x on x.id = i.exchange_id where x.learner_id = $1', [U.a1])).rows[0].n;
  ok(left === 0 && itemsLeft === 0, "removing a learner's pilot data removes their questions, the agent's replies and any review of them");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
