// Item 8 acceptance tests: usage and data-cost reports.
// "Done when: a monthly report for all 28 schools can be produced in one step, and the
//  data-spend alert fires in a test."
// 28 schools in 14 regions (one rural, one urban each) get a month of activity. Every
// figure in the one-step report is checked against a count made separately in this file.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql'].map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 600)); } };

// a small fixed random generator, so every run uses the same activity
let seed = 20261029;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const NA = (s) => new Date(s + '+02:00'); // Namibian local time
const TOPICS = ['Algebra', 'Geometry', 'Statistics', 'Trigonometry', 'Functions', 'Probability'];

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));
  const U = {}, S = [];
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@test.na'])).rows[0].id;
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
  const consent = (b) => v('service', 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-08-20', ...b })]);
  await mk('admin', 'learner'); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('teacher', 'educator'); await mk('champ', 'educator', { name: 'Champion Erongo' });
  const regions = (await db.query('select id, name from regions order by id')).rows;

  // ---- 28 pilot schools, each with a Grade 11 and a Grade 12 class ----
  const L = []; // learners: { key, school, cls, grade, consent }
  for (const r of regions) {
    const pair = [];
    for (const setting of ['rural', 'urban']) {
      const name = `${r.name} ${setting === 'rural' ? 'Rural' : 'Urban'} SS`;
      const id = (await db.query("insert into schools (name, region, country, region_id) values ($1, $2, 'Namibia', $3) returning id", [name, r.name, r.id])).rows[0].id;
      pair.push({ school_id: id, setting }); S.push({ id, name, region: r.name, region_id: r.id, setting });
    }
    const set = (await v('admin', 'select pilot_setup_region($1::smallint, $2::jsonb)', [r.id, JSON.stringify(pair)])).v;
    for (const sc of set.schools) {
      const s = S.find((x) => x.id === sc.id);
      s.classes = sc.classes;
      await consent({ kind: 'school', school_id: sc.id, given_by_relation: 'principal' });
      // Grade 11: three learners with consent and one without; Grade 12: one learner with consent
      const spec = [[11, true], [11, true], [11, true], [11, false], [12, true]];
      for (let i = 0; i < spec.length; i++) {
        const [grade, withConsent] = spec[i];
        const key = `L${S.indexOf(s)}_${i}`;
        await mk(key, 'learner', { name: 'Learner ' + key, grade, phone: '0812' + String(S.indexOf(s)).padStart(3, '0') + i + '00', uid: 'K12-NA-' + key });
        const cls = sc.classes.find((c) => c.grade === grade);
        await v(key, 'select pilot_join_class($1)', [cls.code]);
        if (withConsent) await consent({ kind: 'guardian', learner_id: U[key] });
        L.push({ key, school: s, cls, grade, consent: withConsent });
      }
    }
  }
  await v('admin', "select pilot_set_champion($1::smallint, 'champ@test.na')", [1]); // Erongo
  ok(S.length === 28 && L.length === 140, 'set-up: 28 pilot schools in 14 regions, 140 learners (112 with consent)', { schools: S.length, learners: L.length });

  // ---- September 2026 activity ----
  const E = []; // { key, kind, at, topic, attempted, duration, bytes }
  for (const l of L) {
    const nSessions = Math.floor(rnd() * 4); // 0 to 3 sessions in the month
    const days = [3, 9, 15, 22, 28].sort(() => rnd() - 0.5).slice(0, nSessions);
    for (const d of days) {
      const start = NA(`2026-09-${String(d).padStart(2, '0')}T${pick(['15', '16', '17', '18'])}:00:00`).getTime();
      const nq = Math.floor(rnd() * 4);
      for (let q = 0; q < nq; q++) E.push({ key: l.key, kind: 'question', at: new Date(start + q * 4 * 60e3), topic: pick(TOPICS) });
      E.push({ key: l.key, kind: 'practice', at: new Date(start + 14 * 60e3), topic: pick(TOPICS), attempted: 1 + Math.floor(rnd() * 8), correct: 0 });
      E.push({ key: l.key, kind: 'active', at: new Date(start + 15 * 60e3), duration: 60 * (5 + Math.floor(rnd() * 20)) });
      E.push({ key: l.key, kind: 'data', at: new Date(start + 16 * 60e3), bytes: 200000 + Math.floor(rnd() * 3000000) });
    }
    if (rnd() < 0.3) E.push({ key: l.key, kind: 'ussd', at: NA('2026-09-12T10:00:00') }); // a USSD session on its own
  }
  // a learner with a known pattern: 29 minutes later is the same session, 31 minutes later a new one
  const known = L.find((l) => l.consent && l.school.region === 'Khomas' && l.grade === 11);
  E.splice(0, E.length, ...E.filter((e) => e.key !== known.key));
  const kt = (t) => NA('2026-09-05T' + t);
  E.push({ key: known.key, kind: 'question', at: kt('15:00:00'), topic: 'Algebra' }, { key: known.key, kind: 'question', at: kt('15:29:00'), topic: 'Algebra' },
         { key: known.key, kind: 'practice', at: kt('16:00:00'), topic: 'Geometry', attempted: 5 }, // 31 minutes later: session 2
         { key: known.key, kind: 'active', at: kt('16:01:00'), duration: 1200 }, { key: known.key, kind: 'data', at: kt('19:00:00'), bytes: 1500000 }, // data is not a session
         { key: known.key, kind: 'ussd', at: kt('20:00:00') }); // session 3
  // outside the month, either side of the Namibian month boundary
  const anyone = L.find((l) => l.consent && l.key !== known.key);
  E.push({ key: anyone.key, kind: 'question', at: NA('2026-08-31T23:30:00'), topic: 'Outside' }, { key: anyone.key, kind: 'data', at: NA('2026-10-01T00:10:00'), bytes: 9000000 });
  // activity recorded before a learner's consent was withdrawn must not appear: give it to a learner without consent
  const noConsent = L.find((l) => !l.consent);
  E.push({ key: noConsent.key, kind: 'question', at: NA('2026-09-10T15:00:00'), topic: 'Hidden' }, { key: noConsent.key, kind: 'data', at: NA('2026-09-10T15:05:00'), bytes: 5000000 });
  let ref = 0;
  for (const e of E) {
    const l = L.find((x) => x.key === e.key);
    await db.query('insert into learning_events (learner_id, class_id, kind, topic, attempted, correct, duration_seconds, bytes, client_ref, occurred_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [U[e.key], l.cls.id, e.kind, e.topic || null, e.attempted || null, e.correct || null, e.duration || null, e.bytes || null, 'seed-' + String(++ref).padStart(6, '0'), e.at.toISOString()]);
  }
  // text messages: two sent in September (one with a known cost), one waiting for a provider, one in October, one to a teacher
  const smsL = L.filter((l) => l.consent)[3];
  const msg = (o) => db.query("insert into message_log (recipient_kind, learner_id, teacher_id, channel, purpose, body, status, cost_usd, created_at, delivered_at) values ($1,$2,$3,'sms','follow_up','x',$4,$5,$6,$7)",
    [o.teacher ? 'teacher' : 'learner', o.teacher ? null : U[o.key], o.teacher ? U.teacher : null, o.status || 'sent', o.cost == null ? null : o.cost, o.at, o.status === 'approved' ? null : o.at]);
  await msg({ key: smsL.key, at: NA('2026-09-08T16:00:00') }); await msg({ key: smsL.key, at: NA('2026-09-15T16:00:00'), cost: 0.07 });
  await msg({ key: smsL.key, at: NA('2026-09-16T16:00:00'), status: 'approved' }); await msg({ key: smsL.key, at: NA('2026-10-02T16:00:00') });
  await msg({ teacher: true, at: NA('2026-09-07T06:00:00') });
  // costs typed in: data bundles for one school in September, one for the whole pilot, one in October (not counted)
  const bundleSchool = S.find((s) => s.region === 'Oshana' && s.setting === 'rural');
  ok((await v('admin', 'select pilot_add_cost_entry($1::jsonb)', [JSON.stringify({ school_id: bundleSchool.id, month: '2026-09-01', amount_usd: 40, note: 'Data bundles' })])).v.ok, 'K-12 EdTech can type in costs, such as data bundles bought for a school');
  await v('admin', 'select pilot_add_cost_entry($1::jsonb)', [JSON.stringify({ month: '2026-09-14', amount_usd: 100, kind: 'other', note: 'Pilot-wide' })]);
  await v('admin', 'select pilot_add_cost_entry($1::jsonb)', [JSON.stringify({ school_id: bundleSchool.id, month: '2026-10-01', amount_usd: 99 })]);
  ok(/school is not in the pilot/.test((await v('admin', 'select pilot_add_cost_entry($1::jsonb)', [JSON.stringify({ school_id: U.admin, month: '2026-09-01', amount_usd: 5 })])).err || ''), 'costs can only be typed in for pilot schools');
  ok(/administrators/.test((await v('teacher', 'select pilot_add_cost_entry($1::jsonb)', [JSON.stringify({ month: '2026-09-01', amount_usd: 5 })])).err || ''), 'only administrators can type in costs');

  // ---- the count made separately, in this file ----
  const RATES = { gb: 1.2, sms: 0.05, ussd: 0.03 };
  const from = NA('2026-09-01T00:00:00'), to = NA('2026-10-01T00:00:00');
  const inP = (e) => e.at >= from && e.at < to;
  const per = {};
  for (const l of L.filter((x) => x.consent)) {
    const ev = E.filter((e) => e.key === l.key && inP(e)).sort((a, b) => a.at - b.at);
    const act = ev.filter((e) => e.kind !== 'data');
    let sessions = 0, last = null;
    for (const e of act) { if (!last || e.at - last > 30 * 60e3) sessions++; last = e.at; }
    const smsN = l.key === smsL.key ? 2 : 0, smsCost = l.key === smsL.key ? 0.05 + 0.07 : 0;
    const bytes = ev.filter((e) => e.kind === 'data').reduce((a, e) => a + e.bytes, 0);
    const ussd = ev.filter((e) => e.kind === 'ussd').length;
    per[l.key] = { l, active: act.length > 0, sessions, seconds: ev.filter((e) => e.kind === 'active').reduce((a, e) => a + e.duration, 0),
      questions: ev.filter((e) => e.kind === 'question').length, practice: ev.filter((e) => e.kind === 'practice').reduce((a, e) => a + e.attempted, 0),
      topics: new Set(ev.filter((e) => e.topic).map((e) => e.topic)), ussd, bytes, sms: smsN, smsCost, cost: bytes / 1e9 * RATES.gb + ussd * RATES.ussd + smsCost };
  }
  const sumUp = (list, extraOther = 0, extraSms = 0, extraSmsCost = 0) => {
    const t = { learners: list.length, active: 0, sessions: 0, seconds: 0, questions: 0, practice: 0, ussd: 0, bytes: 0, sms: extraSms, smsCost: extraSmsCost, topics: new Set(), other: extraOther };
    for (const p of list) { t.active += p.active ? 1 : 0; t.sessions += p.sessions; t.seconds += p.seconds; t.questions += p.questions; t.practice += p.practice; t.ussd += p.ussd; t.bytes += p.bytes; t.sms += p.sms; t.smsCost += p.smsCost; p.topics.forEach((x) => t.topics.add(x)); }
    const total = t.bytes / 1e9 * RATES.gb + t.smsCost + t.ussd * RATES.ussd + t.other;
    return { learners: t.learners, active: t.active, sessions: t.sessions, minutes: Math.round(t.seconds / 60), questions: t.questions, practice: t.practice, topics: t.topics.size,
      ussd: t.ussd, data_mb: Math.round(t.bytes / 1e5) / 10, sms: t.sms, cost_total: Math.round(total * 100) / 100,
      cost_per_learner: t.learners ? Math.round(total / t.learners * 100) / 100 : null };
  };
  const P = Object.values(per);
  const expectSchool = (s) => sumUp(P.filter((p) => p.l.school === s), s === bundleSchool ? 40 : 0);
  const fields = ['learners', 'active', 'sessions', 'minutes', 'questions', 'practice', 'topics', 'ussd', 'data_mb', 'sms', 'cost_total', 'cost_per_learner'];
  const same = (row, exp) => fields.every((f) => (row[f] === null ? null : Number(row[f])) === exp[f]);
  const diff = (row, exp) => fields.filter((f) => (row[f] === null ? null : Number(row[f])) !== exp[f]).map((f) => `${f}: report ${row[f]}, count ${exp[f]}`);

  console.log('\n1. The monthly report for all 28 schools, in one step');
  const t0 = Date.now();
  let r = await v('admin', "select pilot_usage_report('2026-09-01', '2026-09-30')");
  const ms = Date.now() - t0;
  const rep = r.v;
  ok(rep && rep.rows.filter((x) => x.level === 'school').length === 28, 'one call gives a row for every one of the 28 schools', { ms, err: r.err });
  let bad = [];
  for (const s of S) {
    const row = rep.rows.find((x) => x.level === 'school' && x.school_id === s.id);
    const exp = expectSchool(s);
    if (!row || !same(row, exp)) bad.push({ school: s.name, diff: row ? diff(row, exp) : 'missing' });
  }
  ok(bad.length === 0, 'every figure for every school matches the separate count (learners, active, sessions, minutes, questions, practice, topics, USSD, data, texts, cost)', bad.slice(0, 3));
  bad = [];
  for (const g of regions) {
    const row = rep.rows.find((x) => x.level === 'region' && x.region === g.name);
    const exp = sumUp(P.filter((p) => p.l.school.region === g.name), g.name === 'Oshana' ? 40 : 0);
    if (!row || !same(row, exp)) bad.push({ region: g.name, diff: row ? diff(row, exp) : 'missing' });
  }
  ok(bad.length === 0, 'the figures for each of the 14 regions match', bad.slice(0, 3));
  bad = [];
  for (const st of ['rural', 'urban']) {
    const row = rep.rows.find((x) => x.level === 'setting' && x.setting === st);
    const exp = sumUp(P.filter((p) => p.l.school.setting === st), st === 'rural' ? 40 : 0);
    if (!row || !same(row, exp)) bad.push({ st, diff: row ? diff(row, exp) : 'missing' });
  }
  ok(bad.length === 0, 'the figures for rural and for urban schools match', bad);
  const tot = rep.rows.find((x) => x.level === 'total');
  const expT = sumUp(P, 140, 1, 0.05);
  ok(same(tot, expT), 'the whole-pilot totals match, including the pilot-wide cost and the text to a teacher', diff(tot, expT));
  const cls = rep.rows.filter((x) => x.level === 'class');
  const c11 = known.cls.id;
  const expC = sumUp(P.filter((p) => p.l.cls.id === c11));
  ok(cls.length === 56 && same(cls.find((x) => x.class_id === c11), expC), 'there is a row for each of the 56 classes, and a class row matches', diff(cls.find((x) => x.class_id === c11) || {}, expC));
  const knownRow = rep.learners.find((x) => x.sessions === 3 && x.questions === 2 && x.practice === 5 && x.ussd === 1 && x.minutes === 20 && Number(x.data_mb) === 1.5);
  ok(!!knownRow, 'sessions follow the rule: 29 minutes later is the same session, 31 minutes later a new one, data records are not sessions (3 sessions)');
  ok(rep.learners.length === 112, 'learners without consent are not in the report at all (112 of 140)', rep.learners.length);
  const txt = JSON.stringify(rep);
  ok(!/Learner L|0812|K12-NA-|Hidden|Outside/.test(txt), 'the report has pilot IDs only: no names, phone numbers, K12Plus IDs, nor activity outside the month or from learners without consent');
  ok(Number(rep.budget_per_learner) === 2.5 && ms < 20000, 'for a calendar month the budget per learner is US$2.50', { budget: rep.budget_per_learner, ms });

  console.log('\n2. Weekly figures');
  r = await v('admin', "select pilot_usage_report('2026-09-07', '2026-09-13')");
  const wFrom = NA('2026-09-07T00:00:00'), wTo = NA('2026-09-14T00:00:00');
  const wEv = E.filter((e) => e.at >= wFrom && e.at < wTo && per[e.key]);
  const wt = r.v.rows.find((x) => x.level === 'total');
  ok(wt.questions === wEv.filter((e) => e.kind === 'question').length && wt.ussd === wEv.filter((e) => e.kind === 'ussd').length
     && Number(wt.data_mb) === Math.round(wEv.filter((e) => e.kind === 'data').reduce((a, e) => a + e.bytes, 0) / 1e5) / 10,
     'any week can be reported the same way, and its figures match', wt);
  ok(Number(r.v.budget_per_learner) === Math.round(2.5 * 7 / 30 * 100) / 100, 'the budget for a week is the monthly budget shared by days (US$0.58)', r.v.budget_per_learner);
  ok(/three months/.test((await v('admin', "select pilot_usage_report('2026-01-01', '2026-09-30')")).err || '') && /start date/.test((await v('admin', "select pilot_usage_report('2026-09-30', '2026-09-01')")).err || ''), 'periods longer than three months, or back to front, are refused politely');

  console.log('\n3. Who may see reports');
  r = await v('champ', "select pilot_usage_report('2026-09-01', '2026-09-30')");
  const cs = r.v && r.v.rows.filter((x) => x.level === 'school');
  ok(cs && cs.length === 2 && cs.every((x) => x.region === 'Erongo') && r.v.learners.every((x) => x.region === 'Erongo'), "a regional champion gets the same report for their own region only", cs && cs.map((x) => x.school));
  ok(same(r.v.rows.find((x) => x.level === 'total'), sumUp(P.filter((p) => p.l.school.region === 'Erongo'))), "the champion's total is their region's total");
  ok(/administrators and regional champions/.test((await v('teacher', "select pilot_usage_report('2026-09-01', '2026-09-30')")).err || '') && /administrators and regional champions/.test((await v(known.key, "select pilot_usage_report('2026-09-01', '2026-09-30')")).err || ''), 'teachers and learners cannot see pilot reports');
  ok(/permission denied/.test((await v('admin', "select pilot_report_core('2026-09-01', '2026-09-30', null)")).err || ''), 'the inner report function cannot be called directly');

  console.log('\n4. Prices can change');
  await v('admin', 'select pilot_set_cost_settings($1::jsonb)', [JSON.stringify({ data_usd_per_gb: 2.4 })]);
  r = await v('admin', "select pilot_usage_report('2026-09-01', '2026-09-30')");
  const t2 = r.v.rows.find((x) => x.level === 'total');
  ok(Math.abs(Number(t2.cost_data) - 2 * Number(tot.cost_data)) <= 0.01, 'doubling the data price doubles the data cost in the report', [tot.cost_data, t2.cost_data]);
  ok(/administrators/.test((await v('champ', 'select pilot_set_cost_settings($1::jsonb)', [JSON.stringify({ sms_usd: 0 })])).err || ''), 'only administrators can change prices');
  ok(/check the prices/.test((await v('admin', 'select pilot_set_cost_settings($1::jsonb)', [JSON.stringify({ budget_per_learner_usd: 0 })])).err || ''), 'a budget of zero is refused');
  await v('admin', 'select pilot_set_cost_settings($1::jsonb)', [JSON.stringify({ data_usd_per_gb: 1.2 })]);

  console.log('\n5. The data-spend alert');
  // one learner who used 3 GB of data in September (US$3.60)
  const heavy = L.find((l) => l.consent && l.school.region === 'Kunene' && l.grade === 12);
  for (let i = 0; i < 30; i++) await db.query("insert into learning_events (learner_id, class_id, kind, bytes, client_ref, occurred_at) values ($1, $2, 'data', 100000000, $3, $4)", [U[heavy.key], heavy.cls.id, 'heavy-' + String(i).padStart(4, '0'), NA('2026-09-20T17:00:00').toISOString()]);
  let n = (await v('service', "select pilot_check_spending('2026-09-25T10:00:00+02:00')")).v;
  let alerts = (await v('admin', 'select pilot_spending_alerts()')).v;
  // the list only shows this month and last month, so read the table for the September test
  const al = (await db.query("select scope, label, per_learner_usd::float p, allowed_usd::float a from cost_alerts where month = '2026-09-01' order by scope, label")).rows;
  const learnerAlert = al.find((a) => a.scope === 'learner');
  const pseudoHeavy = (await db.query('select pseudo_id from enrolments where learner_id = $1', [U[heavy.key]])).rows[0].pseudo_id;
  ok(learnerAlert && learnerAlert.label === pseudoHeavy && learnerAlert.a === 2.08, 'the alert fires for the learner who used 3 GB: above the US$2.08 allowed by 25 September', learnerAlert);
  ok(al.some((a) => a.scope === 'school' && a.label === bundleSchool.name), 'it also fires for the school whose data bundles cost US$40 for 4 learners', al.filter((a) => a.scope === 'school'));
  const flagged = new Set(al.filter((a) => a.scope === 'school').map((a) => a.label));
  const expectFlag = S.filter((s) => { const e = s === bundleSchool ? expectSchool(s) : sumUp(P.filter((p) => p.l.school === s)); const extra = s === heavy.school ? 3.6 / 4 : 0; return e.learners && e.cost_per_learner + extra > 2.08; }).map((s) => s.name);
  ok(flagged.size === expectFlag.length && expectFlag.every((x) => flagged.has(x)), 'and for no school that is within budget', { flagged: [...flagged], expectFlag });
  ok(!al.some((a) => a.scope === 'learner' && a.label !== pseudoHeavy), 'learners within budget raise no alert');
  await v('service', "select pilot_check_spending('2026-09-26T10:00:00+02:00')");
  ok((await db.query("select count(*)::int n from cost_alerts where month = '2026-09-01'")).rows[0].n === al.length, 'running the daily check again updates the alerts without repeating them');
  // early in a month the check treats the month as at least 7 days old
  const early = L.find((l) => l.consent && l.school.region === 'Hardap' && l.grade === 12);
  for (let i = 0; i < 4; i++) await db.query("insert into learning_events (learner_id, class_id, kind, bytes, client_ref, occurred_at) values ($1, $2, 'data', 100000000, $3, $4)", [U[early.key], early.cls.id, 'early-000' + i, NA('2026-08-02T09:00:00').toISOString()]);
  await v('service', "select pilot_check_spending('2026-08-02T12:00:00+02:00')");
  ok((await db.query("select count(*)::int n from cost_alerts where month = '2026-08-01'")).rows[0].n === 0, 'on 2 August a learner who used US$0.48 of data raises no alert (allowed: US$0.56 for the first week, not US$0.16)');
  // the list for administrators, and dismissing
  await db.query("update cost_alerts set month = date_trunc('month', now())::date where month = '2026-09-01'");
  alerts = (await v('admin', 'select pilot_spending_alerts()')).v;
  ok(alerts.length === al.length && alerts[alerts.length - 1].scope === 'learner' && !JSON.stringify(alerts).includes('Learner L'), 'administrators see the alerts, with pilot IDs only', alerts.length);
  await v('admin', 'select pilot_dismiss_alert($1::bigint)', [alerts[0].id]);
  ok((await v('admin', 'select pilot_spending_alerts()')).v.length === al.length - 1, 'an alert can be marked as seen');
  ok(/administrators/.test((await v('champ', 'select pilot_spending_alerts()')).err || ''), 'only administrators see the alert list');
  ok(n >= 2, 'the daily check reports how many alerts it raised', n);

  console.log('\n6. Data use from the phone');
  const live = L.find((l) => l.consent && l.school.region === 'Zambezi');
  const now = new Date().toISOString();
  r = await v(live.key, 'select pilot_record_events($1::jsonb)', [JSON.stringify([
    { kind: 'data', bytes: 123456, client_ref: 'phone-data-0001', occurred_at: now },
    { kind: 'data', bytes: 0, client_ref: 'phone-data-0002', occurred_at: now },
    { kind: 'data', bytes: 60000000, client_ref: 'phone-data-0003', occurred_at: now },
    { kind: 'ussd', client_ref: 'phone-ussd-0001', occurred_at: now }])]);
  const stored = (await db.query("select kind, bytes from learning_events where learner_id = $1 and client_ref like 'phone-%'", [U[live.key]])).rows;
  ok(r.v.stored === 1 && stored.length === 1 && Number(stored[0].bytes) === 123456, 'the app records data use; empty or impossible amounts (0 bytes, 60 MB at once) are ignored, and the app cannot record USSD sessions', stored);
  r = await v(noConsent.key, 'select pilot_record_events($1::jsonb)', [JSON.stringify([{ kind: 'data', bytes: 5000, client_ref: 'phone-data-0009', occurred_at: now }])]);
  ok(r.v.stored === 0, 'nothing is recorded for a learner without consent');

  console.log('\n7. Withdrawal');
  await v('admin', 'select pilot_withdraw_guardian_consent($1::uuid, $2)', [U[heavy.key], 'parent asked']);
  const rem = (await db.query('select id from data_removals where learner_id = $1', [U[heavy.key]])).rows[0].id;
  await v('admin', 'select pilot_remove_data($1::bigint)', [rem]);
  ok((await db.query('select count(*)::int n from cost_alerts where learner_id = $1', [U[heavy.key]])).rows[0].n === 0 && (await db.query('select count(*)::int n from learning_events where learner_id = $1', [U[heavy.key]])).rows[0].n === 0, "removing a learner's pilot data removes their data use and any alert about them");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
