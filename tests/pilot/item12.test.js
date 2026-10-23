// Item 12 database tests: offline lessons and sync.
// Runs the real migrations in PGlite and checks that results sent again after a dropped
// signal are stored once only, and that only pilot teachers, champions and K-12 EdTech
// administrators can release a lesson pack to learners.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql',
  '20261031_pilot_evaluator_export.sql', '20261101_pilot_offline_lessons.sql'].map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  // a quiz result saved before this change: it has no reference, and must stay untouched
  const old = (await db.query("insert into auth.users (email) values ('old@school.na') returning id")).rows[0].id;
  await db.query("insert into profiles (id, username, role, grade, country) values ($1, 'Old Learner', 'learner', 11, 'Namibia')", [old]);
  await db.query("insert into quiz_attempts (user_id, subject, score, total) values ($1, 'Mathematics', 4, 5), ($1, 'Mathematics', 4, 5)", [old]);
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  // the migration can run twice without harm
  await db.exec(fs.readFileSync(MIGS[MIGS.length - 1], 'utf8'));

  const U = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@school.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, school_id) values ($1,$2,$3,$4,$5,$6)', [U[key], o.name || key, role, o.grade || null, 'Namibia', o.school || null]);
  };
  const as = (who, sql, params = []) => db.transaction(async (tx) => {
    const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated';
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who === 'service' || who === 'anon' ? { role } : { sub: U[who], role })]);
    await tx.query(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
  const v = async (who, sql, params) => { try { return { v: Object.values((await as(who, sql, params))[0])[0] }; } catch (e) { return { err: e.message }; } };

  const sch = (await db.query("insert into schools (name, region, country, region_id) values ('Tsandi Secondary School', 'x', 'Namibia', 10) returning id")).rows[0].id;
  await mk('admin', 'learner', { name: 'Pilot Admin' }); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('teacher', 'educator', { name: 'Ms Amutenya', school: sch });
  await mk('other', 'educator', { name: 'Mr Not In Pilot', school: sch });
  await mk('champ', 'educator', { name: 'Mr Champion' });
  await mk('l1', 'learner', { name: 'Ndapewa', grade: 11 });
  await mk('l2', 'learner', { name: 'Tomas', grade: 11 });
  const set = (await v('admin', 'select pilot_setup_region(10::smallint, $1::jsonb)', [JSON.stringify([{ school_id: sch, setting: 'rural' }])])).v;
  const c11 = set.schools[0].classes.find((c) => c.grade === 11);
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [c11.id, 'teacher@school.na']);
  const ch = await v('admin', 'select pilot_set_champion(10::smallint, $1)', ['champ@school.na']);

  console.log('\nQuiz results made offline are stored once only');
  ok((await db.query('select count(*)::int n from quiz_attempts where user_id = $1 and client_ref is null', [old])).rows[0].n === 2, 'older results without a reference are kept as they were');
  const row = (ref, score = 3) => JSON.stringify({ user_id: U.l1, subject: 'Mathematics', score, total: 5, client_ref: ref, created_at: '2026-11-20T09:00:00+02:00' });
  // what the app's request does: insert ... on conflict (user_id, client_ref) do nothing, as the learner (row level security applies)
  const send = (who, rows) => v(who, `insert into quiz_attempts (user_id, subject, score, total, client_ref, created_at)
    select user_id, subject, score, total, client_ref, created_at from jsonb_populate_recordset(null::quiz_attempts, $1::jsonb)
    on conflict (user_id, client_ref) do nothing returning 1`, ['[' + rows.join(',') + ']']);
  await send('l1', [row('quiz-0001-aaaa'), row('quiz-0002-bbbb', 5)]);
  await send('l1', [row('quiz-0001-aaaa'), row('quiz-0002-bbbb', 5)]); // the signal dropped before the phone heard back, so it sent again
  await send('l1', [row('quiz-0001-aaaa')]);
  const mine = (await db.query('select score from quiz_attempts where user_id = $1 order by score', [U.l1])).rows.map((r) => r.score);
  ok(JSON.stringify(mine) === '[3,5]', 'two quizzes sent three times are stored as exactly two results', mine);
  const other = await send('l2', [row('quiz-0001-aaaa')]);
  ok(!!other.err, 'a learner cannot store a result for someone else', other);
  await send('l2', [JSON.stringify({ user_id: U.l2, subject: 'Mathematics', score: 2, total: 5, client_ref: 'quiz-0001-aaaa', created_at: '2026-11-20T09:00:00+02:00' })]);
  ok((await db.query('select count(*)::int n from quiz_attempts where client_ref = $1', ['quiz-0001-aaaa'])).rows[0].n === 2, 'the same reference on two learners\' phones gives two separate results');
  const bad = await send('l1', [JSON.stringify({ user_id: U.l1, subject: 'M', score: 1, total: 5, client_ref: 'short', created_at: '2026-11-20T09:00:00+02:00' })]);
  ok(!!bad.err, 'references that are too short are refused');

  console.log('\nLesson packs reach learners only after a check');
  let list = (await v('l1', 'select pilot_lesson_checks()')).v;
  ok(Array.isArray(list) && list.length === 0, 'at the start no pack is checked');
  let r = await v('l1', "select pilot_check_lesson('g11-equations', 1, true)");
  ok(/Only pilot teachers/.test(r.err || ''), 'a learner cannot check a lesson', r);
  r = await v('other', "select pilot_check_lesson('g11-equations', 1, true)");
  ok(/Only pilot teachers/.test(r.err || ''), 'a teacher outside the pilot cannot check a lesson', r);
  r = await v('anon', "select pilot_check_lesson('g11-equations', 1, true)");
  ok(!!r.err, 'someone who is not logged in cannot check a lesson');
  r = await v('teacher', "select pilot_check_lesson('g11-equations', 1, true, 'Checked against the 6131 syllabus')");
  ok(!r.err && r.v.length === 1 && r.v[0].checked_name === 'Ms Amutenya' && r.v[0].checked_role === 'teacher', 'a pilot teacher checks a pack, and her name is recorded', r);
  r = await v('champ', "select pilot_check_lesson('g12-logs', 1, true)");
  ok(!r.err && r.v.some((c) => c.pack_id === 'g12-logs' && c.checked_role === 'champion'), 'a regional champion can check a pack', [ch, r]);
  r = await v('admin', "select pilot_check_lesson('g11-percentages', 1, true)");
  ok(!r.err && r.v.length === 3, 'an administrator can check a pack');
  r = await v('teacher', "select pilot_check_lesson('g11-equations', 1, true)");
  ok(!r.err && (await db.query("select count(*)::int n from lesson_checks where pack_id = 'g11-equations'")).rows[0].n === 1, 'checking twice keeps one check');
  list = (await v('l1', 'select pilot_lesson_checks()')).v;
  ok(list.length === 3 && list.every((c) => c.checked_name == null && c.note == null), 'learners see which packs are checked, but not who checked them');
  list = (await v('anon', 'select pilot_lesson_checks()')).v;
  ok(Array.isArray(list) && list.length === 3 && list.every((c) => c.checked_name == null), 'the app can read the checks before anyone logs in (needed offline), without names');
  list = (await v('teacher', 'select pilot_lesson_checks()')).v;
  ok(list.find((c) => c.pack_id === 'g11-equations').note === 'Checked against the 6131 syllabus', 'staff see the name and the note');
  ok((await v('l1', "select pilot_lesson_checks() @> '[{\"pack_id\":\"g11-equations\",\"version\":2}]'::jsonb")).v === false, 'a check belongs to one version: version 2 of a changed pack is not checked');
  r = await v('champ', "select pilot_check_lesson('g11-equations', 1, false)");
  ok(/Only the person who checked/.test(r.err || ''), 'someone else cannot take back a teacher\'s check', r);
  r = await v('teacher', "select pilot_check_lesson('g11-equations', 1, false)");
  ok(!r.err && !r.v.some((c) => c.pack_id === 'g11-equations'), 'the teacher can take her own check back');
  r = await v('admin', "select pilot_check_lesson('g12-logs', 1, false)");
  ok(!r.err && !r.v.some((c) => c.pack_id === 'g12-logs'), 'an administrator can take back any check');
  r = await v('admin', "select pilot_check_lesson('../etc', 1, true)");
  ok(/Unknown lesson pack/.test(r.err || ''), 'unknown pack names are refused');
  r = await v('l1', 'select count(*) from lesson_checks');
  ok(!!r.err || r.v === '0' || r.v === 0, 'the checks table itself is not open to the app (only through the functions)', r);

  console.log('\nPractice and lesson records from the phone');
  await v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'school', school_id: sch, given_by_name: 'P', given_by_relation: 'principal', method: 'paper_form', evidence_path: 'x', signed_on: '2026-09-01' })]);
  await v('l1', 'select pilot_join_class($1)', [c11.code]);
  await v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'guardian', learner_id: U.l1, given_by_name: 'M', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-09-01' })]);
  const now = new Date().toISOString();
  const ev = (ref, kind, extra = {}) => ({ client_ref: ref, kind, subject: 'Mathematics', topic: 'Algebra / Equations and inequalities', occurred_at: now, offline: true, ...extra });
  const batch = [ev('les-000001', 'lesson'), ev('prac-00001', 'practice', { correct: 1, attempted: 1 }), ev('prac-00002', 'practice', { correct: 0, attempted: 1 })];
  r = await v('l1', 'select pilot_record_events($1::jsonb)', [JSON.stringify(batch)]);
  const r2 = await v('l1', 'select pilot_record_events($1::jsonb)', [JSON.stringify(batch)]);
  const evs = (await db.query("select kind, correct, offline from learning_events where learner_id = $1 order by client_ref", [U.l1])).rows;
  ok(r.v.stored === 3 && r2.v.stored === 0 && evs.length === 3 && evs.every((e) => e.offline), 'a lesson opened and two practice answers made offline are stored once, marked as offline', [r, r2, evs]);
  r = await v('l2', 'select pilot_record_events($1::jsonb)', [JSON.stringify([ev('prac-00099', 'practice', { correct: 1, attempted: 1 })])]);
  ok(r.v.stored === 0 && r.v.taking_part === false, 'nothing is stored for a learner who does not take part in the pilot');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
