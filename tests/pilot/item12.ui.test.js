// Item 12 end to end: a simulated phone works through a lesson with the network off,
// then syncs, and the server holds exactly the right records with no duplicates.
// The real app.html runs in headless Chromium; Supabase is replaced by PGlite running
// the real migrations, with the same row level security. To make sync earn its keep,
// the first reply for learning records and for quiz results is lost on the way back
// (the server has stored them, the phone does not hear so and sends again), and two
// tabs reconnect at the same moment.
const { chromium } = require('playwright');
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');

const local = {
  'react@18.3.1/umd/react.production.min.js': 'node_modules/react/umd/react.production.min.js',
  'react-dom@18.3.1/umd/react-dom.production.min.js': 'node_modules/react-dom/umd/react-dom.production.min.js',
  '@babel/standalone@7.29.0/babel.min.js': 'node_modules/@babel/standalone/babel.min.js',
};
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql',
  '20261031_pilot_evaluator_export.sql', '20261101_pilot_offline_lessons.sql'];
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const TYPES = { p_events: 'jsonb', p_pack: 'text', p_version: 'int', p_checked: 'boolean', p_note: 'text', p_class: 'uuid', p_learner: 'uuid', p_school: 'uuid', p: 'jsonb' };
const ROOT = path.join(__dirname, '../..');

