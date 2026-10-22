// Item 4 acceptance tests: Monday summary for teachers, and the learning record.
// "Done when: teachers in a test class receive an accurate summary every Monday for three
//  weeks in a row without anyone triggering it by hand." Here three Mondays are simulated;
//  on the live site the scheduled job runs them (checked separately).
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql', '20261027_pilot_learning_and_summaries.sql']
  .map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };

// Namibian Monday 00:00 of the current week, and helpers (UTC+2, no daylight saving)
const nowNA = new Date(Date.now() + 2 * 3600e3);
const dow = (nowNA.getUTCDay() + 6) % 7; // 0 = Monday
const M0 = Date.UTC(nowNA.getUTCFullYear(), nowNA.getUTCMonth(), nowNA.getUTCDate() - dow) - 2 * 3600e3; // Monday 00:00 Namibian, in UTC ms
const day = 86400e3;
const iso = (ms) => new Date(ms).toISOString();
const mondayAt6 = (weeksBack) => iso(M0 - weeksBack * 7 * day + 6 * 3600e3);   // the Monday the job runs
const inWeek = (weeksBack, d, h) => iso(M0 - weeksBack * 7 * day + d * day + h * 3600e3); // d days after the Monday that STARTS the week

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@test.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, learner_uid) values ($1,$2,$3,$4,$5,$6)', [U[key], o.name || key, role, o.grade || null, 'Namibia', o.uid || null]);
  };
  S.A = (await db.query("insert into schools (name, region, country) values ('Tsandi SS', 'Omusati (Tsandi)', 'Namibia') returning id")).rows[0].id;
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  await mk('admin', 'learner'); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('tA', 'educator', { name: 'Ms Amutenya' }); await mk('tA2', 'educator', { name: 'Mr Second' }); await mk('tB', 'educator', { name: 'Mr Other' });
  const names = { l1: 'Ndapewa Shikongo', l2: 'Tomas Haufiku', l3: 'Selma Nangolo', l4: 'Petrus Iipinge' };
  for (const k of Object.keys(names)) await mk(k, 'learner', { name: names[k], grade: 11, uid: 'K12-NA-' + k.toUpperCase() + 'XXXX' });
  const as = (who, sql, params = []) => db.transaction(async (tx) => {
    const role = who === 'service' ? 'service_role' : 'authenticated';
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who === 'service' ? { role } : { sub: U[who], role })]);
    await tx.query(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
  const v = async (who, sql, params) => { try { return { v: Object.values((await as(who, sql, params))[0])[0] }; } catch (e) { return { err: e.message }; } };
  const setup = (await v('admin', 'select pilot_setup_region(10::smallint, $1::jsonb)', [JSON.stringify([{ school_id: S.A, setting: 'rural' }])])).v;
  const [c11, c12] = [11, 12].map((g) => setup.schools[0].classes.find((c) => c.grade === g));
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [c11.id, 'tA@test.na']);
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [c11.id, 'tA2@test.na']);
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [c12.id, 'tB@test.na']);
  for (const k of Object.keys(names)) await v(k, 'select pilot_join_class($1)', [c11.code]);
  await db.query("update enrolments set enrolled_at = now() - interval '40 days'"); // joined well before the weeks tested
  await v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'school', school_id: S.A, given_by_name: 'P', given_by_relation: 'principal', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20' })]);
  for (const k of ['l1', 'l2', 'l3']) await v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'guardian', learner_id: U[k], given_by_name: 'M', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20' })]);

  let ref = 0;
  const ev = (o) => ({ client_ref: 'ref-' + String(++ref).padStart(6, '0'), ...o });
  const record = (k, events) => v(k, 'select pilot_record_events($1::jsonb)', [JSON.stringify(events)]);

  console.log('\n1. Learning record: consent first');
  let r = await record('l4', [ev({ kind: 'question', subject: 'Mathematics', occurred_at: inWeek(1, 1, 16) })]);
  ok(r.v.stored === 0 && r.v.taking_part === false, 'nothing is stored for a learner without consent', r);
  const sameRef = ev({ kind: 'question', subject: 'Mathematics', occurred_at: inWeek(1, 1, 16) });
  r = await record('l1', [sameRef]);
  const again = await record('l1', [sameRef]);
  ok(r.v.stored === 1 && again.v.stored === 0, 'a record synced twice (for example after being offline) is stored once', { first: r.v, again: again.v });
  r = await record('l1', [ev({ kind: 'question', occurred_at: iso(Date.now() + 3 * 3600e3) }), ev({ kind: 'question', occurred_at: iso(Date.now() - 40 * day) }), ev({ kind: 'hacking', occurred_at: inWeek(1, 1, 16) }), ev({ kind: 'question', occurred_at: 'not a date' })]);
  ok(r.v.stored === 0, 'records from the future, older than 30 days, of an unknown kind or with a bad date are ignored', r);
  const direct0 = await as('l1', 'select * from learning_events');
  ok(direct0.length === 0 && (await db.query('select count(*)::int n from learning_events')).rows[0].n === 1, 'the learning record cannot be read directly (it holds 1 record, a learner sees none)');
  const direct = await (async () => { try { await as('l1', "insert into learning_events (learner_id, kind, client_ref, occurred_at) values ($1, 'question', 'xxxxxxxxxx', now())", [U.l1]); return 'inserted'; } catch (e) { return 'refused'; } })();
  ok(direct === 'refused', 'nobody can write to the learning record directly');
  await db.query("delete from learning_events");

  // ---- activity over three weeks (weeksBack 3 = three weeks ago ... 1 = last week) ----
  // week 3: l1 and l2 active, l3 not; Quadratic functions weak (2 of 8)
  await record('l1', [ev({ kind: 'question', subject: 'Mathematics', occurred_at: inWeek(3, 1, 16) }), ev({ kind: 'question', subject: 'Mathematics', occurred_at: inWeek(3, 2, 17) }),
    ev({ kind: 'game', subject: 'Mathematics', topic: 'Quadratic functions', correct: 2, attempted: 8, occurred_at: inWeek(3, 2, 17) }),
    ev({ kind: 'active', duration_seconds: 900, occurred_at: inWeek(3, 2, 17) })]);
  await record('l2', [ev({ kind: 'quiz', subject: 'Mathematics', topic: 'Linear equations', correct: 9, attempted: 10, occurred_at: inWeek(3, 3, 15) }),
    ev({ kind: 'active', duration_seconds: 600, occurred_at: inWeek(3, 3, 15) })]);
  // week 2: only l3 active; Trigonometry weak (1 of 6), Probability fine (5 of 5), Statistics too few answers (0 of 3)
  await record('l3', [ev({ kind: 'practice', subject: 'Mathematics', topic: 'Trigonometry', correct: 1, attempted: 6, occurred_at: inWeek(2, 4, 16) }),
    ev({ kind: 'practice', subject: 'Mathematics', topic: 'Probability', correct: 5, attempted: 5, occurred_at: inWeek(2, 4, 16) }),
    ev({ kind: 'practice', subject: 'Mathematics', topic: 'Statistics', correct: 0, attempted: 3, occurred_at: inWeek(2, 5, 10) }),
    ev({ kind: 'question', subject: 'Mathematics', occurred_at: inWeek(2, 5, 10) }), ev({ kind: 'active', duration_seconds: 1500, occurred_at: inWeek(2, 5, 10) })]);
  // week 1: nobody active, except an event on the Sunday at 23:30 Namibian time (still that week) and one on Monday 00:30 (next week)
  await record('l2', [ev({ kind: 'question', subject: 'Mathematics', occurred_at: inWeek(1, 6, 23.5) }), ev({ kind: 'question', subject: 'Mathematics', occurred_at: inWeek(0, 0, 0.5) })]);

  console.log('\n2. Three Mondays in a row');
  const expect = {
    3: { active: 2, notActive: ['Selma Nangolo'], questions: 2, practice: 18, minutes: 25, topics: ['Quadratic functions'] },
    2: { active: 1, notActive: ['Ndapewa Shikongo', 'Tomas Haufiku'], questions: 1, practice: 14, minutes: 25, topics: ['Trigonometry'] },
    1: { active: 1, notActive: ['Ndapewa Shikongo', 'Selma Nangolo'], questions: 1, practice: 0, minutes: 0, topics: [] },
  };
  for (const wb of [3, 2, 1]) {
    const built = (await v('service', 'select pilot_build_monday_summaries($1::timestamptz)', [mondayAt6(wb - 1)])).v;
    ok(built === 2, `Monday ${4 - wb}: a summary is built for each class with a teacher`, built);
    const mine = (await v('tA', 'select pilot_my_summaries()')).v;
    const s = mine.find((m) => m.class_id === c11.id).summaries[0];
    const e = expect[wb];
    ok(s.taking_part === 3 && s.active === e.active && JSON.stringify(s.not_active) === JSON.stringify(e.notActive) && s.questions === e.questions && s.practice === e.practice && s.minutes === e.minutes
      && JSON.stringify(s.topics.map((x) => x.topic)) === JSON.stringify(e.topics),
      `Monday ${4 - wb}: the figures are exactly right (active ${e.active} of 3, not active: ${e.notActive.join(', ')}, topics: ${e.topics.join(', ') || 'none'})`, s);
  }
  ok((await v('service', 'select pilot_build_monday_summaries($1::timestamptz)', [mondayAt6(0)])).v === 0, 'running the job again on the same Monday does not send a second summary');
  const mine = (await v('tA', 'select pilot_my_summaries()')).v.find((m) => m.class_id === c11.id).summaries;
  ok(mine.length === 3 && mine[0].week_start > mine[1].week_start, 'the teacher sees the three weekly summaries, newest first');
  const s2 = (await v('tA2', 'select pilot_my_summaries()')).v.find((m) => m.class_id === c11.id).summaries;
  ok(s2.length === 3, 'both teachers of the class get it');
  const other = (await v('tB', 'select pilot_my_summaries()')).v;
  ok(other.length === 1 && other[0].class_id === c12.id && !JSON.stringify(other).includes('Ndapewa'), "a teacher of another class never sees this class's summary");
  ok(!JSON.stringify(mine).includes('Petrus'), 'a learner without consent never appears in a summary');

  console.log('\n3. Logged through the message gate, without names');
  const logs = (await db.query("select teacher_id, status, channel, body from message_log where purpose = 'monday_summary' order by id")).rows;
  ok(logs.length === 9 && logs.every((l) => l.status === 'sent'), 'every summary delivery is logged (3 Mondays: 2 teachers of one class and 1 of the other)', logs.length);
  ok(logs.every((l) => !/Ndapewa|Tomas|Selma|Petrus/.test(l.body)), 'the logged text holds figures only, no learner names');
  ok(/2 of 3 learners were active, 1 not active, 2 questions asked, 18 practice answers, 25 minutes\. Topics to revisit: Quadratic functions\./.test(logs.find((l) => /Grade 11/.test(l.body)).body), 'the logged text matches the figures', logs.find((l) => /Grade 11/.test(l.body)).body);
  ok(/no learner in this class takes part in the pilot yet/.test(logs.find((l) => /Grade 12/.test(l.body)).body), 'a class with no consented learners is told plainly, instead of "0 of 0"');
  const status = (await v('admin', 'select pilot_summary_status()')).v;
  ok(status.classes_with_teacher === 2 && status.weeks.length === 3 && status.weeks.every((w) => w.classes === 2), 'the administrator sees every class got its summary each week', status);
  r = await v('tA', 'select pilot_summary_status()');
  ok(r.err, 'only administrators see the summary status');
  r = await v('tA', 'select pilot_build_monday_summaries()');
  ok(r.err && /permission denied/.test(r.err), 'nobody can trigger the summaries through the app; only the scheduled job can');

  console.log('\n4. Withdrawal');
  await v('tA', 'select pilot_withdraw_guardian_consent($1::uuid, $2)', [U.l3, 'parent asked']);
  let now3 = (await v('tA', 'select pilot_my_summaries()')).v.find((m) => m.class_id === c11.id).summaries;
  ok(now3.every((s) => !s.not_active.includes('Selma Nangolo')), 'a withdrawn learner is no longer named in any summary, straight away');
  r = await record('l3', [ev({ kind: 'question', occurred_at: iso(Date.now() - 3600e3) })]);
  ok(r.v.stored === 0, 'nothing more is recorded after withdrawal');
  const pend = (await v('admin', 'select pilot_pending_removals()')).v;
  await v('admin', 'select pilot_remove_data($1::bigint)', [pend[0].id]);
  const leftEv = (await db.query('select count(*)::int n from learning_events where learner_id = $1', [U.l3])).rows[0].n;
  const leftIds = (await db.query("select count(*)::int n from teacher_summaries where data->'not_active' ? $1", [U.l3])).rows[0].n;
  ok(leftEv === 0 && leftIds === 0, "removing a withdrawn learner's data deletes their learning record and their ID from past summaries", { leftEv, leftIds });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message, e.where || ''); process.exit(2); });
