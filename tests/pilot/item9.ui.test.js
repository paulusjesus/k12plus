// Item 9 end to end: the real app.html in headless Chromium, with Supabase replaced by
// the local PGlite database running the real migrations. Covers: a pilot learner's chat
// reply kept for review, the monthly sample, a teacher completing a review of ten answers
// on a phone (timed), and the results for the team.
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
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const TYPES = { p_events: 'jsonb', p_reason: 'text', p_days: 'int', p_size: 'int', p_status: 'text', p_random: 'boolean', p: 'jsonb', p_region: 'smallint', p_schools: 'jsonb',
  p_class: 'uuid', p_teacher: 'uuid', p_learner: 'uuid', p_school: 'uuid', p_removal: 'bigint', p_test: 'uuid', p_attempt: 'bigint', p_answers: 'jsonb', p_opens: 'timestamptz', p_closes: 'timestamptz',
  p_from: 'date', p_to: 'date', p_id: 'bigint', p_month: 'date', p_batch: 'bigint', p_item: 'bigint', p_verdict: 'text', p_comment: 'text' };
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql', '20261027_pilot_learning_and_summaries.sql',
  '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql'];
const d = new Date();
const lm = new Date(d.getFullYear(), d.getMonth() - 1, 1);
const lmStr = lm.getFullYear() + '-' + String(lm.getMonth() + 1).padStart(2, '0');

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  for (const f of MIGS) await db.exec(fs.readFileSync(path.join(__dirname, '../../backend/migrations', f), 'utf8'));
  const U = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@test.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, learner_uid) values ($1,$2,$3,$4,$5,$6)', [U[key], o.name || key, role, o.grade || null, 'Namibia', o.uid || null]);
  };
  const school = (await db.query("insert into schools (name, region, country, region_id) values ('Tsandi Secondary School', 'x', 'Namibia', 10) returning id")).rows[0].id;
  await mk('admin', 'learner', { name: 'Pilot Admin' }); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('t1', 'educator', { name: 'Ms Amutenya' });
  const asUser = (uid, fn) => db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await tx.query('set local role authenticated');
    return fn(tx);
  });
  const sql = (who, q, p) => asUser(U[who], (tx) => tx.query(q, p));
  const svc = (q, p) => db.transaction(async (tx) => { await tx.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)"); return tx.query(q, p); });
  const set = (await sql('admin', 'select pilot_setup_region(10::smallint, $1::jsonb) v', [JSON.stringify([{ school_id: school, setting: 'rural' }])])).rows[0].v;
  const c11 = set.schools[0].classes.find((c) => c.grade === 11);
  await sql('admin', 'select pilot_assign_teacher($1::uuid, $2)', [c11.id, 't1@test.na']);
  const consent = (b) => svc('select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-09-01', ...b })]);
  await consent({ kind: 'school', school_id: school, given_by_relation: 'principal' });
  for (const [k, name] of [['l1', 'Ndapewa Shikongo'], ['l2', 'Tomas Haufiku']]) {
    await mk(k, 'learner', { name, grade: 11, uid: 'K12-NA-' + k.toUpperCase() + 'XXX' });
    await sql(k, 'select pilot_join_class($1)', [c11.code]);
    await consent({ kind: 'guardian', learner_id: U[k] });
  }
  // last month: 14 replies to this class
  const topics = ['Quadratic equations', 'Simultaneous equations', 'Probability', 'Trigonometry', 'Sequences', 'Indices', 'Vectors'];
  for (let i = 0; i < 14; i++) {
    await db.query("insert into agent_exchanges (learner_id, class_id, kind, subject, topic, question, reply, created_at) values ($1, $2, 'chat', 'Mathematics', $3, $4, $5, $6)",
      [U[i % 2 ? 'l1' : 'l2'], c11.id, topics[i % 7], 'How do I solve problem ' + (i + 1) + ' on ' + topics[i % 7] + '?',
       'Good question! 💡 Step 1: write down what you know. Step 2: ' + (i === 3 ? 'divide both sides by zero.' : 'use the rule for ' + topics[i % 7] + '.') + ' Step 3: check your answer. ✅',
       new Date(lm.getFullYear(), lm.getMonth(), 3 + i, 15).toISOString()]);
  }

  const tokenFor = (key) => 'h.' + Buffer.from(JSON.stringify({ exp: 9999999999, sub: U[key] })).toString('base64').replace(/=/g, '') + '.s';
  const uidFromAuth = (h) => { try { return JSON.parse(Buffer.from((h || '').split('.')[1], 'base64').toString()).sub; } catch (e) { return null; } };
  const aimSeen = [];
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const newPage = async (who, role, width = 1280) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(who + ': ' + e.message));
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
        // stand-in for the aim function (tested on the real function in aim-lock.test.ts): same calls, same database
        const b = JSON.parse(req.postData() || '{}');
        aimSeen.push({ token: !!b.k12token, feedback: b.k12feedback || null });
        const reply = 'A prime number has exactly two factors: 1 and itself. 💡';
        if (b.k12token) {
          const ctx = (await asUser(uidFromAuth('Bearer ' + b.k12token), (tx) => tx.query('select pilot_agent_context() v'))).rows[0].v;
          if (ctx.taking_part && b.k12feedback) {
            const question = b.messages.filter((x) => x.role !== 'assistant').slice(-1)[0].content;
            await svc('select pilot_save_exchange($1::jsonb)', [JSON.stringify({ learner_id: ctx.learner_id, kind: b.k12feedback.kind, subject: b.k12feedback.subject, question, reply })]);
          }
        }
        return r.fulfill({ json: { reply } });
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
  const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const shot = (page, n) => page.screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, n), fullPage: false });

  console.log("\nA pilot learner's chat reply is kept for review");
  const lp = await newPage('l1', 'Learner');
  await lp.waitForTimeout(800);
  await lp.locator('textarea').first().fill('What is a prime number?');
  await lp.locator('button[title="Send"]').first().click(); await lp.waitForTimeout(1500);
  const kept = (await db.query("select question, reply, kind, subject from agent_exchanges where learner_id = $1 and question = 'What is a prime number?'", [U.l1])).rows;
  ok(aimSeen.at(-1).token && aimSeen.at(-1).feedback && aimSeen.at(-1).feedback.kind === 'chat' && kept.length === 1 && /exactly two factors/.test(kept[0].reply),
    'the chat box marks the reply for review, and the question and reply are kept', { seen: aimSeen.at(-1), kept });

  console.log('\nThe monthly sample, prepared by K-12 EdTech');
  const ap = await newPage('admin', 'Learner');
  await ap.click('button:has-text("Pilot")'); await ap.waitForTimeout(1500);
  await ap.locator('input[type="month"]').first().fill(lmStr);
  await ap.click('button:has-text("Prepare samples from this month now")'); await ap.waitForTimeout(1500);
  let t = await text(ap);
  ok(/Samples prepared for 1 teacher\./.test(t), 'the administrator can prepare the samples now (the job does it on the 1st of each month)', t.match(/Samples prepared[^.]*\.|No new samples[^.]*\./));

  console.log('\nThe teacher reviews ten answers on a phone');
  const tp = await newPage('t1', 'Educator', 390);
  await tp.click('button[aria-label="Open menu"]'); await tp.waitForTimeout(400);
  await tp.locator('button:has-text("Pilot"):visible').first().click(); await tp.waitForTimeout(1500);
  t = await text(tp);
  ok(/Monthly review of the agent's answers/.test(t) && /10 answers the agent gave your learners in/.test(t), "the teacher's Pilot page shows the monthly review card");
  const t0 = Date.now();
  await tp.click('button:has-text("Start the review")'); await tp.waitForTimeout(500);
  t = await text(tp);
  const card = t.slice(t.indexOf('Monthly review of the agent'), t.indexOf('Save and next'));
  ok(/Answer 1 of 10 · Grade 11 · Mathematics/.test(card) && /Question from a learner/i.test(card) && /The agent's answer/i.test(card) && !/Ndapewa|Tomas|K12-NA-/.test(card), 'one answer at a time, with the question, the reply, grade and subject, and no learner names', card.slice(0, 200));
  ok(!(await tp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'it fits a 390 px phone screen');
  await shot(tp, 'item9-teacher-review.png');
  let clicks = 0, unsuitableDone = false;
  for (let i = 0; i < 10; i++) {
    const body = await text(tp);
    const bad = /divide both sides by zero/.test(body);
    const unsuit = !bad && !unsuitableDone && i >= 6;
    if (unsuit) unsuitableDone = true;
    await tp.getByRole('button', { name: bad ? 'Incorrect' : unsuit ? 'Unsuitable' : 'Correct', exact: true }).click(); clicks++;
    if (bad) await tp.locator('input[placeholder^="Comment"]').fill('Dividing by zero is not allowed.');
    if (unsuit) await tp.locator('input[placeholder^="Comment"]').fill('Too many emojis for this question.');
    await tp.click(i < 9 ? 'button:has-text("Save and next")' : 'button:has-text("Save and finish")'); clicks++;
    await tp.waitForTimeout(350);
  }
  await tp.waitForTimeout(800);
  const elapsed = (Date.now() - t0) / 1000;
  t = await text(tp);
  const mins = Number((t.match(/in ([\d.]+) minutes/) || [])[1]);
  ok(/Thank you. You reviewed 10 answers from/.test(t) && mins >= 0 && mins < 15, 'after ten answers the teacher sees a thank-you, with the time taken recorded by the server', { line: t.match(/Thank you[^.]*\./), mins });
  ok(clicks === 20 && elapsed < 60, `each answer needs two taps (a verdict and Save); this scripted reviewer took ${Math.round(elapsed)} seconds for ten`, { clicks, elapsed });
  const saved = (await db.query("select verdict, count(*)::int n from review_items group by verdict order by verdict")).rows;
  ok(saved.reduce((a, x) => a + x.n, 0) === 10 && saved.every((x) => x.verdict), 'all ten verdicts are saved', saved);

  console.log('\nResults for the team');
  await ap.click('button:has-text("Show results")'); await ap.waitForTimeout(1500);
  t = await text(ap);
  const inc = saved.find((x) => x.verdict === 'incorrect');
  ok(/\d+ correct \(\d+%\) · \d+ incorrect \(\d+%\) · 1 unsuitable \(10%\) · 0 still to review/.test(t) && /Ms Amutenya, Tsandi Secondary School 10 of 10 reviewed in [\d.]+ minutes/.test(t),
    'K-12 EdTech sees the counts, and each teacher with how many they did and how long it took', t.match(/\d+ correct[^·]*·[^·]*·[^·]*·[^R]*/));
  await ap.getByRole('button', { name: 'Unsuitable', exact: true }).click(); await ap.waitForTimeout(300);
  t = await text(ap);
  ok(/Unsuitable Grade 11 · Mathematics/.test(t) && /Teacher: Too many emojis for this question\./.test(t) && /reviewed by Ms Amutenya/.test(t), 'the team can filter by verdict and read the teacher\'s comment');
  await ap.getByRole('button', { name: 'Incorrect', exact: true }).click(); await ap.waitForTimeout(300);
  t = await text(ap);
  ok(!inc || /Teacher: Dividing by zero is not allowed\./.test(t), 'the wrong answer about dividing by zero is listed under Incorrect, with the comment');
  const [dl] = await Promise.all([ap.waitForEvent('download'), ap.click('button:has-text("Download CSV")')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok(csv.startsWith('"verdict","comment","seconds"') && csv.trim().split('\n').length >= 11 && !/Ndapewa|Tomas|K12-NA-/.test(csv), 'the results download as a CSV, without learner names');
  await shot(ap, 'item9-admin.png');

  ok(errors.length === 0, 'no page errors', errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
