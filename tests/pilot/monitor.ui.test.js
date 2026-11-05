// Monitoring end to end: the real monitor/index.html in headless Chromium, with Supabase
// replaced by the local PGlite database running the real migrations.
// Covers: signing in (email, k12plus ID, wrong password), a learner's own progress, a learner
// without consent, a teacher's class with names and one learner, the national view down to a
// class without names, small groups hidden, the officials page, the CSV, the period, a 390 px
// phone, signing out, and the words "agent" and "learners".
const { chromium } = require('playwright');
const { PGlite } = require('@electric-sql/pglite');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql',
  '20261031_pilot_evaluator_export.sql', '20261101_pilot_offline_lessons.sql', '20261102_pilot_ussd.sql', '20261103_plan_allowance.sql', '20261105_monitoring.sql'];
const TYPES = { p_learner: 'uuid', p_class: 'uuid', p_school: 'uuid', p_region: 'smallint', p_weeks: 'int', p_identifier: 'text', p_title: 'text', p_user: 'uuid' };
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  for (const f of MIGS) await db.exec(fs.readFileSync(path.join(__dirname, '../../backend/migrations', f), 'utf8'));
  const U = {}, S = {}, PW = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@school.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, learner_uid) values ($1,$2,$3,$4,$5,$6)', [U[key], o.name || key, role, o.grade || null, 'Namibia', o.uid || null]);
    PW[key] = 'pass-' + key;
  };
  const asUser = (uid, fn) => db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await tx.query('set local role authenticated');
    return fn(tx);
  });
  const sql = (who, q, p) => asUser(U[who], (tx) => tx.query(q, p));
  const svc = (q, p) => db.transaction(async (tx) => { await tx.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)"); return tx.query(q, p); });
  const consent = (b) => svc('select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-09-01', ...b })]);

  await mk('admin', 'learner', { name: 'Pilot Admin' }); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  for (const [k, name, reg] of [['T', 'Tsandi Secondary School', 10], ['O', 'Outapi Secondary School', 10], ['K', 'Karibib Secondary School', 1], ['W', 'Swakopmund Secondary School', 1]])
    S[k] = (await db.query("insert into schools (name, region, country, region_id) values ($1, 'x', 'Namibia', $2) returning id", [name, reg])).rows[0].id;
  const cls = {};
  for (const [reg, a, b] of [[10, 'T', 'O'], [1, 'K', 'W']]) {
    const set = (await sql('admin', 'select pilot_setup_region($1::smallint, $2::jsonb) v', [reg, JSON.stringify([{ school_id: S[a], setting: 'rural' }, { school_id: S[b], setting: 'urban' }])])).rows[0].v;
    for (const sc of set.schools) for (const c of sc.classes) cls[sc.id + c.grade] = c;
  }
  await mk('teacher', 'educator', { name: 'Ms Amutenya' });
  await mk('director', 'educator', { name: 'Mr Regional Director' });
  await mk('national', 'educator', { name: 'Dr Shilongo' });
  await sql('admin', 'select pilot_assign_teacher($1::uuid, $2)', [cls[S.T + 11].id, 'teacher@school.na']);
  await sql('admin', "select monitor_add_official('national@school.na', null, 'Ministry of Education, Arts and Culture')");
  for (const k of ['T', 'O', 'K', 'W']) await consent({ kind: 'school', school_id: S[k], given_by_relation: 'principal' });
  const first = ['Ndapewa', 'Tomas', 'Selma', 'Petrus', 'Maria', 'Johannes', 'Hilma'];
  const plan = [['T', 11, 6], ['T', 12, 3], ['O', 11, 5], ['K', 11, 5]];
  const names = [];
  const SURNAMES = ['Shikongo', 'Haufiku', 'Nangolo', 'Iipinge', 'Gowases', 'Amukoto', 'Nghifikwa', 'Kaulinge', 'Mbango', 'Uushona', 'Hamutenya', 'Shipanga', 'Nakale', 'Kamati', 'Tjiriange', 'Muyamba', 'Situde', 'Beukes', 'Kandjii'];
  let ref = 0, n = 0;
  const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString();
  for (const [sch, g, count] of plan) for (let i = 0; i < count; i++, n++) {
    const key = `${sch}${g}_${i}`, name = first[i] + ' ' + SURNAMES[n];
    names.push(name);
    await mk(key, 'learner', { name, grade: g, uid: 'K12-NA-' + String(n).padStart(6, '0') });
    await sql(key, 'select pilot_join_class($1)', [cls[S[sch] + g].code]);
    await consent({ kind: 'guardian', learner_id: U[key] });
    const ev = (kind, at, o = {}) => db.query('insert into learning_events (learner_id, class_id, kind, subject, topic, correct, attempted, duration_seconds, client_ref, occurred_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [U[key], cls[S[sch] + g].id, kind, 'Mathematics', o.topic || null, o.correct ?? null, o.attempted ?? null, o.duration ?? null, 'u-' + String(++ref).padStart(6, '0'), at]);
    for (const w of [0, 1, 3, 6]) {
      await ev('practice', ago(w * 7 + 1), { topic: 'Algebra', correct: 5 + ((i + w) % 4), attempted: 10 });
      await ev('quiz', ago(w * 7 + 1), { topic: 'Trigonometry', correct: 2 + (i % 3), attempted: 10 });
      await ev('active', ago(w * 7 + 1), { duration: 900 });
      await ev('question', ago(w * 7 + 1));
    }
  }
  await mk('nocon', 'learner', { name: 'Hidden Learner', grade: 11, uid: 'K12-NA-HIDDEN' });
  await sql('nocon', 'select pilot_join_class($1)', [cls[S.T + 11].code]);
  const tid = (await db.query("insert into tests (code, grade, syllabus, form, purpose, title, status) values ('PILOT27-G11-A', 11, '6131', 'A', 'baseline', 'Baseline test, Grade 11', 'approved') returning id")).rows[0].id;
  for (let i = 0; i < 6; i++) await db.query("insert into test_attempts (test_id, learner_id, mode, submitted_at, score, max_score) values ($1,$2,'phone',now() - interval '50 days',$3,20)", [tid, U['T11_' + i], 7 + i]);

  // a stand-in for the website (the monitor folder) and for Supabase
  const root = path.join(__dirname, '../../monitor');
  const server = http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'image/png' }); fs.createReadStream(f).pipe(res);
  }).listen(8766);
  const tokenFor = (uid) => 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: uid })).toString('base64').replace(/=/g, '') + '.s';
  const uidFromAuth = (h) => { try { return JSON.parse(Buffer.from((h || '').split(' ')[1].split('.')[1], 'base64').toString()).sub; } catch (e) { return null; } };
  const byIdent = async (ident) => {
    const r = await db.query("select p.id, u.email from profiles p join auth.users u on u.id = p.id where lower(u.email) = lower($1) or p.learner_uid = upper($1)", [ident]);
    return r.rows[0];
  };
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [], calls = [];
  const newPage = async (width = 1280) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
    await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await page.route('https://uwqbjjzjdnjlbicxrwnp.supabase.co/**', async (r) => {
      const req = r.request(); const url = new URL(req.url());
      const body = JSON.parse(req.postData() || '{}');
      calls.push(url.pathname);
      if (url.pathname === '/auth/v1/token' || url.pathname === '/functions/v1/auth-login') {
        if (url.searchParams.get('grant_type') === 'refresh_token') return r.fulfill({ status: 400, json: { error: 'invalid_grant' } });
        const who = await byIdent(body.email || body.identifier || '');
        const key = who && Object.keys(U).find((k) => U[k] === who.id);
        if (!key || PW[key] !== body.password) return r.fulfill({ status: 400, json: url.pathname.includes('auth-login') ? { error: 'Those details do not match a k12plus account. Check your number or ID and password.' } : { error_description: 'Invalid login credentials' } });
        return r.fulfill({ json: { access_token: tokenFor(who.id), refresh_token: 'r-' + key, user: { id: who.id } } });
      }
      if (url.pathname === '/auth/v1/logout') return r.fulfill({ status: 204, body: '' });
      if (url.pathname === '/rest/v1/regions') return r.fulfill({ json: (await db.query('select id, name from regions order by name')).rows });
      const m = url.pathname.match(/^\/rest\/v1\/rpc\/(monitor_[a-z_]+)$/);
      if (m) {
        const keys = Object.keys(body);
        const q = `select ${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}::${TYPES[k] || 'text'}`).join(', ')}) as v`;
        try {
          const rows = await asUser(uidFromAuth(req.headers()['authorization']), (tx) => tx.query(q, keys.map((k) => body[k])));
          return r.fulfill({ json: rows.rows[0].v });
        } catch (e) { return r.fulfill({ status: 400, json: { message: e.message } }); }
      }
      return r.fulfill({ status: 404, json: { message: 'not in the stand-in' } });
    });
    await page.goto('http://127.0.0.1:8766/');
    return page;
  };
  const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const shot = (page, f) => page.screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, f), fullPage: true });
  const signIn = async (page, ident, pw) => {
    await page.fill('#u', ident); await page.fill('#p', pw); await page.click('button[type=submit]'); await page.waitForTimeout(900);
  };
  const noNames = (t) => !names.some((x) => t.includes(x)) && !t.includes('Hidden Learner');
  const words = (t) => !/\btutor|\bstudent/i.test(t);

  console.log('\n1. Signing in');
  let p = await newPage();
  let t = await text(p);
  ok(/Sign in to K12Plus Monitor/.test(t) && /Email, mobile number or k12plus ID/.test(t), 'the sign-in screen shows first');
  await signIn(p, 'teacher@school.na', 'wrong');
  ok(/do not match/.test(await text(p)), 'a wrong password shows a clear message', await text(p));
  await signIn(p, 'teacher@school.na', PW.teacher);
  t = await text(p);
  ok(/Ms Amutenya/.test(t) && p.url().includes('#class/' + cls[S.T + 11].id), 'the teacher lands on their class', p.url());

  console.log('\n2. The teacher\'s class, by name');
  const six = names.slice(0, 6);
  ok(six.every((x) => t.includes(x)) && !t.includes('Hidden Learner'), 'all six learners with consent are listed by name, the learner without consent is not');
  ok(/Learners 6/.test(t) && /Active this week 6/.test(t) && /Practice accuracy \d+%/.test(t) && /Questions to the agents 24/.test(t), 'tiles: learners, active, accuracy, questions to the agents', t.slice(0, 700));
  ok(/Week by week/.test(t) && (await p.locator('.chart svg rect').count()) === 12 && (await p.locator('.chart svg circle').count()) === 4, 'the trend has twelve weeks, accuracy marked for the four weeks with practice');
  ok(/Topics that need attention Trigonometry/.test(t), 'the weakest topic comes first', t.slice(t.indexOf('Topics that'), t.indexOf('Topics that') + 120));
  ok(/Baseline 48%/.test(t.replace(/\s/g, ' ').replace('Baseline Endline', '')) || /Test average 48%/.test(t), 'the class baseline average (57 of 120 marks)', t.match(/Test average[^%]*%/));
  await shot(p, 'monitor-teacher.png');
  await p.click('tr.go:has-text("' + six[2] + '")'); await p.waitForTimeout(700);
  t = await text(p);
  ok(t.includes(six[2]) && /Topics, weakest first/.test(t) && /Baseline test, Grade 11 Start of year 9 \/ 20 45%/.test(t), 'opening a learner shows their topics and test', t.slice(0, 900));
  ok(/Tsandi Secondary School › Grade 11/.test(t) || t.includes('›'), 'a path back to the class');
  await p.goBack(); await p.waitForTimeout(600);
  ok(p.url().includes('#class/'), 'the back button returns to the class');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#csv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok(csv.startsWith('﻿Group,learners') && six.every((x) => csv.includes(x)) && csv.includes('Trigonometry'), 'the CSV has the class, each learner and the topics', csv.split('\n').slice(0, 3));
  await p.selectOption('#wk', '4'); await p.waitForTimeout(700);
  ok((await p.locator('.chart svg rect').count()) === 4 && /Figures cover 4 weeks/.test(await text(p)), 'choosing the last 4 weeks changes every figure');
  await p.selectOption('#wk', '12'); await p.waitForTimeout(500);
  await p.click('#so'); await p.waitForTimeout(500);
  ok(/Sign in to K12Plus Monitor/.test(await text(p)) && (await p.evaluate(() => localStorage.getItem('k12monitor-session'))) === null, 'signing out removes the session from the device');

  console.log('\n3. A learner sees their own progress');
  p = await newPage(390);
  await signIn(p, 'K12-NA-000000', PW.T11_0);
  t = await text(p);
  ok(/My progress/.test(t) && t.includes(names[0]) && /Practice accuracy/.test(t) && /Topics practised 2/.test(t) && !/Learners \d/.test(t), 'signed in with the k12plus ID, the learner sees their own progress', t.slice(0, 500));
  ok(!names.slice(1).some((x) => t.includes(x)), 'and nobody else');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'fits a 390 px phone with no sideways scrolling');
  await shot(p, 'monitor-learner-390.png');
  p = await newPage(390);
  await signIn(p, 'K12-NA-HIDDEN', PW.nocon);
  t = await text(p);
  ok(/Your progress will appear here/.test(t) && /consent/.test(t) && !/Practice accuracy/.test(t), 'a learner without consent is told why there is nothing yet');

  console.log('\n4. A national official: the country down to a class, never a name');
  p = await newPage();
  await signIn(p, 'national@school.na', PW.national);
  t = await text(p);
  ok(/Namibia/.test(t) && /Learners 19/.test(t) && /Rural and urban/.test(t) && noNames(t) && /Dr Shilongo · Ministry of Education, Arts and Culture/.test(t), 'the country view: 19 learners, rural and urban, the official\'s title, no names', t.slice(0, 600));
  ok((await p.locator('tbody tr').count()) === 14 && /Zambezi 0 no learners taking part yet/.test(t), 'all 14 regions, empty ones marked');
  await shot(p, 'monitor-country.png');
  await p.click('tr.go:has-text("Omusati")'); await p.waitForTimeout(700);
  t = await text(p);
  ok(/Omusati Region/.test(t) && /Learners 14/.test(t) && /Tsandi Secondary School rural 9/.test(t) && /Outapi Secondary School urban 5/.test(t) && noNames(t), 'the region view lists its schools', t.slice(0, 900));
  await p.click('tr.go:has-text("Tsandi")'); await p.waitForTimeout(700);
  t = await text(p);
  ok(/Namibia › Omusati › Tsandi Secondary School/.test(t) && /fewer than five learners, so figures are hidden/.test(t) && noNames(t), 'the school view hides the class of three', t.slice(0, 900));
  await p.click('tr.go:has-text("12")'); await p.waitForTimeout(700);
  t = await text(p);
  ok(/Fewer than five learners are taking part here/.test(t) && !/Practice accuracy/.test(t), 'opening the class of three shows nothing but its size');
  await p.goBack(); await p.waitForTimeout(500);
  await p.click('tr.go:has-text("11")'); await p.waitForTimeout(700);
  t = await text(p);
  ok(/Learners 6/.test(t) && noNames(t) && (await p.locator('tr.go').count()) === 0, 'the class of six shows figures and no learner list');
  await p.evaluate((id) => { location.hash = '#learner/' + id; }, U.T11_0); await p.waitForTimeout(700);
  t = await text(p);
  ok(/This could not be opened/.test(t) && /only open learners/.test(t) && noNames(t), 'typing a learner address by hand is refused', t.slice(0, 300));

  console.log('\n5. The administrator gives a regional director access');
  p = await newPage();
  await signIn(p, 'admin@school.na', PW.admin);
  await p.click('.chip:has-text("Officials")'); await p.waitForTimeout(700);
  t = await text(p);
  ok(/People with access Name Title Access Since/.test(t) && /Dr Shilongo Ministry of Education, Arts and Culture National/.test(t), 'the officials page lists the national official', t.slice(0, 700));
  await p.fill('#ai', 'T11_1@school.na'); await p.selectOption('#ar', '10'); await p.click('#af button'); await p.waitForTimeout(600);
  ok(/registered as a learner/.test(await text(p)), 'a learner cannot be given official access');
  await p.fill('#ai', 'director@school.na'); await p.selectOption('#ar', '10'); await p.fill('#at', 'Regional Director of Education'); await p.click('#af button'); await p.waitForTimeout(800);
  ok(/Mr Regional Director Regional Director of Education Omusati/.test(await text(p)), 'the regional director is added for Omusati');
  await shot(p, 'monitor-officials.png');
  p = await newPage();
  await signIn(p, 'director@school.na', PW.director);
  t = await text(p);
  ok(/Omusati Region/.test(t) && /Learners 14/.test(t) && !/Erongo/.test(t) && noNames(t) && !/Namibia ›/.test(t), 'the director sees Omusati only, without names');
  await p.evaluate(() => { location.hash = '#region/1'; }); await p.waitForTimeout(700);
  ok(/This could not be opened/.test(await text(p)), 'and cannot open Erongo');

  console.log('\n6. Words and errors');
  ok(words(fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/, '') + fs.readFileSync(path.join(root, 'index.html'), 'utf8').match(/'[^']*'/g).join(' ')), 'the page says agent and learners, never tutor or student');
  ok(!/text-transform:\s*uppercase/.test(fs.readFileSync(path.join(root, 'index.html'), 'utf8')), 'no small uppercase titles');
  ok(errors.length === 0, 'no errors in the page', errors);

  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