(async () => {
  // ---------- database ----------
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  for (const f of MIGS) await db.exec(fs.readFileSync(path.join(ROOT, 'backend/migrations', f), 'utf8'));
  const U = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@test.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, school_id, country) values ($1,$2,$3,$4,$5,$6)', [U[key], o.name || key, role, o.grade || null, o.school || null, 'Namibia']);
  };
  const asUser = (uid, fn) => db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: 'authenticated' } : { role: 'anon' })]);
    await tx.query(uid ? 'set local role authenticated' : 'set local role anon');
    return fn(tx);
  });
  const svc = (q, p) => db.transaction(async (tx) => { await tx.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)"); return tx.query(q, p); });
  const sch = (await db.query("insert into schools (name, region, country, region_id) values ('Tsandi Secondary School', 'x', 'Namibia', 10) returning id")).rows[0].id;
  await mk('admin', 'learner', { name: 'Pilot Admin' }); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('t1', 'educator', { name: 'Ms Amutenya', school: sch });
  await mk('l1', 'learner', { name: 'Ndapewa Shikongo', grade: 11 });
  await mk('l2', 'learner', { name: 'Tomas Haufiku', grade: 11 });
  const setup = (await asUser(U.admin, (tx) => tx.query('select pilot_setup_region(10::smallint, $1::jsonb) v', [JSON.stringify([{ school_id: sch, setting: 'rural' }])]))).rows[0].v;
  const C11 = setup.schools[0].classes.find((c) => c.grade === 11);
  await asUser(U.admin, (tx) => tx.query('select pilot_assign_teacher($1::uuid, $2)', [C11.id, 't1@test.na']));
  await asUser(U.l1, (tx) => tx.query('select pilot_join_class($1)', [C11.code]));
  await svc('select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'school', school_id: sch, given_by_name: 'P', given_by_relation: 'principal', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20' })]);
  await svc('select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'guardian', learner_id: U.l1, given_by_name: 'M', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20' })]);
  // l2 is not in the pilot (no class, no consent)

  const tokenFor = (key) => 'h.' + Buffer.from(JSON.stringify({ exp: 9999999999, sub: U[key] })).toString('base64').replace(/=/g, '') + '.s';
  const uidFromAuth = (h) => { try { return JSON.parse(Buffer.from((h || '').split('.')[1], 'base64').toString()).sub || null; } catch (e) { return null; } };

  // ---------- network stand-ins ----------
  const net = { aim: 0, aimTexts: [], loseReply: { events: 1, quiz: 1 }, eventsCalls: 0, quizCalls: 0 };
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const contexts = {};
  // the stand-ins sit on the browser context, so every tab of the phone uses them
  const routes = async (ctx) => {
    await ctx.route('https://unpkg.com/**', (r) => {
      const k = Object.keys(local).find((x) => r.request().url().includes(x));
      return k ? r.fulfill({ path: path.join(process.env.VENDOR_DIR || __dirname, local[k]), contentType: 'application/javascript' }) : r.abort();
    });
    await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
    await ctx.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await ctx.route('https://uwqbjjzjdnjlbicxrwnp.supabase.co/**', async (r) => {
      const req = r.request(); const url = new URL(req.url());
      const uid = uidFromAuth(req.headers()['authorization']);
      if (url.pathname === '/functions/v1/aim') {
        const b = JSON.parse(req.postData() || '{}');
        net.aim++; net.aimTexts.push(((b.messages || []).slice(-1)[0] || {}).content);
        return r.fulfill({ json: { reply: 'Subtract 4 from both sides first. So 2x = 10 and x = 5.' } });
      }
      if (url.pathname === '/rest/v1/quiz_attempts' && req.method() === 'POST') {
        net.quizCalls++;
        const rows = JSON.parse(req.postData() || '[]');
        try {
          await asUser(uid, (tx) => tx.query(`insert into quiz_attempts (user_id, subject, score, total, client_ref, created_at)
            select user_id, subject, score, total, client_ref, created_at from jsonb_populate_recordset(null::quiz_attempts, $1::jsonb)
            on conflict (user_id, client_ref) do nothing`, [JSON.stringify(rows)]));
        } catch (e) { return r.fulfill({ status: 400, json: { message: e.message } }); }
        if (net.loseReply.quiz > 0) { net.loseReply.quiz--; return r.abort('connectionreset'); } // stored, but the phone never hears back
        return r.fulfill({ status: 201, body: '' });
      }
      const m = url.pathname.match(/^\/rest\/v1\/rpc\/(pilot_[a-z_]+)$/);
      if (m) {
        const args = JSON.parse(req.postData() || '{}');
        const keys = Object.keys(args);
        const sql = `select ${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}::${TYPES[k] || 'text'}`).join(', ')}) as v`;
        try {
          const rows = await asUser(uid, (tx) => tx.query(sql, keys.map((k) => (args[k] === null ? null : typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))));
          if (m[1] === 'pilot_record_events') { net.eventsCalls++; if (net.loseReply.events > 0) { net.loseReply.events--; return r.abort('connectionreset'); } }
          return r.fulfill({ json: rows.rows[0].v });
        } catch (e) { return r.fulfill({ status: 400, json: { message: e.message } }); }
      }
      return r.fulfill({ json: [] });
    });
  };
  const newPage = async (who, role, opts = {}) => {
    const ck = who + (opts.width ? '@' + opts.width : '');
    const fresh = !contexts[ck];
    const ctx = contexts[ck] || (contexts[ck] = await browser.newContext({ viewport: { width: opts.width || 1280, height: opts.width ? 800 : 900 }, isMobile: !!opts.width, hasTouch: !!opts.width, serviceWorkers: 'block' }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(who + ': ' + e.message));
    if (fresh) await routes(ctx);
    await page.goto('http://127.0.0.1:8765/app.html');
    if (who !== 'guest') {
      await page.evaluate(([tok, uid, role, name, grade]) => {
        localStorage.setItem('k12plus-session', JSON.stringify({ access_token: tok, refresh_token: 'r', user_id: uid }));
        localStorage.setItem('k12plus-loggedin', '1'); localStorage.setItem('k12plus-role', role);
        localStorage.setItem('k12plus-name', name); localStorage.setItem('k12plus-tour-done', '1');
        if (grade) localStorage.setItem('k12plus-grade', String(grade));
      }, [tokenFor(who), U[who], role, who, opts.grade || '']);
    } else {
      await page.evaluate(() => localStorage.setItem('k12plus-tour-done', '1'));
    }
    await page.reload(); await page.waitForTimeout(2500);
    return page;
  };
  const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const shot = (page, n) => page.screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, n), fullPage: false });
  const openLessons = async (page) => { await page.click('button:has-text("Offline lessons")'); await page.waitForTimeout(1200); };
  // the card of one lesson: the nearest block around its title that holds the Open button and its action buttons
  const packCard = (page, title) => page.getByText(title, { exact: true }).last()
    .locator("xpath=ancestor::div[.//button[normalize-space()='Open'] and .//button[contains(., 'Mark as checked') or contains(., 'Take the check back') or contains(., 'Download for offline') or contains(., 'Update (') or contains(., 'Remove')]][1]");
  const pack = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'lessons', id + '.json'), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'lessons/index.json'), 'utf8'));
  const events = async (key) => (await db.query("select kind, topic, correct, attempted, offline from learning_events where learner_id = $1 order by occurred_at, id", [U[key]])).rows;

  console.log('\nBefore any teacher has checked them, learners do not see the lessons');
  let lp = await newPage('l1', 'Learner', { grade: 11 });
  await openLessons(lp);
  let t = await text(lp);
  ok(/Offline lessons/.test(t) && /Your teacher is still checking these lessons/.test(t) && !/Solving equations/.test(t), 'a learner sees a friendly note instead of draft lessons', t.slice(0, 300));

  console.log('\nA pilot teacher and an administrator check lessons');
  const tp = await newPage('t1', 'Educator');
  await openLessons(tp);
  t = await text(tp);
  ok(index.packs.every((e) => t.includes(e.title)) && (t.match(/Draft: not checked yet/g) || []).length === index.packs.length, 'the teacher sees all ' + index.packs.length + ' lessons, each marked as a draft');
  await packCard(tp, 'Solving equations').locator('button:has-text("Mark as checked")').click(); await tp.waitForTimeout(800);
  t = await text(tp);
  ok(/Checked by Ms Amutenya on/.test(t) && /Learners can now see it/.test(t), 'she marks "Solving equations" as checked, with her name and the date');
  await shot(tp, 'item12-teacher.png');
  const ap = await newPage('admin', 'Learner');
  await openLessons(ap);
  await packCard(ap, 'Percentages and money').locator('button:has-text("Mark as checked")').click(); await ap.waitForTimeout(800);
  ok((await db.query('select count(*)::int n from lesson_checks')).rows[0].n === 2, 'an administrator checks "Percentages and money"');
  await ap.close(); await tp.close();

  console.log('\nThe learner saves a lesson on her phone');
  await lp.click('button:has-text("All lessons")').catch(() => {});
  await lp.reload(); await lp.waitForTimeout(2000); await openLessons(lp);
  t = await text(lp);
  ok(/Solving equations/.test(t) && /Percentages and money/.test(t) && !/Expanding and factorising/.test(t) && !/Differentiation/.test(t), 'she now sees the two checked Grade 11 lessons, and no drafts', t.slice(0, 400));
  ok(!/Draft/.test(t) && !/Ms Amutenya/.test(t), 'learners are not shown who checked a lesson');
  ok(/Next for you Solving equations Next topic to start/.test(t), 'a first study recommendation is shown');
  const dl = packCard(lp, 'Solving equations').locator('button:has-text("Download for offline")');
  const dlLabel = await dl.innerText();
  ok(/Download for offline \(about \d KB\)/.test(dlLabel), 'the download button shows the size: "' + dlLabel + '"');
  await dl.click(); await lp.waitForTimeout(800);
  t = await text(lp);
  ok(/Saved on this phone/.test(t) && /It now works with no signal/.test(t), 'the lesson is saved on the phone');
  await shot(lp, 'item12-list.png');

  console.log('\nWith the network off, she works through the whole lesson');
  await contexts.l1.setOffline(true); await lp.waitForTimeout(400);
  t = await text(lp);
  ok(/No signal\. Saved lessons still work/.test(t), 'the screen says there is no signal and that saved lessons still work');
  await packCard(lp, 'Solving equations').locator('button:has-text("Open")').click(); await lp.waitForTimeout(600);
  t = await text(lp);
  ok(/Think of a balance scale/.test(t) && /Remember/.test(t), 'the explanation opens from the phone, with no signal');
  await lp.click('button:has-text("See the worked examples")'); await lp.waitForTimeout(300);
  t = await text(lp);
  ok(/Worked example 1/.test(t) && /Worked example 2/.test(t) && /Answer: x = 9/.test(t), 'both worked examples show');
  await lp.click('button:has-text("Practise now")'); await lp.waitForTimeout(300);
  const P = pack('g11-equations');
  const wrongFirst = new Set([2, 5]); // she gets questions 2 and 5 wrong at first
  let hintSeen = false, solutionSeen = false;
  for (let i = 0; i < P.practice.length; i++) {
    const it = P.practice[i];
    t = await text(lp);
    if (!t.includes('Question ' + (i + 1) + ' of ' + P.practice.length)) { ok(false, 'question ' + (i + 1) + ' comes next', t.slice(0, 300)); break; }
    if (it.type === 'choice') {
      if (wrongFirst.has(i + 1)) { await lp.locator('button', { hasText: it.options[it.answer === 'A' ? 1 : 0] }).first().click(); await lp.waitForTimeout(150); }
      await lp.locator('button', { hasText: it.options['ABCD'.indexOf(it.answer)] }).first().click();
    } else {
      const inp = lp.locator('#dc-root input[placeholder="Type your answer"]');
      if (wrongFirst.has(i + 1)) {
        await inp.fill(String(Number(it.answer) + 1)); await lp.click('button:has-text("Check my answer")'); await lp.waitForTimeout(150);
        if (!hintSeen) { await lp.click('button:has-text("Show a hint")'); await lp.waitForTimeout(100); hintSeen = /Hint: /.test(await text(lp)); }
      }
      // decimal commas and spaces are fine: type answers the way learners do
      await inp.fill(i === 2 ? '−5' : String(it.answer)); await lp.click('button:has-text("Check my answer")');
    }
    await lp.waitForTimeout(150);
    t = await text(lp);
    if (!/Correct/.test(t)) { ok(false, 'question ' + (i + 1) + ' is marked correct on the phone', t.slice(0, 400)); break; }
    if (!solutionSeen) solutionSeen = /How to do it:/.test(t);
    if (i === 0) await shot(lp, 'item12-practice.png');
    await lp.click('button:has-text("Next question")'); await lp.waitForTimeout(150);
  }
  t = await text(lp);
  ok(/Lesson complete/.test(t) && /You got 10 of 12 right first time, and 12 right in the end/.test(t), 'all 12 questions are marked on the phone: 10 right first time, 12 in the end', t.slice(0, 300));
  ok(hintSeen && solutionSeen, 'hints and worked solutions show without a signal');
  ok(/Next for you: Percentages and money/.test(t), 'the study recommendation moves on to the next topic');
  await shot(lp, 'item12-done.png');
  // a quiz finished and a question for the agent, both without a signal
  await lp.evaluate(() => window.k12data.recordQuiz('Mathematics', 4, 5));
  const offlineReply = await lp.evaluate(() => window.claude.complete({ messages: [{ role: 'user', content: 'How do I solve 2x + 4 = 14?' }], feedback: { kind: 'chat', subject: 'Mathematics' } }));
  ok(/Your question has been saved/.test(offlineReply), 'a question for the agent is saved for later');
  await lp.click('button:has-text("All lessons")'); await lp.waitForTimeout(400);
  t = await text(lp);
  const waiting = await lp.evaluate(() => window.k12learn.pending() + window.k12data.pendingQuiz() + window.k12pendingQuestions());
  ok(waiting === 15 && /\(15 waiting to be sent\)/.test(t), 'the phone holds 15 items to send: 1 lesson, 12 answers, 1 quiz, 1 question', [waiting, t.slice(0, 300)]);
  ok((await events('l1')).filter((e) => e.kind === 'lesson' || e.kind === 'practice').length === 0 && net.aim === 0 && net.quizCalls === 0, 'nothing has reached the server while offline');

  console.log('\nBack online: two tabs reconnect at once, and the first replies are lost');
  const lp2 = await contexts.l1.newPage(); // a second tab of the app on the same phone
  lp2.on('pageerror', (e) => errors.push('l1 tab 2: ' + e.message));
  await contexts.l1.setOffline(false);
  await lp2.goto('http://127.0.0.1:8765/app.html').catch(() => {});
  await lp.waitForTimeout(7000);
  let ev = await events('l1');
  ok(net.eventsCalls >= 1 && net.quizCalls >= 1, 'both kinds of record were sent, and the first replies were lost on the way back', net);
  // she opens the app again later: everything still waiting is sent once more
  await lp.reload(); await lp.waitForTimeout(7000);
  await lp.evaluate(async () => { await Promise.all([window.k12learn.flush(), window.k12learn.flush(), window.k12data.flushQuiz(), window.k12data.flushQuiz(), window.k12flushQuestions(), window.k12flushQuestions()]); });
  await lp.waitForTimeout(1500);
  ev = (await events('l1')).filter((e) => e.kind !== 'data' && e.kind !== 'active'); // usage records from item 8 are counted elsewhere
  const kinds = ev.reduce((a, e) => ((a[e.kind] = (a[e.kind] || 0) + 1), a), {});
  ok(kinds.lesson === 1 && kinds.practice === 12 && Object.keys(kinds).length === 2, 'the server holds exactly 1 lesson record and 12 practice records', kinds);
  ok(ev.filter((e) => e.kind === 'practice').reduce((n, e) => n + e.correct, 0) === 10 && ev.every((e) => e.offline && e.topic === P.topic), 'they show 10 right first time, on the right topic, marked as done offline');
  const quiz = (await db.query('select score, total, client_ref from quiz_attempts where user_id = $1', [U.l1])).rows;
  ok(quiz.length === 1 && quiz[0].score === 4 && quiz[0].total === 5, 'the offline quiz is stored exactly once, although it was sent ' + net.quizCalls + ' times', quiz);
  ok(net.aim === 1 && net.aimTexts[0] === 'How do I solve 2x + 4 = 14?', 'the saved question reached the agent exactly once, although two tabs reconnected', net.aimTexts);
  const left = await lp.evaluate(() => window.k12learn.pending() + window.k12data.pendingQuiz() + window.k12pendingQuestions());
  ok(left === 0, 'nothing is left waiting on the phone');
  await lp.click('button:has-text("Home")').catch(() => {});
  await lp.evaluate(() => { const c = JSON.parse(localStorage.getItem('k12plus-tutor-chat') || '[]'); return c.length; });
  const chat = await lp.evaluate(() => localStorage.getItem('k12plus-tutor-chat') || '');
  ok(/Answer to your offline question\) Subtract 4 from both sides/.test(chat), 'the answer to the saved question is in her chat');
  await openLessons(lp);
  t = await text(lp);
  ok(/Online\. Everything is up to date\./.test(t), 'the screen confirms everything is up to date');
  await lp2.close();

  console.log('\nA learner outside the pilot');
  const op = await newPage('l2', 'Learner', { grade: 11 });
  await openLessons(op);
  await packCard(op, 'Percentages and money').locator('button:has-text("Download for offline")').click(); await op.waitForTimeout(600);
  await contexts.l2.setOffline(true);
  await packCard(op, 'Percentages and money').locator('button:has-text("Open")').click(); await op.waitForTimeout(400);
  await op.click('button:has-text("Practise")');
  await op.locator('#dc-root input[placeholder="Type your answer"]').fill('90'); await op.click('button:has-text("Check my answer")'); await op.waitForTimeout(150);
  t = await text(op);
  ok(/Correct, well done!/.test(t), 'can practise offline too: answers are marked on the phone');
  await contexts.l2.setOffline(false); await op.waitForTimeout(3000);
  ok((await events('l2')).length === 0 && await op.evaluate(() => window.k12learn.pending()) === 0, 'nothing about a learner outside the pilot is recorded or sent');

  console.log('\nOn a phone screen, and before logging in');
  const mp = await newPage('l1', 'Learner', { grade: 11, width: 390 });
  await mp.click('button.k12burger'); await mp.waitForTimeout(300);
  await mp.click('aside button:has-text("Offline lessons")');
  await mp.waitForTimeout(1200);
  t = await text(mp);
  const wide = await mp.evaluate(() => document.documentElement.scrollWidth);
  ok(/Offline lessons/.test(t) && /Solving equations/.test(t) && /Download for offline/.test(t) && wide <= 391, 'on a 390-pixel phone screen the list fits with no sideways scrolling (page width ' + wide + ')', t.slice(0, 200));
  await shot(mp, 'item12-phone.png');
  await packCard(mp, 'Solving equations').locator('button:has-text("Open")').click(); await mp.waitForTimeout(500);
  await mp.click('button:has-text("Practise")'); await mp.waitForTimeout(300);
  ok(/Question 1 of 12/.test(await text(mp)) && await mp.evaluate(() => document.documentElement.scrollWidth) <= 391, 'a practice question fits the phone screen too');
  await shot(mp, 'item12-phone.png');
  const gp = await newPage('guest', 'Learner');
  await gp.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Offline lessons/.test(x.innerText)); if (b) b.click(); });
  await gp.waitForTimeout(1200);
  t = await text(gp);
  ok(/Solving equations/.test(t) && /Percentages and money/.test(t) && !/Draft/.test(t), 'before logging in, the checked lessons are available too');

  console.log('\nNothing else broke');
  ok(errors.length === 0, 'no page errors', errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
