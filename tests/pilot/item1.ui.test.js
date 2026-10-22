// End-to-end test of the pilot screens: the real app.html in headless Chromium,
// with Supabase replaced by the local PGlite database running the real migration.
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
const TYPES = { p_region: 'smallint', p_schools: 'jsonb', p_class: 'uuid', p_teacher: 'uuid', p_learner: 'uuid' };

(async () => {
  // ---------- database ----------
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [o.email || key + '@test.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, school_id, phone, country, learner_uid) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [U[key], o.name || key, role, o.grade || null, o.school || null, o.phone || null, 'Namibia', o.uid || null]);
  };
  const towns = ['Tsandi', 'Outapi', 'Okahao', 'Oshikuku', 'Ruacana', 'Onesi'];
  for (const t of towns) S[t] = (await db.query("insert into schools (name, region, country) values ($1, $2, 'Namibia') returning id", [t + ' Secondary School', 'Omusati (' + t + ')'])).rows[0].id;
  await db.query("insert into schools (name, region, country) values ('Windhoek High School', 'Khomas (Windhoek)', 'Namibia')");
  await db.exec(fs.readFileSync(path.join(__dirname, '../../backend/migrations/20261023_pilot_structure.sql'), 'utf8'));
  await mk('admin', 'learner', { name: 'Pilot Admin' });
  await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('t1', 'educator', { name: 'Ms Amutenya', phone: '0811112222' });
  await mk('t2', 'educator', { name: 'Mr Shilongo' });
  await mk('t3', 'educator', { name: 'Ms Nangolo' });
  await mk('t4', 'educator', { name: 'Mr Iipinge' });
  await mk('champ', 'educator', { name: 'Mr Champion', phone: '0812223333' });
  await mk('l1', 'learner', { name: 'Ndapewa Shikongo', grade: 11, uid: 'K12-NA-AAA111' });
  await mk('l2', 'learner', { name: 'Petrus Haufiku', grade: 11, uid: 'K12-NA-DDD444' });

  const asUser = (uid, fn) => db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await tx.query('set local role authenticated');
    return fn(tx);
  });
  const tokenFor = (key) => 'h.' + Buffer.from(JSON.stringify({ exp: 9999999999, sub: U[key] })).toString('base64').replace(/=/g, '') + '.s';
  const uidFromAuth = (h) => { try { return JSON.parse(Buffer.from((h || '').split('.')[1], 'base64').toString()).sub; } catch (e) { return null; } };

  // ---------- browser ----------
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const newPage = async (who, role, width = 1280) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
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
        const sql = `select ${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}::${TYPES[k] || 'text'}`).join(', ')}) as v`;
        try {
          const rows = await asUser(uid, (tx) => tx.query(sql, keys.map((k) => (args[k] === null ? null : typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))));
          return r.fulfill({ json: rows.rows[0].v });
        } catch (e) { return r.fulfill({ status: 400, json: { message: e.message } }); }
      }
      if (url.pathname === '/functions/v1/pilot-admin') {
        // stand-in for the Edge Function (tested separately): create the account and enrol
        const b = JSON.parse(req.postData() || '{}');
        const cls = (await db.query('select * from classes where id = $1', [b.classId])).rows[0];
        const id = (await db.query("insert into auth.users (email) values ('x@learners') returning id")).rows[0].id;
        const k12 = 'K12-NA-NEW' + String(Math.floor(Math.random() * 900) + 100);
        await db.query("insert into profiles (id, username, role, grade, school_id, phone, country, learner_uid) values ($1,$2,'learner',$3,$4,$5,'Namibia',$6)", [id, b.name, cls.grade, cls.school_id, b.phone, k12]);
        await db.query("insert into enrolments (class_id, learner_id, joined_via, enrolled_by) values ($1,$2,'teacher',$3)", [cls.id, id, uid]);
        return r.fulfill({ json: { ok: true, learnerUid: k12, name: b.name, className: cls.name } });
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

  console.log('\nAdministrator');
  const a = await newPage('admin', 'Admin');
  let t = await text(a);
  ok(t.includes('Pilot: all regions') && t.includes('Omusati') && t.includes('Zambezi'), 'administrator lands on the pilot overview with all regions');
  ok((await a.locator('tbody tr').count()) === 14, '14 region rows');
  await shot(a, 'p_admin_overview.png');
  const uiStart = Date.now();
  await a.locator('tr', { hasText: 'Omusati' }).locator('button').click(); await a.waitForTimeout(800);
  t = await text(a);
  ok(t.includes('Omusati region') && t.includes('Choose the pilot schools') && t.includes('Tsandi Secondary School'), 'set-up panel lists the schools in the region');
  await a.fill('input[placeholder="Search schools in this region"]', 'tsandi'); await a.waitForTimeout(200);
  ok((await a.locator('text=Okahao Secondary School').count()) === 0, 'school search narrows the list');
  await a.locator('div', { hasText: /^Tsandi Secondary School/ }).locator('xpath=..').getByRole('button', { name: 'Rural' }).first().click();
  await a.fill('input[placeholder="Search schools in this region"]', 'outapi'); await a.waitForTimeout(200);
  await a.locator('div', { hasText: /^Outapi Secondary School/ }).locator('xpath=..').getByRole('button', { name: 'Urban' }).first().click();
  await a.fill('input[placeholder="Search schools in this region"]', ''); await a.waitForTimeout(200);
  t = await text(a);
  ok(t.includes('2 chosen: 1 rural, 1 urban'), 'choice summary shows 1 rural, 1 urban');
  await a.click('button:has-text("Set up region")'); await a.waitForTimeout(1200);
  t = await text(a);
  ok(t.includes('Region set up') && (t.match(/Grade 1[12] Mathematics/g) || []).length >= 4, 'region set up: two schools with four classes', t.slice(0, 400));
  ok(!t.includes('Choose the pilot schools'), 'set-up panel closes once both schools are chosen');
  const teacherInputs = a.locator('input[placeholder="Teacher\'s email, mobile number or k12plus ID"]');
  ok((await teacherInputs.count()) === 4, 'one teacher box per class');
  const idents = ['081 111 2222', 't2@test.na', 't3@test.na', 't4@test.na'];
  for (let i = 0; i < 4; i++) {
    await teacherInputs.nth(i).fill(idents[i]);
    await a.locator('button:has-text("Assign teacher")').nth(i).click(); await a.waitForTimeout(700);
  }
  t = await text(a);
  ok(['Ms Amutenya', 'Mr Shilongo', 'Ms Nangolo', 'Mr Iipinge'].every((n) => t.includes(n)) && !t.includes('No teacher yet'), 'all four teachers assigned from the screen');
  await teacherInputs.nth(0).fill('nobody@test.na'); await a.locator('button:has-text("Assign teacher")').nth(0).click(); await a.waitForTimeout(600);
  ok((await text(a)).includes('No account found for nobody@test.na'), 'a wrong teacher shows a clear message');
  await a.fill('input[placeholder="Champion\'s email, mobile number or k12plus ID"]', '0812223333');
  await a.click('button:has-text("Appoint")'); await a.waitForTimeout(700);
  t = await text(a);
  ok(t.includes('Current champion: Mr Champion'), 'champion appointed from the screen');
  const uiSeconds = Math.round((Date.now() - uiStart) / 1000);
  console.log(`  (scripted set-up of the whole region through the screens: ${uiSeconds} s)`);
  await shot(a, 'p_admin_region.png');
  const codes = await a.evaluate(() => Array.from(document.querySelectorAll('span[title="Class code"]')).map((e) => e.textContent.trim()));
  ok(codes.length === 4 && codes.every((c) => /^[A-Z2-9]{6}$/.test(c)), 'class codes visible to the administrator', codes);
  await a.click('button:has-text("All regions")'); await a.waitForTimeout(800);
  t = await text(a);
  ok(/Omusati 2 \(1 rural, 1 urban\) 4 4 0 Mr Champion/.test(t), 'overview row for Omusati updated', t.match(/Omusati[^Z]{0,60}/));

  console.log('\nRegional champion');
  const c = await newPage('champ', 'Educator');
  await c.click('button:has-text("Pilot")'); await c.waitForTimeout(1000);
  t = await text(c);
  ok(t.includes('Omusati region') && t.includes('Tsandi Secondary School') && t.includes('Outapi Secondary School'), 'champion sees the two schools in their region');
  ok(!t.includes('Choose the pilot schools') && !t.includes('Regional champion Current'), 'champion cannot set up regions or appoint champions');
  ok(!t.includes('Windhoek High School'), 'champion sees nothing outside the region');

  console.log('\nTeacher');
  const tp = await newPage('t1', 'Educator');
  await tp.click('button:has-text("Pilot")'); await tp.waitForTimeout(1000);
  t = await text(tp);
  ok(t.includes('My pilot classes') && t.includes('Grade 11 Mathematics') && t.includes('Tsandi Secondary School · Omusati · Rural'), 'teacher sees the class with school, region and setting');
  ok(t.includes(codes[0]) || codes.some((x) => t.includes(x)), 'teacher sees the class code');
  await tp.fill('input[placeholder="Learner\'s k12plus ID or mobile number"]', 'K12-NA-DDD444');
  await tp.click('button:has-text("Add learner")'); await tp.waitForTimeout(800);
  t = await text(tp);
  ok(t.includes('Petrus Haufiku') && t.includes('1 learner'), 'teacher adds a learner by k12plus ID');
  await tp.click('summary'); await tp.waitForTimeout(200);
  await tp.fill('input[placeholder="Full name"]', 'Martha Nghifitikeko');
  await tp.fill('input[placeholder="Mobile number, e.g. 081 234 5678"]', '081 555 6666');
  await tp.click('button:has-text("Create account")'); await tp.waitForTimeout(800);
  t = await text(tp);
  ok(t.includes('Martha Nghifitikeko was added') && t.includes('Their k12plus ID is K12-NA-NEW') && t.includes('2 learners'), 'teacher creates a basic-phone learner account');
  await shot(tp, 'p_teacher.png');

  console.log('\nLearner');
  const lp = await newPage('l1', 'Learner');
  await lp.click('button:has-text("My dashboard")'); await lp.waitForTimeout(800);
  t = await text(lp);
  ok(t.includes('Join your class'), 'learner dashboard shows the join card');
  await lp.fill('input[placeholder="Class code, e.g. K7P2QX"]', 'WRONG1'); await lp.click('button:has-text("Join")'); await lp.waitForTimeout(700);
  ok((await text(lp)).includes('That class code was not found'), 'wrong code shows a clear message');
  const g11 = await db.query("select c.class_code from classes c join schools s on s.id = c.school_id where s.name like 'Tsandi%' and c.grade = 11");
  await lp.fill('input[placeholder="Class code, e.g. K7P2QX"]', g11.rows[0].class_code.toLowerCase()); await lp.click('button:has-text("Join")'); await lp.waitForTimeout(1200);
  t = await text(lp);
  ok(t.includes('Your class: Grade 11 Mathematics at Tsandi Secondary School, Omusati'), 'learner joins and sees their class', t.slice(0, 300));
  ok(!(await lp.locator('button:has-text("Pilot")').count()), 'learners do not get the pilot management page');
  await shot(lp, 'p_learner.png');

  console.log('\nDone when: every learner record shows region, school, setting and class');
  const recs = await asUser(U.admin, (tx) => tx.query('select * from pilot_learner_records()'));
  ok(recs.rows.length === 3 && recs.rows.every((x) => x.region && x.school && x.setting && x.class_name), '3 learners, all with region, school, setting and class', recs.rows);

  console.log('\nPhone width');
  for (const [who, role, btn] of [['t1', 'Educator', 'Pilot'], ['admin', 'Admin', null]]) {
    const pp = await newPage(who, role, 390);
    if (btn) { await pp.click('button.k12burger'); await pp.waitForTimeout(300); await pp.click('aside button:has-text("Pilot")'); await pp.waitForTimeout(1000); }
    const sw = await pp.evaluate(() => document.documentElement.scrollWidth);
    ok(sw <= 390, `${who} pilot page fits a phone screen (no sideways scroll)`, sw);
    await shot(pp, `p_phone_${who}.png`);
  }
  ok(errors.length === 0, 'no page errors', errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
