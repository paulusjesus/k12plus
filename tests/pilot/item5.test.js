// Item 5 acceptance tests: teacher pause control.
// "Done when: a paused learner receives nothing, including follow-up messages already
//  scheduled, and the log shows who paused them."
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql'].map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
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
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  await mk('admin', 'learner'); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('tA', 'educator', { name: 'Ms Amutenya' }); await mk('tB', 'educator', { name: 'Mr Other' });
  for (const k of ['l1', 'l2']) await mk(k, 'learner', { name: 'Learner ' + k, grade: 11, uid: 'K12-NA-' + k.toUpperCase() + 'XXXX' });
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
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [c12.id, 'tB@test.na']);
  for (const k of ['l1', 'l2']) await v(k, 'select pilot_join_class($1)', [c11.code]);
  await v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'school', school_id: S.A, given_by_name: 'P', given_by_relation: 'principal', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20' })]);
  for (const k of ['l1', 'l2']) await v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'guardian', learner_id: U[k], given_by_name: 'M', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20' })]);
  const send = async (k, at) => (await v('service', 'select pilot_log_message($1::jsonb, $2::timestamptz)', [JSON.stringify({ recipient_kind: 'learner', learner_id: U[k], channel: 'in_app', purpose: 'follow_up', body: 'What is 2 + 3?', content_ok: true }), at])).v;

  console.log('\n1. Who may pause');
  let r = await v('tB', 'select pilot_pause_learner($1::uuid, $2)', [U.l1, 'x']);
  ok(r.err && /teachers/.test(r.err), "another class's teacher cannot pause this learner", r);
  r = await v('l1', 'select pilot_pause_learner($1::uuid, $2)', [U.l1, 'x']);
  ok(r.err, 'a learner cannot pause or resume the agent themselves');
  r = await v('tA', 'select pilot_pause_learner($1::uuid, $2)', [U.l1, 'Exams next week, parent asked for a break']);
  ok(!r.err, 'the class teacher pauses the agent for a learner', r);
  r = await v('tA', 'select pilot_pause_learner($1::uuid, $2)', [U.l1, 'again']);
  ok(r.err && /already paused/.test(r.err), 'pausing twice gives a clear message');

  console.log('\n2. A paused learner receives nothing');
  // "already scheduled": the follow-up was prepared before the pause; it reaches the gate afterwards
  r = await send('l1', NA('2027-02-17T16:00:00'));
  ok(r.status === 'blocked' && r.reason === 'paused', 'a follow-up prepared before the pause is blocked when it is sent', r);
  r = await send('l1', NA('2027-02-18T16:00:00'));
  ok(r.status === 'blocked' && r.reason === 'paused', 'later messages are blocked too', r);
  const inbox = (await db.query('select count(*)::int n from learner_messages where learner_id = $1', [U.l1])).rows[0].n;
  ok(inbox === 0, 'nothing reached the paused learner');
  r = await send('l2', NA('2027-02-17T16:00:00'));
  ok(r.status === 'sent', 'a classmate who is not paused still gets messages', r);

  console.log('\n3. The log shows who paused them');
  const logged = (await db.query("select checks from message_log where learner_id = $1 and block_reason = 'paused' order by id limit 1", [U.l1])).rows[0].checks;
  ok(logged.paused_by === 'Ms Amutenya' && logged.paused_at, 'each blocked message records who paused the learner and when', logged);
  const smp = (await v('admin', 'select pilot_message_sample(50, $1, false)', ['blocked'])).v;
  ok(smp.length === 2 && smp.every((m) => m.reason === 'paused' && m.checks.paused_by === 'Ms Amutenya'), 'the administrator sees the pausing teacher in the message log', smp.map((m) => m.checks.paused_by));
  let cls = (await v('tA', 'select pilot_my_classes()')).v[0];
  const row = cls.learners.find((l) => l.id === U.l1);
  ok(row.pause && row.pause.by === 'Ms Amutenya' && row.pause.reason === 'Exams next week, parent asked for a break', 'the class list shows the pause, who did it and why', row.pause);
  ok(cls.learners.find((l) => l.id === U.l2).pause === null, 'learners who are not paused show no pause');

  console.log('\n4. Resume');
  r = await v('tB', 'select pilot_resume_learner($1::uuid)', [U.l1]);
  ok(r.err, "another class's teacher cannot resume");
  await db.query("update class_teachers set teacher_id = teacher_id"); // no-op
  r = await v('admin', 'select pilot_resume_learner($1::uuid)', [U.l1]);
  ok(!r.err, 'an administrator can resume', r);
  r = await send('l1', NA('2027-02-19T16:00:00'));
  ok(r.status === 'sent', 'after resuming, messages reach the learner again', r);
  r = await v('tA', 'select pilot_resume_learner($1::uuid)', [U.l1]);
  ok(r.err && /not paused/.test(r.err), 'resuming when not paused gives a clear message');
  await v('tA', 'select pilot_pause_learner($1::uuid, $2)', [U.l1, '']);
  await v('tA', 'select pilot_resume_learner($1::uuid)', [U.l1]);
  const hist = (await v('tA', 'select pilot_pause_history($1::uuid)', [U.l1])).v;
  ok(hist.length === 2 && hist[1].paused_by === 'Ms Amutenya' && hist[1].resumed_by === 'admin' && hist[0].resumed_by === 'Ms Amutenya' && hist.every((h) => h.paused_at && h.resumed_at),
    'every pause and resume is kept with who and when', hist);
  r = await v('tB', 'select pilot_pause_history($1::uuid)', [U.l1]);
  ok(r.err, "another class's teacher cannot see the pause history");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message, e.where || ''); process.exit(2); });
