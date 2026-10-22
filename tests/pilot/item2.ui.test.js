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
const TYPES = { p_region: 'smallint', p_schools: 'jsonb', p_class: 'uuid', p_teacher: 'uuid', p_learner: 'uuid', p_school: 'uuid', p_removal: 'bigint' };

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
  for (const f of ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql']) await db.exec(fs.readFileSync(path.join(__dirname, '../../backend/migrations', f), 'utf8'));
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
  const uploads = [];
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
          const rows = await asUser(uid, (tx) => tx.query(sql, keys.map((k) => (typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))));
          return r.fulfill({ json: rows.rows[0].v });
        } catch (e) { return r.fulfill({ status: 400, json: { message: e.message } }); }
      }
      if (url.pathname === '/functions/v1/pilot-admin') {
        // stand-in for the Edge Function (tested separately): same checks, same database calls
        const b = JSON.parse(req.postData() || '{}');
        if (b.action === 'record_consent') {
          const fn = b.kind === 'school' ? 'pilot_can_manage_school' : 'pilot_can_manage_learner';
          const target = b.kind === 'school' ? b.schoolId : b.learnerId;
          const may = (await asUser(uid, (tx) => tx.query(`select ${fn}($1::uuid) as v`, [target]))).rows[0].v;
          if (!may) return r.fulfill({ status: 403, json: { error: 'Not allowed.' } });
          uploads.push({ kind: b.kind, bytes: Buffer.from(b.file, 'base64').length, jpeg: Buffer.from(b.file, 'base64')[0] === 0xff });
          await db.transaction(async (tx) => {
            await tx.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
            await tx.query('select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: b.kind, school_id: b.kind === 'school' ? target : null, learner_id: b.kind === 'guardian' ? target : null,
              given_by_name: b.givenByName, given_by_relation: b.kind === 'school' ? 'principal' : b.relation, method: 'paper_form', evidence_path: b.kind + '/' + target + '/1.jpg', signed_on: b.signedOn, recorded_by: uid })]);
          });
          return r.fulfill({ json: { ok: true } });
        }
        if (b.action === 'consent_form_url') return r.fulfill({ json: { url: 'about:blank' } });
        return r.fulfill({ status: 400, json: { error: 'unknown' } });
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


  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  // pilot set-up (item 1), done directly in the database
  const sql = (who, q, p) => asUser(U[who], (tx) => tx.query(q, p));
  const setup = (await sql('admin', 'select pilot_setup_region(10::smallint, $1::jsonb) v', [JSON.stringify([{ school_id: S.Tsandi, setting: 'rural' }, { school_id: S.Outapi, setting: 'urban' }])])).rows[0].v;
  const C11 = setup.schools.find((x) => x.name.startsWith('Tsandi')).classes.find((c) => c.grade === 11);
  await sql('admin', 'select pilot_assign_teacher($1::uuid, $2)', [C11.id, 't1@test.na']);
  await sql('admin', 'select pilot_set_champion(10::smallint, $1)', ['champ@test.na']);
  await sql('l1', 'select pilot_join_class($1)', [C11.code]);

  console.log('\nLearner before consent');
  let lp = await newPage('l1', 'Learner');
  await lp.click('button:has-text("My dashboard")'); await lp.waitForTimeout(800);
  let t = await text(lp);
  ok(t.includes('Your class: Grade 11 Mathematics at Tsandi Secondary School') && t.includes('we need signed consent from your parent or guardian and from your school'), 'learner is told consent is needed before taking part');

  console.log('\nChampion records school consent');
  const c = await newPage('champ', 'Educator');
  await c.click('button:has-text("Pilot")'); await c.waitForTimeout(1000);
  t = await text(c);
  ok((t.match(/No school consent yet/g) || []).length === 2, 'both schools show that school consent is missing');
  await c.locator('button:has-text("Record school consent")').first().click(); await c.waitForTimeout(300);
  await c.click('button:has-text("Save school consent")'); await c.waitForTimeout(300);
  ok((await text(c)).includes("Type the principal's name."), 'saving without a name gives a clear message');
  await c.fill('input[placeholder="Name of the principal who signed"]', 'Mr N. Haufiku');
  await c.click('button:has-text("Save school consent")'); await c.waitForTimeout(300);
  ok((await text(c)).includes('Attach a photo of the signed form first.'), 'saving without the letter gives a clear message');
  await c.setInputFiles('input[type=file]', { name: 'letter.png', mimeType: 'image/png', buffer: PNG }); await c.waitForTimeout(800);
  ok((await text(c)).includes('Ready to upload'), 'the photo is prepared for upload');
  await c.click('button:has-text("Save school consent")'); await c.waitForTimeout(1200);
  t = await text(c);
  ok(t.includes('School consent for Tsandi Secondary School recorded.') && t.includes('Signed by Mr N. Haufiku'), 'school consent recorded and shown', t.slice(0, 300));
  ok(uploads[0] && uploads[0].jpeg, 'the photo was converted to a small JPEG before upload', uploads[0]);
  ok(!(await c.locator('button:has-text("View letter")').count()), 'only administrators can open stored letters');

  console.log('\nTeacher records parent consent');
  const tp = await newPage('t1', 'Educator');
  await tp.click('button:has-text("Pilot")'); await tp.waitForTimeout(1000);
  t = await text(tp);
  ok(t.includes('Needs parent consent') && t.includes('School consent received') && t.includes('1 learner · 0 taking part'), 'teacher sees the learner needs parent consent');
  await tp.click('button:has-text("Record consent")'); await tp.waitForTimeout(300);
  await tp.fill('input[placeholder="Name of the parent or guardian who signed"]', 'Hilma Shikongo');
  await tp.setInputFiles('input[type=file]', { name: 'form.png', mimeType: 'image/png', buffer: PNG }); await tp.waitForTimeout(800);
  await tp.click('button:has-text("Save consent")'); await tp.waitForTimeout(400);
  ok((await text(tp)).includes('Choose how they are related to Ndapewa Shikongo.'), 'teacher must say how the signer is related');
  await tp.click('button:has-text("Mother")');
  await tp.click('button:has-text("Save consent")'); await tp.waitForTimeout(1200);
  t = await text(tp);
  ok(t.includes('Consent for Ndapewa Shikongo recorded.') && t.includes('Taking part') && t.includes('Consent from Hilma Shikongo (mother)') && t.includes('1 learner · 1 taking part'), 'learner now takes part, with who gave consent', t.slice(0, 500));
  await shot(tp, 'c_teacher.png');
  let recs = await sql('admin', 'select * from pilot_learner_records()');
  ok(recs.rows.length === 1, 'the learner now appears in the pilot learner records');

  console.log('\nWithdrawal takes effect at once');
  await tp.click('button:has-text("Withdraw consent")'); await tp.waitForTimeout(300);
  await tp.fill('input[placeholder="Reason, for example: parent phoned the school"]', 'Parent phoned the school');
  await tp.click('button:has-text("Confirm withdrawal")'); await tp.waitForTimeout(1200);
  t = await text(tp);
  ok(t.includes('Consent withdrawn') && t.includes('0 taking part'), 'teacher sees the withdrawal straight away');
  recs = await sql('admin', 'select * from pilot_learner_records()');
  ok(recs.rows.length === 0, 'the learner is gone from the pilot learner records');
  lp = await newPage('l1', 'Learner');
  await lp.click('button:has-text("My dashboard")'); await lp.waitForTimeout(800);
  ok((await text(lp)).includes('Consent for the pilot was withdrawn'), 'learner sees that consent was withdrawn');

  console.log('\nAdministrator removes the flagged data');
  const a = await newPage('admin', 'Admin');
  t = await text(a);
  ok(t.includes('Pilot data to remove') && /P[0-9A-F]{12}/.test(t) && !t.includes('Ndapewa'), 'administrator sees the removal by pseudonymous ID, without the name');
  ok(/Omusati 2 \(1 rural, 1 urban\) 4 1 0 \(1 awaiting consent\) Mr Champion/.test(t), 'overview counts 0 learners taking part after the withdrawal', t.match(/Omusati[^Z]{0,80}/));
  await shot(a, 'c_admin.png');
  await a.click('button:has-text("Remove pilot data")'); await a.waitForTimeout(1200);
  t = await text(a);
  ok(t.includes('removed.') && !t.includes('Pilot data to remove'), 'removal done and the list is empty');

  console.log('\nPhone width');
  const pp = await newPage('t1', 'Educator', 390);
  await pp.click('button.k12burger'); await pp.waitForTimeout(300); await pp.click('aside button:has-text("Pilot")'); await pp.waitForTimeout(1000);
  ok(await pp.evaluate(() => document.documentElement.scrollWidth) <= 390, 'teacher consent screen fits a phone');
  await shot(pp, 'c_phone.png');
  ok(errors.length === 0, 'no page errors', errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
