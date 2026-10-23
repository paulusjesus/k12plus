// Item 11 end to end: the real `ussd` Edge Function (Deno) answering a USSD gateway.
// The function talks to a stand-in for Supabase that runs the real migrations in
// PGlite (with the same roles and security), reads the lesson packs from the
// repository, and gets agent replies from a stand-in for the Claude API. Requests are
// sent exactly as Africa's Talking sends them (form fields, text joined with *).
// Usage: node item11.test.js   (needs deno on the PATH)
const { PGlite } = require('@electric-sql/pglite');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const MIGS = fs.readdirSync(path.join(ROOT, 'backend/migrations')).filter((f) => f >= '20261023').sort();
const STAND_IN = 9993, FN = 9992, SERVICE = 'service-key-for-tests', SECRET = 'gateway-secret-for-tests';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };
// the basic GSM set, plus ^ and ~ from its extension table (used for x^2), which basic phones show
const GSM = /^[A-Za-z0-9 \n@$_!"#%&'()*+,\-./:;<=>?^~£¥èéùìòÇØøÅåÆæßÉÄÖÑÜ§äöñüà]*$/;

(async () => {
  // ---------- database ----------
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  for (const f of MIGS) await db.exec(fs.readFileSync(path.join(ROOT, 'backend/migrations', f), 'utf8'));
  const U = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@test.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, phone, country) values ($1,$2,$3,$4,$5,$6)', [U[key], o.name || key, role, o.grade || null, o.phone || null, 'Namibia']);
  };
  const as = (uid, sql, params = []) => db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: 'authenticated' } : { role: 'service_role' })]);
    await tx.query(uid ? 'set local role authenticated' : 'set local role service_role');
    return (await tx.query(sql, params)).rows;
  });
  const sch = (await db.query("insert into schools (name, region, country, region_id) values ('Tsandi Secondary School', 'x', 'Namibia', 10) returning id")).rows[0].id;
  await mk('admin', 'learner', { name: 'Pilot Admin' }); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('t1', 'educator', { name: 'Ms Amutenya' });
  await mk('nde', 'learner', { name: 'Ndapewa Shikongo', grade: 11, phone: '081 234 5678' });   // pilot learner, own phone
  await mk('sel', 'learner', { name: 'Selma Nangolo', grade: 11, phone: '0812223333' });        // shares a phone with Tomas
  await mk('tom', 'learner', { name: 'Tomas Nangolo', grade: 12, phone: '+264 81 222 3333' });
  await mk('joh', 'learner', { name: 'Johannes Amupolo', grade: 11, phone: '0814445555' });     // registered, not in a class
  const setup = (await as(U.admin, 'select pilot_setup_region(10::smallint, $1::jsonb) v', [JSON.stringify([{ school_id: sch, setting: 'rural' }])]))[0].v;
  const C11 = setup.schools[0].classes.find((c) => c.grade === 11);
  const C12 = setup.schools[0].classes.find((c) => c.grade === 12);
  await as(U.admin, 'select pilot_assign_teacher($1::uuid, $2)', [C11.id, 't1@test.na']);
  for (const [k, c] of [['nde', C11], ['sel', C11], ['tom', C12]]) await as(U[k], 'select pilot_join_class($1)', [c.code]);
  const consent = (b) => as(null, 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20', ...b })]);
  await consent({ kind: 'school', school_id: sch, given_by_relation: 'principal' });
  await consent({ kind: 'guardian', learner_id: U.nde });
  await consent({ kind: 'guardian', learner_id: U.tom }); // Selma has no guardian consent yet
  // the teacher has checked the Grade 11 equations pack (the others stay drafts)
  await as(U.t1, "select pilot_check_lesson('g11-equations', 1, true)");
  // an old session from 40 days ago, which must be cleaned up
  await db.query("insert into ussd_sessions (session_id, phone_hash, started_at) values ('old-session', 'aaaaaaaaaaaaaaaaaaaa', now() - interval '40 days')");

  const tokenFor = (key) => 'h.' + Buffer.from(JSON.stringify({ exp: 9999999999, sub: U[key] })).toString('base64').replace(/=/g, '') + '.s';
  const uidFromAuth = (h) => { try { return JSON.parse(Buffer.from((h || '').split('.')[1], 'base64').toString()).sub || null; } catch (e) { return null; } };

  // ---------- stand-in for Supabase, the website and the Claude API ----------
  const ai = { calls: 0, last: null };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, 'http://x');
    const json = (status, v) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(v === undefined ? '' : JSON.stringify(v)); };
    try {
      if (url.pathname.startsWith('/lessons/')) {
        const f = path.join(ROOT, url.pathname);
        if (!fs.existsSync(f)) return json(404, {});
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(fs.readFileSync(f));
      }
      if (url.pathname === '/v1/messages') {
        ai.calls++; ai.last = JSON.parse(body);
        return json(200, { content: [{ type: 'text', text: 'Start by taking 4 from both sides: 2x = 10. Then divide by 2, so x = 5. Check: 2 × 5 + 4 = 14 ✔. For x² − 1 = 0, use the difference of two squares. You are doing well, Ndapewa! Keep going, one step at a time, and remember: every equation is a balance, so whatever you do to one side you must also do to the other side.' }], usage: { input_tokens: 120, output_tokens: 90 } });
      }
      if (url.pathname === '/rest/v1/agent_logs') return json(201);
      const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
      if (m) {
        const auth = req.headers['authorization'] || '';
        const service = auth === 'Bearer ' + SERVICE;
        const uid = service ? null : uidFromAuth(auth);
        if (!service && !uid) return json(401, { message: 'no' });
        const args = body ? JSON.parse(body) : {};
        const keys = Object.keys(args);
        const T = { p_session: 'text', p_phone_hash: 'text', p_simulated: 'boolean', p_state: 'jsonb', p_steps: 'int', p_learner: 'uuid', p_ai: 'int', p_phone: 'text', p_code: 'text', p_events: 'jsonb', p: 'jsonb' };
        const sql = `select ${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}::${T[k] || 'text'}`).join(', ')}) as v`;
        try {
          const rows = await as(uid, sql, keys.map((k) => (args[k] === null ? null : typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
          return json(200, rows[0].v);
        } catch (e) { return json(400, { message: e.message }); }
      }
      json(404, {});
    } catch (e) { json(500, { message: e.message }); }
  });
  await new Promise((r) => server.listen(STAND_IN, '127.0.0.1', r));
  const fn = spawn('deno', ['run', '-A', path.join(ROOT, 'supabase/functions/ussd/index.ts')], {
    env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${STAND_IN}`, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: 'anon', ANTHROPIC_API_KEY: 'test',
           ANTHROPIC_URL: `http://127.0.0.1:${STAND_IN}/v1/messages`, SITE_URL: `http://127.0.0.1:${STAND_IN}`, USSD_SECRET: SECRET, USSD_TEST_PORT: String(FN) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let fnErr = ''; fn.stderr.on('data', (d) => { fnErr += d; });
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${FN}/`, { method: 'OPTIONS' }); break; } catch (e) { await new Promise((r) => setTimeout(r, 500)); } }

  // ---------- a phone talking to the gateway ----------
  const screens = [];
  const post = async (fields, opts = {}) => {
    const r = await fetch(`http://127.0.0.1:${FN}/${opts.noKey ? '' : '?key=' + (opts.key || SECRET)}`, {
      method: 'POST', headers: { 'Content-Type': opts.json ? 'application/json' : 'application/x-www-form-urlencoded', ...(opts.headers || {}) },
      body: opts.json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
    });
    const text = await r.text();
    screens.push(text);
    return { status: r.status, text, con: text.startsWith('CON '), end: text.startsWith('END '), screen: text.slice(4) };
  };
  let sn = 0;
  // a session: dial, then each key press resends everything typed so far, joined with *
  const phone = (number, code = '*141*12#') => {
    const sessionId = 'ATUid_' + (++sn) + '_' + Date.now();
    const typed = [];
    return {
      dial: (firstText = '') => { if (firstText) typed.push(firstText); return post({ sessionId, serviceCode: code, phoneNumber: number, text: typed.join('*'), networkCode: '64910' }); },
      press: (key) => { typed.push(key); return post({ sessionId, serviceCode: code, phoneNumber: number, text: typed.join('*'), networkCode: '64910' }); },
      again: () => post({ sessionId, serviceCode: code, phoneNumber: number, text: typed.join('*'), networkCode: '64910' }),
    };
  };
  const evs = async (k) => (await db.query('select kind, topic, correct from learning_events where learner_id = $1 order by id', [U[k]])).rows;

  console.log('\nOnly the gateway gets in');
  let r = await post({ sessionId: 'x1', serviceCode: '*141*12#', phoneNumber: '+264812345678', text: '' }, { noKey: true });
  ok(r.status === 401 && r.end, 'without the shared secret the function refuses', r);
  r = await post({ sessionId: 'x2', serviceCode: '*141*12#', phoneNumber: '+264812345678', text: '' }, { key: 'wrong' });
  ok(r.status === 401, 'with a wrong secret too');
  r = await post({ sessionId: 'x3', serviceCode: '*141*12#', phoneNumber: '+264812345678', text: '', simulate: true }, { json: true, noKey: true, headers: { Authorization: 'Bearer ' + tokenFor('nde') } });
  ok(r.status === 403, 'the simulator is for administrators only', r);

  console.log('\nA pilot learner dials *141*12#');
  let p = phone('+264812345678');
  r = await p.dial();
  ok(r.con && /Hi Ndapewa! K12Plus/.test(r.screen) && /1 Mathematics\n2 Physical Science\n3 Biology\n4 Business Studies\n5 My results/.test(r.screen) && !/Join/.test(r.screen), 'she is greeted by her first name, with the four subjects (STEM first) and her results', r.screen);
  ok((await db.query("select count(*)::int n from ussd_sessions where session_id = 'old-session'")).rows[0].n === 0, 'sessions older than 30 days are deleted');
  r = await p.press('1');
  ok(/^AI Math Agent\n1 Practice question\n2 Short lesson\n3 Ask the agent\n0 Back$/.test(r.screen), 'Mathematics opens the AI Math Agent menu', r.screen);
  r = await p.press('1');
  ok(/^Q1\. /.test(r.screen) && (/Type the answer \(numbers only\)/.test(r.screen) || /\n1 /.test(r.screen)), 'a practice question from the checked Grade 11 pack', r.screen);
  // answer it correctly, whatever it is
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'lessons/g11-equations.json'), 'utf8'));
  const answerFor = (scr) => {
    const q = scr.slice(4).split('\n')[0];
    // the question as the phone shows it: − becomes - and ² becomes ^2
    const asShown = (t) => t.replace(/−/g, '-').replace(/²/g, '^2');
    const seen = q.replace(/\.\.\.$/, ''); // a long question may be cut short on the screen
    const it = pack.practice.find((x) => asShown(x.q).startsWith(seen));
    if (!it) return null;
    if (it.type === 'choice') return String('ABCD'.indexOf(it.answer) + 1);
    if (it.ussd) return String('ABCD'.indexOf(it.ussd.answer) + 1);
    return it.answer;
  };
  let a = answerFor(r.screen);
  ok(!!a, 'the question comes from the pack', r.screen);
  r = await p.press(a);
  ok(/^Correct! /.test(r.screen) && /1 Next question\n0 Back$/.test(r.screen), 'a right answer is marked correct, with how to do it', r.screen);
  r = await p.again(); // the gateway sends the same screen again (a network retry)
  ok(/^Correct! /.test(r.screen), 'a repeated request shows the same screen and changes nothing');
  r = await p.press('1');
  a = answerFor(r.screen);
  if (!a) console.log('  (no answer found for)', JSON.stringify(r.screen));
  const wrong = /\n1 /.test(r.screen) ? (a === '1' ? '2' : '1') : String(Number(a) + 3);
  r = await p.press(wrong);
  ok(/^Not quite\. The answer is /.test(r.screen), 'a wrong answer shows the right one', r.screen);
  r = await p.press('0'); r = await p.press('2');
  ok(/1 More\n0 Back$/.test(r.screen) && /Solving equations/.test(r.screen), 'a short lesson in pages that fit the screen', r.screen);
  r = await p.press('1');
  ok(/(1 More\n)?0 Back$/.test(r.screen), 'the next page of the lesson');
  let e = await evs('nde');
  ok(e.filter((x) => x.kind === 'ussd').length === 1 && e.filter((x) => x.kind === 'practice').length === 2 && e.filter((x) => x.kind === 'practice').reduce((n, x) => n + x.correct, 0) === 1
     && e.filter((x) => x.kind === 'lesson').length === 1 && e.every((x) => x.kind === 'ussd' || x.topic === pack.topic), 'her learning record holds 1 USSD session, 2 practice answers (1 right) and 1 lesson, once each', e);

  console.log('\nAsking the agent');
  p = phone('0812345678', '*141*12*1#'); // the Mathematics code, dialled directly
  r = await p.dial();
  ok(/^AI Math Agent\n1 Practice/.test(r.screen), '*141*12*1# goes straight to the AI Math Agent', r.screen);
  r = await p.press('3');
  ok(/^Type your question for the AI Math Agent:$/.test(r.screen) && r.con, 'it asks for her question', r.screen);
  r = await p.press('How do I solve 2x + 4 = 14');
  let answerPages = r.screen;
  ok(/Start by taking 4 from both sides: 2x = 10/.test(r.screen) && /2 x 5 \+ 4 = 14/.test(r.screen) && /1 More\n0 Back$/.test(r.screen), 'the answer arrives in pages, rewritten for basic phones (x, not ×)', r.screen);
  ok(/400 characters/.test(ai.last.system) && /basic phone/.test(ai.last.system) && /Grade 11/.test(ai.last.system) && ai.last.model === 'claude-haiku-5-5', 'the agent is told to answer briefly for a basic phone, at her grade, with the fast model first');
  r = await p.press('1');
  answerPages += '\n' + r.screen;
  ok(/x\^2 - 1 = 0/.test(answerPages) && !/[\u00b2\u2212\u00d7\u2714]/.test(answerPages) && /You are doing well/.test(r.screen), 'the next page; x\u00b2, \u2212, \u00d7 and \u2714 became x^2, -, x or were left out', answerPages);
  const ex = (await db.query("select kind, subject, topic, question from agent_exchanges where learner_id = $1", [U.nde])).rows;
  ok(ex.length === 1 && ex[0].topic === 'Asked by USSD' && ex[0].question === 'How do I solve 2x + 4 = 14', 'the question and answer are kept for the teachers\' monthly review (pilot learner with consent)', ex);
  e = await evs('nde');
  ok(e.filter((x) => x.kind === 'question').length === 1 && e.filter((x) => x.kind === 'ussd').length === 2, 'the question and the second session are in her learning record');

  console.log('\nSubjects without lessons yet, a shared phone, and results');
  p = phone('0812223333');
  r = await p.dial();
  ok(/^K12Plus\. Who is using this phone\?\n1 Selma\n2 Tomas$/.test(r.screen), 'a phone shared by two learners asks who is using it (first names only)', r.screen);
  r = await p.press('2');
  ok(/^Hi Tomas! K12Plus/.test(r.screen), 'Tomas chooses himself');
  r = await p.press('2'); r = await p.press('1');
  ok(/Practice and lessons for Physical Science are coming soon\.\n3 Ask the agent\n0 Back/.test(r.screen), 'Physical Science: practice is coming soon, the agent is there', r.screen);
  r = await p.press('0'); r = await p.press('0'); r = await p.press('5');
  ok(/No practice in the last 30 days yet/.test(r.screen), 'his results (pilot learner, nothing yet)', r.screen);
  ok((await evs('tom')).filter((x) => x.kind === 'ussd').length === 1 && (await evs('sel')).length === 0, 'the session is recorded for Tomas only, not for Selma');
  p = phone('0812223333');
  await p.dial(); r = await p.press('1'); r = await p.press('1'); r = await p.press('1');
  ok(/^Q1\. /.test(r.screen), 'Selma (no guardian consent yet) can practise');
  a = answerFor(r.screen); r = await p.press(a);
  r = await p.press('0'); r = await p.press('0'); r = await p.press('5');
  ok(/Results are kept when your class takes part in the K12Plus pilot\. This session: 1 of 1 right\./.test(r.screen), 'without consent nothing is stored: results come from this session only', r.screen);
  ok((await evs('sel')).length === 0, 'nothing at all is recorded for Selma');

  console.log('\nThe test lock, the daily limit and an unknown number');
  const t = (await db.query("insert into tests (code, grade, syllabus, form, purpose, title, status) values ('T-USSD', 12, '8227', 'A', 'baseline', 'Test', 'approved') returning id")).rows[0].id;
  await db.query("insert into test_windows (test_id, school_id, opens_at, closes_at) values ($1, $2, now() - interval '1 hour', now() + interval '1 hour')", [t, sch]);
  await db.query("insert into test_attempts (test_id, learner_id, mode) values ($1, $2, 'phone')", [t, U.tom]);
  p = phone('0812223333', '*141*12*1#');
  await p.dial(); await p.press('2'); r = await p.press('3');
  r = await p.press('What is a derivative');
  ok(/You are in the middle of a test, so the agent is taking a break/.test(r.screen), 'during a test the agent takes a break on USSD too', r.screen);
  const before = ai.calls;
  p = phone('0812345678');
  await p.dial(); await p.press('1'); await p.press('3');
  await db.query("update ussd_sessions set ai_questions = 10 where session_id like 'ATUid_2_%'");
  r = await p.press('One more question please');
  ok(/You have asked 10 questions today/.test(r.screen) && ai.calls === before, 'after 10 questions in a day, the phone is asked to practise instead (no more AI cost)', r.screen);
  p = phone('0819998888');
  r = await p.dial();
  ok(/^Welcome to K12Plus\n1 Mathematics/.test(r.screen) && /5 Register$/.test(r.screen), 'an unknown number gets the menu, with Register', r.screen);
  r = await p.press('1'); r = await p.press('3');
  ok(/your teacher must first register this phone number/.test(r.screen), 'it cannot ask the agent until registered', r.screen);
  p = phone('0819998888'); await p.dial(); r = await p.press('5');
  ok(r.end && /Ask your teacher to add you to K12Plus with this phone number/.test(r.screen), 'Register explains how, and ends the session', r.screen);

  console.log('\nJoining a class by class code');
  p = phone('0814445555');
  r = await p.dial();
  ok(/Hi Johannes!/.test(r.screen) && /6 Join my class$/.test(r.screen), 'a registered learner who is in no class can join one', r.screen);
  r = await p.press('6'); r = await p.press('ZZZZZZ');
  ok(/Not joined: That class code was not found/.test(r.screen), 'a wrong code is explained', r.screen);
  r = await p.press(C11.code);
  ok(/You have joined/.test(r.screen), 'the right code joins the class', r.screen);
  const en = (await db.query('select joined_via, status from enrolments where learner_id = $1', [U.joh])).rows;
  ok(en.length === 1 && en[0].joined_via === 'ussd' && en[0].status === 'active', 'the enrolment is recorded as joined by USSD', en);

  console.log('\nThe administrator\'s simulator');
  const recBefore = (await db.query('select count(*)::int n from learning_events')).rows[0].n;
  const exBefore = (await db.query('select count(*)::int n from agent_exchanges')).rows[0].n;
  const sim = (text) => post({ simulate: true, sessionId: 'sim-1', serviceCode: '*141*12#', phoneNumber: '0814445555', text }, { json: true, noKey: true, headers: { Authorization: 'Bearer ' + tokenFor('admin') } });
  r = await sim('');
  ok(/Hi Johannes!/.test(r.screen), 'the administrator sees exactly what Johannes would see on his phone');
  await sim('1'); await sim('1*3'); r = await sim('1*3*Test question');
  ok(/Start by taking 4/.test(r.screen), 'and can try every menu, including the agent');
  ok((await db.query('select count(*)::int n from learning_events')).rows[0].n === recBefore && (await db.query('select count(*)::int n from agent_exchanges')).rows[0].n === exBefore,
     'nothing is recorded for the learner from the simulator');
  const st = (await as(U.admin, 'select pilot_ussd_stats() v'))[0].v;
  ok(st.simulated === 1 && st.sessions >= 8 && st.ai_questions >= 1, 'the administrator sees usage figures without numbers or names', st);
  const stErr = await as(U.nde, 'select pilot_ussd_stats() v').catch((x) => x.message);
  ok(/Only K-12 EdTech administrators/.test(String(stErr)), 'learners cannot see them');

  console.log('\nEvery screen, and what is stored');
  const bad = screens.filter((x) => x.length - 4 > 182 || !GSM.test(x.slice(4)));
  ok(bad.length === 0 && screens.length > 40, 'all ' + screens.length + ' screens fit in 182 characters and use only characters every basic phone can show', bad);
  const dump = JSON.stringify((await db.query('select * from ussd_sessions')).rows);
  ok(!/812345678|812223333|814445555|819998888/.test(dump), 'no phone number is stored in the session table (only a keyed fingerprint)');
  const direct = await as(U.nde, 'select count(*)::int n from ussd_sessions').then((x) => x[0].n).catch(() => 'refused');
  ok(direct === 0 || direct === 'refused', 'the app cannot read the session table');
  const who = await as(U.nde, "select pilot_ussd_who('0812223333') v").then(() => 'allowed').catch(() => 'refused');
  ok(who === 'refused', 'nobody but the USSD function can look up learners by phone number');

  ok(!/error|uncaught/i.test(fnErr.replace(/claude test 401/g, '')), 'the function logged no errors', fnErr.slice(0, 400));
  fn.kill(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
