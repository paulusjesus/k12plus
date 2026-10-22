// Item 7 acceptance tests: safety rules on every message.
// "Done when: messages that break any rule are blocked and logged, and a sample of
//  logged messages can be reviewed on request."
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql'].map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };

// Namibian time is UTC+2 all year
const NA = (s) => new Date(s + '+02:00').toISOString();
const WED_SCHOOL = NA('2027-02-17T10:00:00'), WED_AFTER = NA('2027-02-17T16:00:00'), WED_LATE = NA('2027-02-17T22:30:00');
const WED_EDGE_END = NA('2027-02-17T19:30:00'), WED_EDGE_PAST = NA('2027-02-17T19:31:00');
const SAT_MORNING = NA('2027-02-20T10:00:00'), SAT_EVENING = NA('2027-02-20T20:00:00');
const NEXT_MON = NA('2027-02-22T16:00:00');

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@test.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, learner_uid) values ($1,$2,$3,$4,$5,$6)',
      [U[key], o.name || key, role, o.grade || null, 'Namibia', o.uid || null]);
  };
  S.A = (await db.query("insert into schools (name, region, country) values ('Tsandi SS', 'Omusati (Tsandi)', 'Namibia') returning id")).rows[0].id;
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  await mk('admin', 'learner'); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('tA', 'educator');
  for (const k of ['l1', 'l2', 'l3', 'l4']) await mk(k, 'learner', { name: 'Learner ' + k, grade: 11, uid: 'K12-NA-' + k.toUpperCase() + 'XXXX' });

  const as = (who, sql, params = []) => db.transaction(async (tx) => {
    const role = who === 'service' ? 'service_role' : 'authenticated';
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who === 'service' ? { role } : { sub: U[who], role })]);
    await tx.query(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
  const t = async (who, sql, params) => { try { return { rows: await as(who, sql, params) }; } catch (e) { return { err: e.message }; } };
  const v = async (who, sql, params) => { const r = await t(who, sql, params); return r.err ? r : { v: Object.values(r.rows[0])[0] }; };
  const svc = (sql, params) => v('service', sql, params);

  // set-up: region, class, consents for l1, l2, l3 (l4 has none)
  const setup = (await v('admin', 'select pilot_setup_region(10::smallint, $1::jsonb)', [JSON.stringify([{ school_id: S.A, setting: 'rural' }])])).v;
  const cls = setup.schools[0].classes.find((c) => c.grade === 11);
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [cls.id, 'tA@test.na']);
  for (const k of ['l1', 'l2', 'l3', 'l4']) await v(k, 'select pilot_join_class($1)', [cls.code]);
  await svc('select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'school', school_id: S.A, given_by_name: 'P', given_by_relation: 'principal', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20' })]);
  for (const k of ['l1', 'l2', 'l3']) await svc('select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'guardian', learner_id: U[k], given_by_name: 'M', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20' })]);

  let attempts = 0;
  const send = async (k, at, o = {}) => {
    attempts++;
    const p = { recipient_kind: 'learner', learner_id: U[k], channel: o.channel || 'in_app', purpose: 'follow_up', body: o.body || 'Hi! Quick one: what is 3x when x = 4?', content_ok: o.content_ok === undefined ? true : o.content_ok, content_reason: o.content_reason || null };
    return (await svc('select pilot_log_message($1::jsonb, $2::timestamptz)', [JSON.stringify(p), at])).v;
  };
  const inbox = async (k) => (await db.query('select count(*)::int n from learner_messages where learner_id = $1', [U[k]])).rows[0].n;

  console.log('\n1. Consent');
  let r = await send('l4', WED_AFTER);
  ok(r.status === 'blocked' && r.reason === 'no_consent' && (await inbox('l4')) === 0, 'a learner without consent gets nothing; the attempt is logged as blocked', r);
  r = await send('l1', WED_AFTER);
  ok(r.status === 'sent' && (await inbox('l1')) === 1, 'a consented learner inside the allowed hours gets the message in the app', r);

  console.log('\n2. Allowed hours (Namibian time)');
  r = await send('l2', WED_SCHOOL);
  ok(r.status === 'blocked' && r.reason === 'outside_hours', 'no messages during school lessons (Wednesday 10:00)', r);
  r = await send('l2', WED_LATE);
  ok(r.status === 'blocked' && r.reason === 'outside_hours', 'no messages late at night (Wednesday 22:30)', r);
  r = await send('l2', WED_EDGE_END);
  ok(r.status === 'sent', 'the last allowed minute on a weekday (19:30) is allowed', r);
  r = await send('l2', WED_EDGE_PAST);
  ok(r.status === 'blocked' && r.reason === 'outside_hours', 'one minute later (19:31) is blocked', r);
  r = await send('l2', SAT_MORNING);
  ok(r.status === 'sent', 'Saturday 10:00 is allowed', r);
  r = await send('l2', SAT_EVENING);
  ok(r.status === 'blocked' && r.reason === 'outside_hours', 'Saturday 20:00 is blocked', r);

  console.log('\n3. Weekly limit');
  r = await send('l3', WED_AFTER); r = await send('l3', WED_AFTER); r = await send('l3', WED_AFTER);
  ok(r.status === 'sent', 'three messages in one week are allowed');
  r = await send('l3', SAT_MORNING);
  ok(r.status === 'blocked' && r.reason === 'weekly_limit', 'the fourth message in the same week is blocked', r);
  r = await send('l3', NEXT_MON);
  ok(r.status === 'sent', 'the limit starts again on Monday', r);
  const blockedDoNotCount = await send('l1', WED_SCHOOL);
  r = await send('l1', SAT_MORNING);
  ok(blockedDoNotCount.status === 'blocked' && r.status === 'sent', 'blocked messages do not use up the weekly limit');

  console.log('\n4. Text messages');
  const week3 = (d) => NA(`2027-03-0${d}T16:00:00`);
  r = await send('l2', week3(1), { channel: 'sms' });
  ok(r.status === 'approved', 'a text message that passes every rule is approved for sending', r);
  await send('l2', week3(2), { channel: 'sms' });
  r = await send('l2', week3(3), { channel: 'sms' });
  ok(r.status === 'blocked' && r.reason === 'weekly_sms_limit', 'a third text message in one week is blocked', r);
  r = await send('l2', week3(3), { channel: 'in_app' });
  ok(r.status === 'sent', 'an in-app message is still allowed after two text messages (3 in total)', r);

  console.log('\n5. Pause');
  await db.query('insert into agent_pauses (learner_id, paused_by) values ($1, $2)', [U.l1, U.tA]);
  r = await send('l1', NA('2027-03-10T16:00:00'));
  ok(r.status === 'blocked' && r.reason === 'paused', 'a paused learner gets nothing, checked at the moment of sending', r);
  await db.query('update agent_pauses set resumed_at = now(), resumed_by = $2 where learner_id = $1 and resumed_at is null', [U.l1, U.tA]);
  r = await send('l1', NA('2027-03-10T16:05:00'));
  ok(r.status === 'sent', 'after resuming, messages flow again', r);

  console.log('\n6. Content check');
  r = await send('l1', NA('2027-03-17T16:00:00'), { content_ok: false, content_reason: 'contains a link' });
  ok(r.status === 'blocked' && r.reason === 'content', 'a message that failed the content check is blocked', r);
  attempts++;
  r = (await svc('select pilot_log_message($1::jsonb, $2::timestamptz)', [JSON.stringify({ recipient_kind: 'learner', learner_id: U.l1, channel: 'in_app', purpose: 'follow_up', body: 'Hello' }), NA('2027-03-17T16:01:00')])).v;
  ok(r.status === 'blocked' && r.reason === 'content', 'a message that skipped the content check is blocked too', r);
  r = await send('l4', WED_SCHOOL, { content_ok: false });
  ok(r.reason === 'no_consent', 'when several rules fail, consent is reported first');

  console.log('\n7. Withdrawal is immediate');
  await v('tA', 'select pilot_withdraw_guardian_consent($1::uuid, $2)', [U.l3, 'parent asked']);
  r = await send('l3', NA('2027-03-17T16:00:00'));
  ok(r.status === 'blocked' && r.reason === 'no_consent', 'the first message after a withdrawal is blocked', r);

  console.log('\n8. Every attempt is logged');
  const logged = (await db.query("select count(*)::int n from message_log where recipient_kind = 'learner'")).rows[0].n;
  ok(logged === attempts, `all ${attempts} attempts are in the log, sent or blocked`, { logged, attempts });
  const one = (await db.query("select checks from message_log where block_reason = 'outside_hours' limit 1")).rows[0].checks;
  ok(one.hours === false && one.consent === true && one.local_time === 'Wed 10:00', 'each log entry keeps every check and the Namibian time', one);

  console.log('\n9. Review on request');
  let smp = (await v('admin', 'select pilot_message_sample(20, null, true)')).v;
  ok(smp.length === 20 && smp.every((m) => /^P[0-9A-F]{12}$/.test(m.who)) && !JSON.stringify(smp).includes('Learner l'), 'administrator gets a random sample of 20, shown by pseudonymous ID, no names', smp.length);
  smp = (await v('admin', 'select pilot_message_sample(50, $1, false)', ['blocked'])).v;
  const nBlocked = (await db.query("select count(*)::int n from message_log where status = 'blocked'")).rows[0].n;
  ok(smp.length === nBlocked && smp.every((m) => m.status === 'blocked' && m.reason), 'administrator can list every blocked message with its reason', { got: smp.length, nBlocked });
  const stats = (await v('admin', 'select pilot_message_stats(3650)')).v;
  ok(stats.total === attempts && stats.blocked_by.outside_hours === 5 && stats.blocked_by.no_consent === 3, 'counts by status and by reason', stats);
  r = await v('tA', 'select pilot_message_sample(20, null, true)');
  ok(r.err, 'teachers cannot read the message log');

  console.log('\n10. Rules can be changed only by administrators, within safe bounds');
  r = await v('tA', 'select pilot_set_messaging_rules($1::jsonb)', [JSON.stringify({ weekly_limit: 10 })]);
  ok(r.err, 'a teacher cannot change the rules');
  r = await v('admin', 'select pilot_set_messaging_rules($1::jsonb)', [JSON.stringify({ weekday_start: '20:00', weekday_end: '19:00' })]);
  ok(r.err && /Check the times/.test(r.err), 'a start time after the end time is refused', r);
  r = await v('admin', 'select pilot_set_messaging_rules($1::jsonb)', [JSON.stringify({ weekly_limit: 1, weekly_sms_limit: 1 })]);
  ok(!r.err && r.v.weekly_limit === 1, 'administrator lowers the weekly limit to 1', r);
  const wk = NA('2027-04-07T16:00:00');
  await send('l1', wk); r = await send('l1', wk);
  ok(r.status === 'blocked' && r.reason === 'weekly_limit', 'the new limit applies straight away', r);

  console.log('\n11. Security');
  r = await t('tA', 'select pilot_log_message($1::jsonb)', [JSON.stringify({ learner_id: U.l1, channel: 'in_app', purpose: 'test', body: 'x', content_ok: true })]);
  ok(r.err && /permission denied/.test(r.err), 'nobody can send through the gate except the server');
  r = await t('l1', 'select * from message_log');
  ok(!r.err && r.rows.length === 0, 'the message log cannot be read directly');
  const mine = (await v('l1', 'select pilot_my_messages()')).v;
  const l2mine = (await v('l2', 'select pilot_my_messages()')).v;
  ok(mine.length === 4 && l2mine.length === 3 && mine.every((m) => m.body), 'each learner sees only their own messages', { l1: mine.length, l2: l2mine.length });
  await v('l1', 'select pilot_mark_messages_read()');
  ok((await v('l1', 'select pilot_my_messages()')).v.every((m) => m.read), 'learner can mark their messages as read');

  console.log('\n12. Delivery and teacher messages');
  const appr = (await db.query("select id from message_log where status = 'approved' order by id limit 1")).rows[0].id;
  await svc('select pilot_mark_delivery($1::bigint, true, $2, 0.05)', [appr, 'prov-1']);
  const d = (await db.query('select status, cost_usd from message_log where id = $1', [appr])).rows[0];
  ok(d.status === 'sent' && Number(d.cost_usd) === 0.05, 'a delivered text message is marked sent with its cost');
  const blk = (await db.query("select id from message_log where status = 'blocked' limit 1")).rows[0].id;
  await svc('select pilot_mark_delivery($1::bigint, true, $2, 0)', [blk, 'x']);
  ok((await db.query('select status from message_log where id = $1', [blk])).rows[0].status === 'blocked', 'a blocked message can never be turned into a sent one');
  r = (await svc('select pilot_log_message($1::jsonb, $2::timestamptz)', [JSON.stringify({ recipient_kind: 'teacher', teacher_id: U.tA, channel: 'email', purpose: 'monday_summary', body: 'Summary', content_ok: true }), NA('2027-03-15T06:00:00')])).v;
  ok(r.status === 'approved', 'a teacher summary is checked and logged too (learner hours do not apply)', r);

  console.log('\n13. Withdrawal removes messages');
  const pend = (await v('admin', 'select pilot_pending_removals()')).v;
  await v('admin', 'select pilot_remove_data($1::bigint)', [pend[0].id]);
  const left = (await db.query('select (select count(*) from message_log where learner_id = $1)::int a, (select count(*) from learner_messages where learner_id = $1)::int b', [U.l3])).rows[0];
  ok(left.a === 0 && left.b === 0, "removing a withdrawn learner's pilot data deletes their messages and log entries", left);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message, e.where || ''); process.exit(2); });
