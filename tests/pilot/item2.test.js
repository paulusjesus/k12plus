// Item 2 acceptance tests: consent records.
// "Done when: an unconsented learner is blocked from pilot features and from every
//  report and export, and withdrawing consent takes effect immediately."
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql'].map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@test.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, school_id, country, learner_uid) values ($1,$2,$3,$4,$5,$6,$7)',
      [U[key], o.name || key, role, o.grade || null, o.school || null, 'Namibia', o.uid || null]);
  };
  for (const [k, n, r] of [['A', 'Tsandi SS', 'Omusati (Tsandi)'], ['B', 'Outapi SS', 'Omusati (Outapi)'], ['K', 'Windhoek HS', 'Khomas (Windhoek)']])
    S[k] = (await db.query("insert into schools (name, region, country) values ($1,$2,'Namibia') returning id", [n, r])).rows[0].id;
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  await mk('admin', 'learner'); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  for (const k of ['tA', 'tB', 'champ', 'champK']) await mk(k, 'educator');
  for (const k of ['l1', 'l2', 'l3']) await mk(k, 'learner', { grade: 11, uid: 'K12-NA-' + k.toUpperCase() + 'XXXX' });

  const as = (who, sql, params = []) => db.transaction(async (tx) => {
    const role = who === 'service' ? 'service_role' : 'authenticated';
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who === 'service' ? { role } : { sub: U[who], role })]);
    await tx.query(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
  const t = async (who, sql, params) => { try { return { rows: await as(who, sql, params) }; } catch (e) { return { err: e.message }; } };
  const v = async (who, sql, params) => { const r = await t(who, sql, params); return r.err ? r : { v: Object.values(r.rows[0])[0] }; };

  // pilot set-up from item 1
  const setup = await v('admin', 'select pilot_setup_region(10::smallint, $1::jsonb)', [JSON.stringify([{ school_id: S.A, setting: 'rural' }, { school_id: S.B, setting: 'urban' }])]);
  const cls = Object.fromEntries(setup.v.schools.flatMap((s) => s.classes.map((c) => [(s.name[0]) + c.grade, c])));
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [cls.T11.id, 'tA@test.na']);
  await v('admin', 'select pilot_assign_teacher($1::uuid, $2)', [cls.O11.id, 'tB@test.na']);
  await v('admin', 'select pilot_set_champion(10::smallint, $1)', ['champ@test.na']);
  await v('admin', 'select pilot_set_champion(6::smallint, $1)', ['champK@test.na']);
  await v('l1', 'select pilot_join_class($1)', [cls.T11.code]);
  await v('l2', 'select pilot_join_class($1)', [cls.T11.code]);
  await v('l3', 'select pilot_join_class($1)', [cls.O11.code]);

  const active = async (k) => (await db.query('select pilot_active($1) a', [U[k]])).rows[0].a;
  const records = async () => (await as('admin', 'select pseudo_id from pilot_learner_records()')).length;
  const overview = async () => (await v('admin', 'select pilot_overview()')).v.find((r) => r.region === 'Omusati');
  const save = (p) => t('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify(p)]);
  const guardian = (k, extra = {}) => save({ kind: 'guardian', learner_id: U[k], given_by_name: 'Parent of ' + k, given_by_relation: 'Mother', method: 'paper_form', evidence_path: `guardian/${U[k]}/1.jpg`, signed_on: '2026-10-20', recorded_by: U.tA, ...extra });
  const school = (s) => save({ kind: 'school', school_id: S[s], given_by_name: 'Principal ' + s, given_by_relation: 'principal', method: 'paper_form', evidence_path: `school/${S[s]}/1.jpg`, signed_on: '2026-10-19', recorded_by: U.admin });

  console.log('\n1. Without consent a learner is not taking part');
  ok(!(await active('l1')), 'joined a class but no consent: not taking part');
  ok((await records()) === 0, 'not in the pilot learner records');
  let o = await overview();
  ok(o.learners === 0 && o.awaiting === 3, 'overview counts 0 taking part, 3 awaiting consent', o);
  let me = (await v('l1', 'select pilot_whoami()')).v;
  ok(me.class && me.class.taking_part === false && me.class.consent.school === false && me.class.consent.guardian === null, 'learner sees that consent is still needed', me.class);
  let mc = (await v('tA', 'select pilot_my_classes()')).v[0];
  ok(mc.school_consent === false && mc.learners.every((l) => l.taking_part === false), 'teacher sees who is waiting for consent');

  console.log('\n2. Both consents are needed');
  let r = await guardian('l1');
  ok(!r.err && !(await active('l1')), 'parent consent alone is not enough (no school consent yet)', r.err);
  r = await school('A');
  ok(!r.err && (await active('l1')), 'with school and parent consent the learner takes part', r.err);
  ok(!(await active('l2')), 'a classmate without parent consent still does not take part');
  r = await school('B');
  ok(!(await active('l3')), 'school consent alone is not enough');
  ok((await records()) === 1, 'only the consented learner appears in the pilot learner records');
  o = await overview();
  ok(o.learners === 1 && o.awaiting === 2 && o.school_consents === 2, 'overview: 1 taking part, 2 awaiting, 2 schools consented', o);
  const rd = (await v('champ', 'select pilot_region_detail(10::smallint)')).v;
  const t11 = rd.schools.flatMap((s) => s.classes).find((c) => c.id === cls.T11.id);
  ok(t11.learners === 2 && t11.taking_part === 1 && rd.schools.every((s) => s.consent), 'champion sees class counts and school consent', t11);
  mc = (await v('tA', 'select pilot_my_classes()')).v[0];
  const l1row = mc.learners.find((l) => l.id === U.l1);
  ok(l1row.taking_part && l1row.consent.guardian.name === 'Parent of l1' && l1row.consent.guardian.relation === 'mother', 'teacher sees who gave consent and how they are related', l1row.consent);

  console.log('\n3. Records are checked');
  r = await save({ kind: 'guardian', learner_id: U.l2, given_by_name: 'X', given_by_relation: 'father', method: 'paper_form', signed_on: '2026-10-20' });
  ok(r.err, 'a paper consent must have the scanned form');
  r = await save({ kind: 'guardian', learner_id: U.l2, given_by_name: 'X', given_by_relation: 'father', method: 'text_message', signed_on: '2026-10-20' });
  ok(r.err, 'a text message consent must have the parent\'s phone number');
  r = await guardian('l1', { given_by_name: 'Father of l1', given_by_relation: 'father', evidence_path: 'guardian/x/2.jpg' });
  const rows = (await db.query("select status from consents where learner_id = $1 order by id", [U.l1])).rows.map((x) => x.status);
  ok(!r.err && rows.join() === 'replaced,given' && (await active('l1')), 'a new form replaces the old one and keeps both on record', rows);

  console.log('\n4. Nobody can go around the rules');
  r = await t('tA', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'guardian', learner_id: U.l2 })]);
  ok(r.err && /permission denied/.test(r.err), 'teachers cannot write consent records directly (only through the checked upload)');
  r = await t('tA', 'select * from consents');
  ok(!r.err && r.rows.length === 0, 'consent records cannot be read directly');
  r = await t('admin', 'select * from pilot_participants');
  ok(r.err && /permission denied/.test(r.err), 'the participants list cannot be read directly, not even by an administrator');
  r = await t('l2', 'select pilot_active($1::uuid)', [U.l2]);
  ok(r.err && /permission denied/.test(r.err), 'learners cannot call the consent check themselves');
  ok((await v('tA', 'select pilot_can_manage_learner($1::uuid)', [U.l1])).v === true, 'class teacher may record consent for their learner');
  ok((await v('tB', 'select pilot_can_manage_learner($1::uuid)', [U.l1])).v === false, "another class's teacher may not");
  ok((await v('champ', 'select pilot_can_manage_school($1::uuid)', [S.A])).v === true, 'regional champion may record school consent in their region');
  ok((await v('champK', 'select pilot_can_manage_school($1::uuid)', [S.A])).v === false, 'a champion from another region may not');
  ok((await v('tA', 'select pilot_can_manage_school($1::uuid)', [S.A])).v === false, 'a teacher may not record school consent');

  console.log('\n5. Withdrawing consent takes effect immediately');
  await guardian('l2');
  ok(await active('l2'), 'l2 takes part after consent');
  r = await v('tB', 'select pilot_withdraw_guardian_consent($1::uuid, $2)', [U.l2, 'parent asked']);
  ok(r.err && /teachers/.test(r.err), "another class's teacher cannot withdraw consent", r);
  r = await v('tA', 'select pilot_withdraw_guardian_consent($1::uuid, $2)', [U.l2, 'Parent phoned the school']);
  ok(!r.err && !(await active('l2')), 'teacher records the withdrawal and the learner stops taking part at once', r);
  ok((await records()) === 1, 'withdrawn learner is gone from the pilot learner records at once');
  me = (await v('l2', 'select pilot_whoami()')).v;
  ok(me.class.taking_part === false && me.class.consent.withdrawn === true, 'learner view shows the withdrawal');
  let pend = (await v('admin', 'select pilot_pending_removals()')).v;
  ok(pend.length === 1 && /^P[0-9A-F]{12}$/.test(pend[0].pseudo_id) && !JSON.stringify(pend).includes('l2'), 'pilot data is flagged for removal (shown by pseudonymous ID, no name)', pend);
  r = await v('tA', 'select pilot_withdraw_guardian_consent($1::uuid, $2)', [U.l2, 'again']);
  ok(r.err && /no consent/.test(r.err), 'withdrawing twice gives a clear message');
  const wrow = (await db.query("select withdrawn_by, withdrawal_reason from consents where learner_id = $1 and status = 'withdrawn'", [U.l2])).rows[0];
  ok(wrow.withdrawn_by === U.tA && wrow.withdrawal_reason === 'Parent phoned the school', 'the withdrawal records who and why');

  console.log('\n6. Consent given again');
  await guardian('l2');
  pend = (await v('admin', 'select pilot_pending_removals()')).v;
  ok((await active('l2')) && pend.length === 0, 'new consent restores taking part and cancels the pending removal');

  console.log('\n7. School withdrawal');
  r = await v('champK', 'select pilot_withdraw_school_consent($1::uuid, $2)', [S.A, 'x']);
  ok(r.err, 'a champion from another region cannot withdraw school consent');
  r = await v('tA', 'select pilot_withdraw_school_consent($1::uuid, $2)', [S.A, 'x']);
  ok(r.err, 'a teacher cannot withdraw school consent');
  r = await v('champ', 'select pilot_withdraw_school_consent($1::uuid, $2)', [S.A, 'School board decision']);
  ok(!r.err && !(await active('l1')) && !(await active('l2')), 'school withdrawal stops every learner at that school at once', r);
  pend = (await v('admin', 'select pilot_pending_removals()')).v;
  ok(pend.length === 2, 'both learners are flagged for data removal', pend.length);
  ok((await records()) === 0, 'no learner from that school is left in the records');

  console.log('\n8. Removing flagged data');
  r = await v('tA', 'select pilot_pending_removals()');
  ok(r.err, 'only administrators see the removal list');
  r = await v('admin', 'select pilot_remove_data($1::bigint)', [pend[0].id]);
  ok(!r.err && (await v('admin', 'select pilot_pending_removals()')).v.length === 1, 'administrator removes the data and the flag is closed', r);
  await school('A');
  r = await v('admin', 'select pilot_remove_data($1::bigint)', [pend[1].id]);
  ok(r.err && /consent again/.test(r.err), 'data cannot be removed for a learner who has consent again', r);

  console.log('\n9. Leaving the class');
  await v('tA', 'select pilot_remove_learner($1::uuid, $2::uuid)', [cls.T11.id, U.l1]);
  ok(!(await active('l1')), 'a learner removed from the class stops taking part even with consent');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message, e.where || ''); process.exit(2); });
