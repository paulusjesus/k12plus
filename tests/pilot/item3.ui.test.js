// Item 3 end to end: the real app.html in headless Chromium, with Supabase replaced by
// the local PGlite database running the real migrations. Covers: approving and opening
// a test, a learner sitting it on a phone (including with no signal), the agent lock,
// a teacher entering paper answers and printing the paper version, and the score list.
const { chromium } = require('playwright');
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');

const local = {
  'react@18.3.1/umd/react.production.min.js': 'node_modules/react/umd/react.production.min.js',
  'react-dom@18.3.1/umd/react-dom.production.min.js': 'node_modules/react-dom/umd/react-dom.production.min.js',
  '@babel/standalone@7.29.0/babel.min.js': 'node_modules/@babel/standalone/babel.min.js',
};
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const TYPES = { p_events: 'jsonb', p_reason: 'text', p_days: 'int', p_size: 'int', p_status: 'text', p_random: 'boolean', p: 'jsonb', p_region: 'smallint', p_schools: 'jsonb',
  p_class: 'uuid', p_teacher: 'uuid', p_learner: 'uuid', p_school: 'uuid', p_removal: 'bigint', p_test: 'uuid', p_attempt: 'bigint', p_answers: 'jsonb', p_opens: 'timestamptz', p_closes: 'timestamptz' };
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql', '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql'];

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@test.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, learner_uid, phone) values ($1,$2,$3,$4,$5,$6,$7)',
      [U[key], o.name || key, role, o.grade || null, 'Namibia', o.uid || null, o.phone || null]);
  };
  S.A = (await db.query("insert into schools (name, region, country) values ('Tsandi Secondary School', 'Omusati (Tsandi)', 'Namibia') returning id")).rows[0].id;
  for (const f of MIGS) await db.exec(fs.readFileSync(path.join(__dirname, '../../backend/migrations', f), 'utf8'));
  await mk('admin', 'learner', { name: 'Pilot Admin' }); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('t1', 'educator', { name: 'Ms Amutenya' });
  const names = { l1: 'Ndapewa Shikongo', l2: 'Petrus Haufiku', l3: 'Selma Nangolo', l4: 'Tomas Iipinge' };
  for (const k of Object.keys(names)) await mk(k, 'learner', { name: names[k], grade: 11, uid: 'K12-NA-' + k.toUpperCase() + 'AAAA', phone: '08100000' + k.slice(1) + '1' });

  const asUser = (uid, fn) => db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await tx.query('set local role authenticated');
    return fn(tx);
  });
  const sql = (who, q, p) => asUser(U[who], (tx) => tx.query(q, p));
  const svc = (q, p) => db.transaction(async (tx) => { await tx.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)"); return tx.query(q, p); });
  const setup = (await sql('admin', 'select pilot_setup_region(10::smallint, $1::jsonb) v', [JSON.stringify([{ school_id: S.A, setting: 'rural' }])])).rows[0].v;
  const C11 = setup.schools[0].classes.find((c) => c.grade === 11);
  await sql('admin', 'select pilot_assign_teacher($1::uuid, $2)', [C11.id, 't1@test.na']);
  for (const k of Object.keys(names)) await sql(k, 'select pilot_join_class($1)', [C11.code]);
  const consent = (b) => svc('select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20', ...b })]);
  await consent({ kind: 'school', school_id: S.A, given_by_relation: 'principal' });
  for (const k of ['l1', 'l3', 'l4']) await consent({ kind: 'guardian', learner_id: U[k] }); // l2 has no consent
  // stand-in test, a draft like the real bank
  const T = (await db.query(`insert into tests (code, grade, syllabus, form, purpose, title, minutes) values ('T-G11-A', 11, '6131', 'A', 'baseline', 'Grade 11 mathematics: start of the year test', 75) returning id`)).rows[0].id;
  const items = [
    ['Numbers and operations', 'Which number is irrational?', 'choice', '["√16","√2","3/7","0.25"]', 'B'],
    ['Numbers and operations', 'A cell phone costs N$ 1 200. It is sold at a discount of 15%. What is the sale price, in N$?', 'short', null, '1020'],
    ['Algebra', 'Solve 3(x − 2) = 2x + 5. What is x?', 'short', null, '11'],
    ['Geometry', 'The locus of points 3 cm from a point P is', 'choice', '["a line through P","a circle with centre P and radius 3 cm","a square","two lines"]', 'B'],
    ['Statistics and probability', 'Find the median of 4, 8, 6, 9, 4, 7, 10.', 'short', null, '7'],
    ['Statistics and probability', 'Two red beads from 3 red and 5 blue, without replacement?', 'short', null, '3/28'],
  ];
  for (let i = 0; i < items.length; i++) {
    const [topic, q, kind, opts, ans] = items[i];
    await db.query('insert into test_items (test_id, position, topic, question, kind, options, answer) values ($1,$2,$3,$4,$5,$6::jsonb,$7)', [T, i + 1, topic, q, kind, opts, ans]);
  }
  const tokenFor = (key) => 'h.' + Buffer.from(JSON.stringify({ exp: 9999999999, sub: U[key] })).toString('base64').replace(/=/g, '') + '.s';
  const uidFromAuth = (h) => { try { return JSON.parse(Buffer.from((h || '').split('.')[1], 'base64').toString()).sub; } catch (e) { return null; } };
  const uidFromToken = (t) => uidFromAuth('Bearer ' + t);
  const aimCalls = [];

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const newPage = async (who, role, width = 1280) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(who + ': ' + e.message));
    ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(who + ' popup: ' + e.message)));
    await page.route('https://unpkg.com/**', (r) => {
      const k = Object.keys(local).find((x) => r.request().url().includes(x));
      return k ? r.fulfill({ path: path.join(process.env.VENDOR_DIR || __dirname, local[k]), contentType: 'application/javascript' }) : r.abort();
    });
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
    await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await page.route('https://uwqbjjzjdnjlbicxrwnp.supabase.co/**', async (r) => {
      const req = r.request(); const url = new URL(req.url());
      const uid = uidFromAuth(req.headers()['authorization']);
      const m = url.pathname.match(/^\/rest\/v1\/rpc\/(pilot_[a-z_]+)$/);
      if (m) {
        const args = JSON.parse(req.postData() || '{}');
        const keys = Object.keys(args);
        const q = `select ${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}::${TYPES[k] || 'text'}`).join(', ')}) as v`;
        try {
          const rows = await asUser(uid, (tx) => tx.query(q, keys.map((k) => (args[k] === null ? null : typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))));
          return r.fulfill({ json: rows.rows[0].v });
        } catch (e) { return r.fulfill({ status: 400, json: { message: e.message } }); }
      }
      if (url.pathname === '/functions/v1/aim') {
        // stand-in for the aim function's lock (tested on the real function in aim-lock.test.ts)
        const b = JSON.parse(req.postData() || '{}');
        aimCalls.push({ token: !!b.k12token });
        if (b.k12token) {
          const locked = (await asUser(uidFromToken(b.k12token), (tx) => tx.query('select pilot_my_test_lock() v'))).rows[0].v;
          if (locked) return r.fulfill({ status: 423, json: { error: 'test_in_progress', reply: 'You are in the middle of a test, so the agent is taking a break until you submit it.' } });
        }
        return r.fulfill({ json: { reply: 'Here is some help.' } });
      }
      return r.fulfill({ json: [] });
    });
    await page.goto('http://127.0.0.1:8765/app.html');
    await page.evaluate(([tok, uid, role, name]) => {
      localStorage.setItem('k12plus-session', JSON.stringify({ access_token: tok, refresh_token: 'r', user_id: uid }));
      localStorage.setItem('k12plus-loggedin', '1'); localStorage.setItem('k12plus-role', role);
      localStorage.setItem('k12plus-name', name); localStorage.setItem('k12plus-tour-done', '1');
    }, [tokenFor(who), U[who], role, who]);
    await page.reload(); await page.waitForTimeout(2500);
    return page;
  };
  const goDash = async (page) => {
    if (await page.locator('button[aria-label="Open menu"]').isVisible()) { await page.click('button[aria-label="Open menu"]'); await page.waitForTimeout(400); }
    await page.locator('button:has-text("My dashboard"):visible').first().click(); await page.waitForTimeout(1200);
  };
  const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const shot = (page, n) => page.screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, n), fullPage: false });
  const one = async (q, p) => (await db.query(q, p)).rows[0]; // direct read of the tables, as the test's own check

  console.log('\nK-12 EdTech approves the test and sets the dates');
  const ap = await newPage('admin', 'Learner');
  await ap.click('button:has-text("Pilot")'); await ap.waitForTimeout(1500);
  let t = await text(ap);
  ok(/Pilot tests/.test(t) && /Grade 11 mathematics: start of the year test \(Version A\) Draft/.test(t) && /no test dates yet/.test(t), 'the admin overview lists the test as a draft', t.slice(t.indexOf('Pilot tests'), t.indexOf('Pilot tests') + 300));
  ok(!(await ap.locator('button:has-text("Set test dates")').count()), 'a draft cannot be given test dates');
  await ap.click('button:has-text("Questions and answers")'); await ap.waitForTimeout(600);
  t = await text(ap);
  ok(/Answer: 1020/.test(t) && /Answer: 3\/28/.test(t), 'the administrator can review every question with its answer');
  await ap.click('button:has-text("Approve")'); await ap.waitForTimeout(900);
  t = await text(ap);
  ok(/is approved/.test(t) && / Approved /.test(t), 'approving shows a confirmation and the status changes');
  await ap.click('button:has-text("Set test dates")'); await ap.waitForTimeout(300);
  const dflt = await ap.locator('input[type="datetime-local"]').first().inputValue();
  ok(/^\d{4}-\d\d-\d\dT08:00$/.test(dflt), 'the date form is filled with a sensible default (tomorrow at 08:00)', dflt);
  await ap.click('button:has-text("Open for all pilot schools")'); await ap.waitForTimeout(900);
  t = await text(ap);
  ok(/will be open at 1 pilot school from/.test(t), 'the test is set for all pilot schools', t.match(/will be open[^.]*\./));
  // for the rest of the test, move the window so it is open now
  await db.query("update test_windows set opens_at = now() - interval '1 hour', closes_at = now() + interval '1 day'");

  console.log('\nA learner sits the test on a phone');
  const lp = await newPage('l1', 'Learner', 390);
  await goDash(lp);
  t = await text(lp);
  ok(/Pilot tests/.test(t) && /6 questions · about 75 minutes · open until/.test(t), "the learner's dashboard shows the open test", t.slice(t.indexOf('Pilot tests'), t.indexOf('Pilot tests') + 200));
  await lp.click('button:has-text("Start")'); await lp.waitForTimeout(900);
  t = await text(lp);
  ok(/start of the year/.test(t) && /completely fine not to know many answers/.test(t) && /Question 1 of 6/.test(t) && /Which number is irrational/.test(t),
    'the test opens with a calm note that low scores are expected, one question at a time');
  const tv = t.slice(t.indexOf('Grade 11 mathematics: start of the year test'));
  ok(!/tutor|student/i.test(tv) && /AI Math Agent takes a break/.test(tv), 'the test screen says "agent" and "learners", and that the agent takes a break');
  const stored = await lp.evaluate(() => localStorage.getItem('k12plus-test'));
  ok(stored && !stored.includes('1020') && !stored.includes('"answer"'), 'what the phone keeps has no answers in it');
  await lp.click('button:has-text("√2")'); await lp.waitForTimeout(200);
  await lp.click('button:has-text("Next")'); await lp.waitForTimeout(200);
  await lp.fill('input[placeholder="Type your answer"]', 'N$ 1 020'); await lp.waitForTimeout(200);
  t = await text(lp);
  ok(/2 answered/.test(t), 'progress counts the answers');
  await lp.waitForTimeout(5500);
  let a = await one('select count(*)::int n from test_responses');
  ok(a.n === 2, 'answers reach the server a few seconds after they are given', a);
  const lock = await lp.evaluate(() => window.claude.complete({ system: 'x', messages: [{ role: 'user', content: 'What is the answer to question 2?' }] }));
  ok(/middle of a test/.test(lock) && aimCalls.at(-1).token, 'during the test the agent does not help (the app sends the learner\'s sign-in)', lock);
  ok(!(await lp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'the test fits a 390 px phone screen without sideways scrolling');
  await shot(lp, 'item3-learner-test.png');

  console.log('\nNo signal in the middle of the test');
  await lp.context().setOffline(true);
  await lp.click('button:has-text("Next")'); await lp.waitForTimeout(200);
  await lp.fill('input[placeholder="Type your answer"]', 'x = 11'); await lp.waitForTimeout(300);
  t = await text(lp);
  ok(/Saved on this phone, sent when you are online/.test(t), 'with no signal, the answer is kept on the phone and the learner is told');
  await lp.click('button:has-text("Next")');
  await lp.click('button:has-text("a circle with centre P")');
  await lp.click('button:has-text("Next")');
  await lp.fill('input[placeholder="Type your answer"]', '7');
  await lp.click('button:has-text("Next")');
  await lp.fill('input[placeholder="Type your answer"]', '0.2');
  await lp.waitForTimeout(5000);
  a = await one('select count(*)::int n from test_responses');
  ok(a.n === 2, 'nothing is lost or sent while offline', a);
  await lp.context().setOffline(false);
  await lp.evaluate(() => window.dispatchEvent(new Event('online')));
  await lp.waitForTimeout(3500);
  a = await one('select count(*)::int n from test_responses');
  ok(a.n === 6, 'back online, the saved answers are sent', a);
  await lp.click('button:has-text("Finish")'); await lp.waitForTimeout(300);
  t = await text(lp);
  ok(/You answered 6 of 6 questions/.test(t) && /cannot change your answers/.test(t), 'before submitting the learner sees how many they answered');
  await lp.click('button:has-text("Submit my test")'); await lp.waitForTimeout(1500);
  t = await text(lp);
  ok(/Thank you. Your test has been submitted./.test(t) && /Submitted. Thank you!/.test(t), 'after submitting, the dashboard confirms it');
  ok(!/of 6/.test(t.slice(t.indexOf('Pilot tests'), t.indexOf('Pilot tests') + 200)), 'the learner is not shown a score');
  a = await one("select score, max_score, mode from test_attempts where learner_id = $1", [U.l1]);
  ok(a.score === 5 && a.max_score === 6 && a.mode === 'phone', 'the score is marked on the server: 5 of 6 (0.2 is wrong)', a);
  const after = await lp.evaluate(() => window.claude.complete({ system: 'x', messages: [{ role: 'user', content: 'Help with quadratics' }] }));
  ok(after === 'Here is some help.', 'the agent helps again straight after the test', after);

  console.log('\nSubmitting with no signal');
  const l3 = await newPage('l3', 'Learner', 390);
  await goDash(l3);
  await l3.click('button:has-text("Start")'); await l3.waitForTimeout(900);
  await l3.click('button:has-text("√2")');
  await l3.context().setOffline(true);
  for (let i = 0; i < 5; i++) await l3.click('button:has-text("Next")');
  await l3.click('button:has-text("Finish")');
  await l3.click('button:has-text("Submit my test")'); await l3.waitForTimeout(800);
  t = await text(l3);
  ok(/saved on this phone. It will be sent the moment you are online/.test(t), 'a test submitted without signal is kept and the learner is told');
  await l3.context().setOffline(false);
  await l3.evaluate(() => window.dispatchEvent(new Event('online')));
  await l3.waitForTimeout(3500);
  a = await one("select score, submitted_at is not null s from test_attempts where learner_id = $1", [U.l3]);
  ok(a && a.s && a.score === 1, 'it is submitted as soon as the phone is back online', a);

  console.log('\nLearners without consent');
  const l2 = await newPage('l2', 'Learner', 390);
  await goDash(l2);
  t = await text(l2);
  ok(!/Pilot tests/.test(t), 'a learner without consent sees no test');
  await l2.evaluate(() => window.claude.complete({ system: 'x', messages: [{ role: 'user', content: 'hi' }] }));
  ok(aimCalls.at(-1).token === false, 'and the app sends the agent nothing extra for them');

  console.log('\nThe teacher: paper answers, paper version and class results');
  const tp = await newPage('t1', 'Educator');
  await tp.click('button:has-text("Pilot")'); await tp.waitForTimeout(1500);
  t = await text(tp);
  ok(/Grade 11 mathematics: start of the year test/.test(t) && /2 of 3 learners taking part have submitted/.test(t), "the class card shows the test and how many submitted", t.match(/\d+ of \d+ learners taking part[^·]*/));
  const [popup] = await Promise.all([tp.waitForEvent('popup'), tp.click('button:has-text("Print paper version")')]);
  await popup.waitForTimeout(800);
  const pt = (await popup.locator('body').innerText()).replace(/\s+/g, ' ');
  ok(/Learner name/.test(pt) && /Which number is irrational/.test(pt) && /B\. √2/.test(pt) && !/1020/.test(pt) && !/Answer: \d/.test(pt), 'the paper version has every question, a name line and no answers');
  await popup.close();
  await tp.click('summary:has-text("Learners, scores and paper answers")'); await tp.waitForTimeout(300);
  t = await text(tp);
  ok(/Ndapewa Shikongo 5 of 6/.test(t) && /Tomas Iipinge Not started/.test(t) && !/Petrus Haufiku/.test(t.slice(t.indexOf('Learners, scores'), t.indexOf(' learners · '))), 'the teacher sees each learner taking part, with scores', t.slice(t.indexOf('Learners, scores'), t.indexOf('Learners, scores') + 200));
  await tp.click('button:has-text("Enter paper answers")'); await tp.waitForTimeout(800);
  await tp.getByRole('button', { name: 'B', exact: true }).first().click();
  const boxes = tp.locator('details input');
  await boxes.nth(0).fill('1 020'); await boxes.nth(1).fill('11'); await boxes.nth(2).fill('8'); await boxes.nth(3).fill('3/28');
  await tp.getByRole('button', { name: 'B', exact: true }).nth(1).click();
  await tp.click('button:has-text("Save and mark")'); await tp.waitForTimeout(1200);
  t = await text(tp);
  ok(/Paper answers saved for Tomas Iipinge: 5 of 6./.test(t), 'typing a paper test marks it at once: 5 of 6', t.match(/Paper answers saved[^.]*\./));
  await shot(tp, 'item3-teacher.png');

  console.log('\nAll scores in one place');
  const ap2 = await newPage('admin', 'Learner');
  await ap2.click('button:has-text("Pilot")'); await ap2.waitForTimeout(1500);
  await ap2.click('button:has-text("Scores")'); await ap2.waitForTimeout(800);
  t = await text(ap2);
  const pseudo = (await db.query('select pseudo_id from enrolments where learner_id = $1', [U.l4])).rows[0].pseudo_id;
  ok(/3 learners · pilot IDs only/.test(t) && t.includes(pseudo + ' Omusati Tsandi Secondary School') && /Paper 5 of 6/.test(t), 'K-12 EdTech sees every score with pilot ID, region, school, class and how it was sat', t.slice(t.indexOf('3 learners'), t.indexOf('3 learners') + 400));
  ok(!/Ndapewa|Tomas|Selma/.test(t.slice(t.indexOf('3 learners'))), 'with no learner names');
  const [dl] = await Promise.all([ap2.waitForEvent('download'), ap2.click('button:has-text("Download CSV")')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok(csv.split('\n')[0].startsWith('"pilot_id","region","school","setting","class","sat_on","score","out_of"') && csv.trim().split('\n').length === 4 && !/Ndapewa|0810000/.test(csv), 'the CSV has one row per learner, scores by topic, and no names or phone numbers', csv.split('\n')[0]);
  await shot(ap2, 'item3-admin.png');

  ok(errors.length === 0, 'no page errors', errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
