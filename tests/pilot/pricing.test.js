// Pricing (approved 30 October 2026): daily questions by plan, and which model answers.
// Part 1 runs the real migrations in PGlite and checks the plan rules in the database.
// Part 2 runs the real agent code (backend/index.js) against a stand-in for Claude and
// Supabase; the stand-in sends the allowance calls to the same PGlite database.
// Run: node tests/pilot/pricing.test.js
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Module = require('module');

const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql',
  '20261031_pilot_evaluator_export.sql', '20261101_pilot_offline_lessons.sql', '20261102_pilot_ussd.sql', '20261103_plan_allowance.sql']
  .map((f) => path.join(__dirname, '../../backend/migrations', f));
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  for (const m of MIGS) await db.exec(fs.readFileSync(m, 'utf8'));

  // ---------- people ----------
  await db.exec("set session_replication_role = replica"); // seed plans past the staff-only guard
  const U = {};
  const mk = async (k, role, extra = '') => {
    U[k] = (await db.query(`insert into auth.users (email) values ('${k}@test.na') returning id`)).rows[0].id;
    await db.query(`insert into profiles (id, username, role, country) values ($1, $2, $3, 'Namibia')`, [U[k], k, role]);
    if (extra) await db.query(`update profiles set ${extra} where id = $1`, [U[k]]);
  };
  const school = (await db.query("insert into schools (name, region, country, plan) values ('Tsandi SS', 'Omusati (Tsandi)', 'Namibia', 'school') returning id")).rows[0].id;
  const lapsed = (await db.query("insert into schools (name, region, country, plan, plan_expires_at) values ('Old SS', 'Khomas', 'Namibia', 'school', now() - interval '1 day') returning id")).rows[0].id;
  const pilotSchool = (await db.query("insert into schools (name, region, country) values ('Pilot SS', 'Oshana', 'Namibia') returning id")).rows[0].id;
  await mk('free', 'learner');
  await mk('ind', 'learner', "plan = 'individual'");
  await mk('indOld', 'learner', "plan = 'individual', plan_expires_at = now() - interval '1 day'");
  await mk('sch', 'learner', `school_id = '${school}'`);
  await mk('schOld', 'learner', `school_id = '${lapsed}'`);
  await mk('pilot', 'learner');
  await mk('teacher', 'educator');
  await mk('parent', 'parent');
  const cls = (await db.query("insert into classes (school_id, grade, name, class_code) values ($1, 11, 'Grade 11 Mathematics', 'PIL0T1') returning id", [pilotSchool])).rows[0].id;
  await db.query("insert into enrolments (class_id, learner_id, joined_via) values ($1, $2, 'admin')", [cls, U.pilot]);
  await db.query("insert into consents (kind, school_id, given_by_name, given_by_relation, method, evidence_path, signed_on) values ('school', $1, 'Principal', 'principal', 'paper_form', 'consents/s.pdf', current_date)", [pilotSchool]);
  await db.query("insert into consents (kind, learner_id, given_by_name, given_by_relation, method, evidence_path, signed_on) values ('guardian', $1, 'M', 'mother', 'paper_form', 'consents/g.pdf', current_date)", [U.pilot]);
  await db.exec("set session_replication_role = origin");

  const take = async (user, key, t = true) => (await db.query('select public.aim_allowance($1, $2, $3) a', [user, key, t])).rows[0].a;
  const fillUp = async (user, key) => { let a; for (let i = 0; i < 60; i++) { a = await take(user, key); if (!a.allowed) return { a, n: i }; } return { a, n: 60 }; };

  console.log('\nDaily questions by plan, in the database');
  let r = await fillUp(null, 'dev:phone-one');
  ok(r.n === 5 && r.a.plan === 'visitor' && r.a.limit === 5 && r.a.used === 5, 'a visitor on a phone gets 5 questions a day, then is told no', r);
  r = await fillUp(null, 'dev:phone-two');
  ok(r.n === 5, 'another phone has its own 5');
  r = await fillUp(U.free, 'dev:phone-one');
  ok(r.n === 5 && r.a.plan === 'free', 'a signed-in learner on the Free plan gets 5, counted on her account (not the phone)', r);
  r = await fillUp(U.ind, '');
  ok(r.n === 20 && r.a.plan === 'individual', 'the Individual plan gives 20 a day', r);
  r = await fillUp(U.indOld, '');
  ok(r.n === 5 && r.a.plan === 'free', 'an Individual plan that has expired falls back to the Free plan', r);
  r = await fillUp(U.sch, '');
  ok(r.n === 20 && r.a.plan === 'school', 'a learner in a school on the School plan gets 20', r);
  r = await fillUp(U.schOld, '');
  ok(r.n === 5 && r.a.plan === 'free', 'a school whose plan has lapsed does not count', r);
  r = await fillUp(U.pilot, '');
  ok(r.n === 20 && r.a.plan === 'school', 'a pilot learner with both consents counts as the School plan', r);
  r = await fillUp(U.teacher, '');
  ok(r.n === 40 && r.a.plan === 'staff', 'teachers get 40 a day', r);
  r = await fillUp(U.parent, '');
  ok(r.n === 5 && r.a.plan === 'free', 'parents are on the Free plan', r);
  let a = await take(U.free, '', false);
  ok(a.allowed === false && a.used === 5, 'checking without taking does not count a question', a);
  await db.query("update question_allowance set day = day - 1");
  a = await take(U.free, '');
  ok(a.allowed === true && a.used === 1, 'the next day the questions come back');
  await db.query("insert into question_allowance (key, day, questions) values ('dev:old-phone', current_date - 9, 3)");
  await take(null, 'dev:phone-three');
  ok((await db.query("select count(*)::int n from question_allowance where key = 'dev:old-phone'")).rows[0].n === 0, 'counts older than 7 days are deleted');
  const cols = (await db.query("select column_name from information_schema.columns where table_name = 'question_allowance' order by ordinal_position")).rows.map((x) => x.column_name);
  ok(JSON.stringify(cols) === '["key","day","questions"]', 'only counts are kept: who or which phone, the day and how many, never the questions', cols);
  for (const role of ['anon', 'authenticated']) {
    let denied = false;
    try { await db.exec(`set role ${role}`); await take(null, 'dev:x'); } catch { denied = true; } finally { await db.exec('reset role'); }
    ok(denied, `the ${role} role cannot call the allowance function (only the agent's server can)`);
  }

  // ---------- Part 2: the agent ----------
  await db.query('delete from question_allowance');
  const S = { calls: [], down: false, haikuFails: false };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    if (req.url === '/v1/messages') {
      S.calls.push({ model: j.model, system: j.system });
      if (S.haikuFails && /haiku/.test(j.model)) return send(529, { error: 'overloaded' });
      return send(200, { content: [{ type: 'text', text: /JSON/.test(j.system || '') ? '{"title":"Plan"}' : `Answer from ${j.model}` }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' });
    }
    if (req.url === '/auth/v1/user') {
      const t = String(req.headers.authorization || '').replace('Bearer ', '');
      const who = { 'tok-free': U.free, 'tok-ind': U.ind, 'tok-pilot': U.pilot, 'tok-locked': U.pilot }[t];
      return who ? send(200, { id: who }) : send(401, { msg: 'bad jwt' });
    }
    if (req.url === '/rest/v1/rpc/aim_allowance') {
      if (S.down) return send(500, { message: 'down' });
      if (req.headers.authorization !== 'Bearer svc') return send(401, {});
      return send(200, await take(j.p_user, j.p_key, j.p_take));
    }
    if (req.url === '/rest/v1/rpc/pilot_agent_context') {
      return send(200, req.headers.authorization === 'Bearer tok-locked' ? { locked: true } : {});
    }
    return send(201);
  });
  await new Promise((r) => server.listen(9993, r));
  Object.assign(process.env, { SUPABASE_URL: 'http://localhost:9993', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon',
    ANTHROPIC_API_KEY: 'dummy', ANTHROPIC_URL: 'http://localhost:9993/v1/messages' });
  let handler;
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === '@google-cloud/functions-framework' ? { http: (_n, h) => { handler = h; } } : load.call(this, req, ...rest); };
  require('../../backend/index.js');
  Module._load = load;

  let ipN = 0;
  const call = (body, ip) => new Promise((resolve) => {
    const out = { status: 200, headers: {} };
    const res = {
      set: (k, v) => { out.headers[k] = v; return res; },
      status: (s) => { out.status = s; return res; },
      json: (b) => { out.body = b; resolve(out); return res; },
      send: (b) => { out.body = b; resolve(out); return res; },
    };
    handler({ method: 'POST', headers: { origin: 'https://k12plus.app', 'x-forwarded-for': ip || `10.0.0.${++ipN}` }, body }, res);
  });
  const chat = (extra = {}, text = 'What is 2x + 5 = 17?', ip) => call({ action: 'chat', system: 'x', messages: [{ role: 'user', content: text }], ...extra }, ip);
  const lastModel = () => S.calls.at(-1) && S.calls.at(-1).model;

  console.log('\nThe agent: daily questions');
  for (let i = 0; i < 5; i++) await chat({ k12device: 'phone-aaaa1111' });
  let before = S.calls.length;
  r = await chat({ k12device: 'phone-aaaa1111' });
  ok(r.status === 402 && r.body.error === 'daily_limit' && /used today's 5 free questions/.test(r.body.reply) && /N\$15 a month/.test(r.body.reply) && S.calls.length === before,
    'a visitor\'s 6th question gets a warm note about tomorrow and the Individual plan, and Claude is not asked', r.body);
  ok(!/[–—]/.test(r.body.reply) && !/\b(can't|don't|won't|you're|it's)\b/.test(r.body.reply) && !/tutor|student/i.test(r.body.reply), 'the note uses no dashes or contractions, and says agent and learners');
  r = await chat({ k12device: 'phone-bbbb2222' });
  ok(r.status === 200, 'a different phone still has its questions');
  for (let i = 0; i < 5; i++) await chat({}, 'hi', '172.16.0.9');
  r = await chat({}, 'hi', '172.16.0.9');
  ok(r.status === 402, 'without a phone ID, a visitor is counted by network address');
  r = await chat({ k12device: 'bad id!' }, 'hi', '172.16.0.10');
  ok(r.status === 200, 'a malformed phone ID is ignored (counted by network address instead)');
  for (let i = 0; i < 5; i++) await chat({ k12token: 'tok-free', k12device: `phone-free-${i}0000` });
  r = await chat({ k12token: 'tok-free', k12device: 'phone-free-new0000' });
  ok(r.status === 402, 'a signed-in Free learner is counted on her account, so a new phone ID does not reset it');
  for (let i = 0; i < 20; i++) await chat({ k12token: 'tok-ind' });
  r = await chat({ k12token: 'tok-ind' });
  ok(r.status === 402 && /asked 20 questions today/.test(r.body.reply) && !/N\$15/.test(r.body.reply), 'an Individual learner gets 20, then a note without a sales pitch', r.body);
  r = await chat({ k12token: 'tok-bad', k12device: 'phone-cccc3333' });
  ok(r.status === 200, 'a sign-in that cannot be checked is treated as a visitor, never refused');
  r = await call({ action: 'chatimg', system: 'x', messages: [{ role: 'user', content: 'help' }], image: { mime: 'image/png', data: 'x' }, k12device: 'phone-aaaa1111' });
  ok(r.status === 402, 'a photo question counts as a question too');
  r = await chat({ k12token: 'tok-locked' });
  const pilotCount = (await db.query(`select coalesce(sum(questions),0)::int n from question_allowance where key = 'user:${U.pilot}'`)).rows[0].n;
  ok(r.status === 423 && pilotCount === 0, 'a pilot learner sitting a test gets the test note, and no question is used up', { status: r.status, pilotCount });
  r = await call({ action: 'lesson_plan', topic: 'Quadratics', k12device: 'phone-aaaa1111' });
  ok(r.status === 200 && r.body.plan, 'teacher tools such as lesson plans are not counted against questions', r.status);
  S.down = true;
  r = await chat({ k12device: 'phone-aaaa1111' });
  S.down = false;
  ok(r.status === 200, 'if the count cannot be made, the agent answers as normal (nobody is locked out by an error)');

  console.log('\nThe agent: which model answers');
  await db.query('delete from question_allowance');
  await chat({ k12device: 'phone-model001' }, 'Solve 2x + 5 = 17');
  ok(/haiku/.test(lastModel()), 'an everyday question goes to Haiku', lastModel());
  for (const t of ['I still don\'t understand', 'I dont get it', 'i\'m lost', 'I am confused', 'Can you explain it again?', 'what??']) {
    await chat({ k12device: 'phone-model002' }, t);
    ok(/sonnet/.test(lastModel()), `"${t}" goes to Sonnet`, lastModel());
  }
  await call({ action: 'chatimg', system: 'x', messages: [{ role: 'user', content: 'check my working' }], image: { mime: 'image/png', data: 'x' }, k12device: 'phone-model003' });
  ok(/sonnet/.test(lastModel()), 'a photo of her working goes to Sonnet', lastModel());
  await call({ action: 'lesson_plan', topic: 'Quadratics' });
  ok(/sonnet/.test(lastModel()), 'lesson plans go to Sonnet', lastModel());
  S.haikuFails = true;
  before = S.calls.length;
  r = await chat({ k12device: 'phone-model004' }, 'Solve 3x = 12');
  S.haikuFails = false;
  ok(r.status === 200 && r.body.reply === 'Answer from claude-sonnet-5-5' && S.calls.length === before + 2, 'if Haiku cannot answer, Sonnet does', r.body);
  await call({ action: 'tutor', messages: [{ role: 'user', content: 'Solve 4x = 8' }], k12device: 'phone-model005' });
  ok(/haiku/.test(lastModel()), 'the older AIM tutor route follows the same rule', lastModel());

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
