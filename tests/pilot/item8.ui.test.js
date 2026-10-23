// Item 8 end to end: the real app.html in headless Chromium, with Supabase replaced by
// the local PGlite database running the real migrations. Covers: the alert on the
// administrator's Pilot page, last month's report in one click, the CSV, prices and
// typed-in costs, the champion's region report, and data use measured on a learner's phone.
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
  p_from: 'date', p_to: 'date', p_id: 'bigint' };
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql', '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql'];

// last calendar month, worked out the same way as the page does
const d = new Date();
const lmFrom = new Date(d.getFullYear(), d.getMonth() - 1, 1), lmTo = new Date(d.getFullYear(), d.getMonth(), 0);
const ymd = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
const inLastMonth = (day, hour) => new Date(lmFrom.getFullYear(), lmFrom.getMonth(), day, hour).toISOString();

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  for (const f of MIGS) await db.exec(fs.readFileSync(path.join(__dirname, '../../backend/migrations', f), 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@test.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, learner_uid, phone) values ($1,$2,$3,$4,$5,$6,$7)',
      [U[key], o.name || key, role, o.grade || null, 'Namibia', o.uid || null, o.phone || null]);
  };
  for (const [k, name, reg] of [['A', 'Tsandi Secondary School', 10], ['B', 'Outapi Secondary School', 10], ['C', 'Karibib Secondary School', 1], ['D', 'Swakopmund Secondary School', 1]])
    S[k] = (await db.query("insert into schools (name, region, country, region_id) values ($1, 'x', 'Namibia', $2) returning id", [name, reg])).rows[0].id;
  await mk('admin', 'learner', { name: 'Pilot Admin' }); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('champ', 'educator', { name: 'Ms Champion' });
  const asUser = (uid, fn) => db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await tx.query('set local role authenticated');
    return fn(tx);
  });
  const sql = (who, q, p) => asUser(U[who], (tx) => tx.query(q, p));
  const svc = (q, p) => db.transaction(async (tx) => { await tx.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)"); return tx.query(q, p); });
  const consent = (b) => svc('select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-08-20', ...b })]);
  const cls = {};
  for (const [reg, a, b] of [[10, 'A', 'B'], [1, 'C', 'D']]) {
    const set = (await sql('admin', 'select pilot_setup_region($1::smallint, $2::jsonb) v', [reg, JSON.stringify([{ school_id: S[a], setting: 'rural' }, { school_id: S[b], setting: 'urban' }])])).rows[0].v;
    for (const sc of set.schools) cls[sc.id] = sc.classes.find((c) => c.grade === 11);
  }
  await sql('admin', "select pilot_set_champion(1::smallint, 'champ@test.na')");
  for (const k of ['A', 'B', 'C', 'D']) await consent({ kind: 'school', school_id: S[k], given_by_relation: 'principal' });
  const learners = { a1: ['A', true, 'Ndapewa Shikongo'], a2: ['A', true, 'Tomas Haufiku'], b1: ['B', true, 'Selma Nangolo'], c1: ['C', true, 'Petrus Iipinge'], d1: ['D', true, 'Maria Gowases'], x1: ['A', false, 'No Consent'] };
  for (const [k, [sch, withC, name]] of Object.entries(learners)) {
    await mk(k, 'learner', { name, grade: 11, uid: 'K12-NA-' + k.toUpperCase() + 'XXX', phone: '08100000' + k });
    await sql(k, 'select pilot_join_class($1)', [cls[S[sch]].code]);
    if (withC) await consent({ kind: 'guardian', learner_id: U[k] });
  }
  // last month: a1 used 2.5 GB of data (US$3.00, ahead of the budget), the others a little
  let ref = 0;
  const ev = (k, kind, at, o = {}) => db.query('insert into learning_events (learner_id, class_id, kind, topic, attempted, duration_seconds, bytes, client_ref, occurred_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [U[k], cls[S[learners[k][0]]].id, kind, o.topic || null, o.attempted || null, o.duration || null, o.bytes || null, 'ui-' + String(++ref).padStart(6, '0'), at]);
  for (let i = 0; i < 25; i++) await ev('a1', 'data', inLastMonth(10, 16), { bytes: 100000000 });
  await ev('a1', 'question', inLastMonth(10, 16), { topic: 'Algebra' }); await ev('a1', 'active', inLastMonth(10, 16), { duration: 1800 });
  await ev('b1', 'practice', inLastMonth(12, 17), { topic: 'Geometry', attempted: 6 }); await ev('b1', 'data', inLastMonth(12, 17), { bytes: 4000000 });
  await ev('c1', 'question', inLastMonth(14, 15), { topic: 'Statistics' }); await ev('c1', 'ussd', inLastMonth(20, 10));
  await svc("select pilot_check_spending($1::timestamptz)", [new Date(lmTo.getFullYear(), lmTo.getMonth(), lmTo.getDate(), 20).toISOString()]);

  const tokenFor = (key) => 'h.' + Buffer.from(JSON.stringify({ exp: 9999999999, sub: U[key] })).toString('base64').replace(/=/g, '') + '.s';
  const uidFromAuth = (h) => { try { return JSON.parse(Buffer.from((h || '').split('.')[1], 'base64').toString()).sub; } catch (e) { return null; } };
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
      if (url.pathname === '/functions/v1/aim') return r.fulfill({ json: { reply: 'Here is some help with that.' } });
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
  const pseudo = async (k) => (await db.query('select pseudo_id from enrolments where learner_id = $1', [U[k]])).rows[0].pseudo_id;

  console.log('\nThe administrator: alert and monthly report');
  const ap = await newPage('admin', 'Learner');
  await ap.click('button:has-text("Pilot")'); await ap.waitForTimeout(1500);
  let t = await text(ap);
  const pa1 = await pseudo('a1');
  ok(/Spending ahead of budget/.test(t) && t.includes('Learner ' + pa1 + ' at Tsandi Secondary School, ' + lmFrom.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) + ': US$3.00, above the US$2.50 the budget allows so far.') && (t.match(/Mark as seen/g) || []).length === 1,
    'the alert is on the Pilot page: the learner who used 2.5 GB last month (and no school, as Tsandi is at US$1.50 per learner)', t.slice(t.indexOf('Spending ahead'), t.indexOf('Spending ahead') + 400));
  ok(!/Ndapewa|Tomas/.test(t.slice(t.indexOf('Pilot reports'), t.indexOf('Pilot reports') + 1500)), 'alerts and reports show pilot IDs, not names');
  await ap.click('button:has-text("Last month")'); await ap.waitForTimeout(1500);
  t = await text(ap);
  const fromTxt = lmFrom.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  ok(t.includes(fromTxt + ' to') && /All: 5 learners taking part · 3 active · 4 sessions · 30 minutes · 2 questions · 6 practice answers · 3 topics · 1 USSD session · 2504 MB of data · 0 texts/.test(t),
    "one click gives last month's report for every pilot school, with the totals", t.slice(t.indexOf('All:'), t.indexOf('All:') + 260));
  ok(/Tsandi Secondary School Omusati Rural 1 \/ 2 1 30 1 0 2500 MB 0 US\$1\.50/.test(t) && /Karibib Secondary School Erongo Rural 1 \/ 1 2 0 1 1 0 MB 0 US\$0\.03/.test(t) && /Swakopmund Secondary School Erongo Urban 0 \/ 1/.test(t),
    'each school has its row: active and taking part, sessions, minutes, topics, USSD, data, texts and cost per learner', t.slice(t.indexOf('Cost per learner'), t.indexOf('Cost per learner') + 400));
  ok(/Rural schools: 2 of 3 active · 3 sessions · 30 minutes · 2500 MB/.test(t) && /Urban schools: 1 of 2 active · 1 session · 0 minutes · 4 MB/.test(t), 'rural and urban schools are reported separately');
  const [dl] = await Promise.all([ap.waitForEvent('download'), ap.click('button:has-text("Download CSV")')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok(csv.includes('"school","Omusati","Tsandi Secondary School","rural"') && csv.includes('"' + pa1 + '"') && !/Ndapewa|0810000|K12-NA-/.test(csv) && csv.includes('"total"') && csv.includes('"class"'),
    'the CSV has every level (total, setting, region, school, class) and each learner by pilot ID only', csv.split('\n').slice(0, 3));
  await shot(ap, 'item8-admin.png');
  await ap.click('summary:has-text("Prices and costs typed in")'); await ap.waitForTimeout(300);
  const priceBox = ap.locator('label:has-text("Data, US$ per GB") input');
  ok((await priceBox.inputValue()) === '1.2' || (await priceBox.inputValue()) === '1.2000', 'the prices form shows the data price', await priceBox.inputValue());
  await priceBox.fill('2.40');
  await ap.click('button:has-text("Save prices")'); await ap.waitForTimeout(1800);
  t = await text(ap);
  ok(/Prices saved/.test(t) && /Tsandi Secondary School Omusati Rural 1 \/ 2 1 30 1 0 2500 MB 0 US\$3\.00/.test(t), 'changing the data price updates the report straight away');
  await ap.locator('input[placeholder="Amount, US$"]').fill('40');
  await ap.locator('input[placeholder="Note, e.g. data bundles"]').fill('Data bundles for Karibib');
  await ap.locator('select').selectOption({ label: 'Karibib Secondary School' });
  await ap.locator('input[type="month"]').fill(ymd(lmFrom).slice(0, 7));
  await ap.click('button:has-text("Add cost")'); await ap.waitForTimeout(1800);
  t = await text(ap);
  ok(/Cost added/.test(t) && /Karibib Secondary School Erongo Rural 1 \/ 1 2 0 1 1 0 MB 0 US\$40\.03/.test(t) && /Karibib Secondary School · .* · US\$40\.00 · Data bundles for Karibib/.test(t), 'a cost typed in for a school is added to that school', t.match(/Karibib Secondary School Erongo[^U]*US\$[\d.]+/));
  await ap.click('button:has-text("Mark as seen") >> nth=0'); await ap.waitForTimeout(1200);
  t = await text(ap);
  ok(/Alert marked as seen/.test(t) && !/Spending ahead of budget/.test(t), 'an alert can be marked as seen');

  console.log('\nThe regional champion');
  const cp = await newPage('champ', 'Educator');
  await cp.click('button:has-text("Pilot")'); await cp.waitForTimeout(1500);
  await cp.click('button:has-text("Last month")'); await cp.waitForTimeout(1500);
  t = await text(cp);
  ok(/Region report/.test(t) && /Karibib Secondary School Erongo/.test(t) && /Swakopmund Secondary School Erongo/.test(t) && !/Tsandi Secondary School Omusati/.test(t), "the champion gets the same report for Erongo only");
  ok(!/Prices and costs typed in/.test(t) && !/Spending ahead of budget/.test(t), 'without the prices form or the alert list');

  console.log("\nData use measured on a learner's phone");
  const lp = await newPage('a2', 'Learner', 390);
  await lp.waitForTimeout(1500);
  const flag = await lp.evaluate(() => localStorage.getItem('k12plus-pilot-taking-part'));
  await lp.evaluate(() => window.claude.complete({ system: 'x', messages: [{ role: 'user', content: 'What is a prime number?' }] }));
  await lp.waitForTimeout(500);
  await lp.evaluate(async () => { window.k12learn.bankData(); await window.k12learn.flush(); });
  await lp.waitForTimeout(1200);
  const rows = (await db.query("select bytes from learning_events where learner_id = $1 and kind = 'data'", [U.a2])).rows;
  const bytes = rows.reduce((a, r) => a + Number(r.bytes), 0);
  const appSize = fs.statSync(path.join(__dirname, '../../app.html')).size;
  ok(flag === '1' && rows.length >= 1 && bytes > appSize, "the learner's phone records the data the app used (the page, its files and the agent's answer)", { flag, rows: rows.length, bytes, appSize });
  const xp = await newPage('x1', 'Learner', 390);
  await xp.evaluate(async () => { window.k12learn.bankData(); await window.k12learn.flush(); });
  await xp.waitForTimeout(800);
  ok((await db.query("select count(*)::int n from learning_events where learner_id = $1", [U.x1])).rows[0].n === 0, 'nothing is recorded for a learner without consent');

  ok(errors.length === 0, 'no page errors', errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
