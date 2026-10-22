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
const TYPES = { p_reason: 'text', p_days: 'int', p_size: 'int', p_status: 'text', p_random: 'boolean', p: 'jsonb', p_region: 'smallint', p_schools: 'jsonb', p_class: 'uuid', p_teacher: 'uuid', p_learner: 'uuid', p_school: 'uuid', p_removal: 'bigint' };

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
  for (const f of ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql']) await db.exec(fs.readFileSync(path.join(__dirname, '../../backend/migrations', f), 'utf8'));
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
          const rows = await asUser(uid, (tx) => tx.query(sql, keys.map((k) => (args[k] === null ? null : typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))));
          return r.fulfill({ json: rows.rows[0].v });
        } catch (e) { return r.fulfill({ status: 400, json: { message: e.message } }); }
      }
      if (url.pathname === '/functions/v1/agent-messenger') {
        const b = JSON.parse(req.postData() || '{}');
        const bad = /\d{3}\s?\d{3}\s?\d{4}/.test(b.text) ? 'contains a phone number' : '';
        return r.fulfill({ json: bad ? { ok: false, reason: bad } : { ok: true, reason: '' } });
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



  const sql = (who, q, p) => asUser(U[who], (tx) => tx.query(q, p));
  const svc = (q, p) => db.transaction(async (tx) => { await tx.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)"); return tx.query(q, p); });
  const setup = (await sql('admin', 'select pilot_setup_region(10::smallint, $1::jsonb) v', [JSON.stringify([{ school_id: S.Tsandi, setting: 'rural' }])])).rows[0].v;
  const C11 = setup.schools[0].classes.find((c) => c.grade === 11);
  await sql('admin', 'select pilot_assign_teacher($1::uuid, $2)', [C11.id, 't1@test.na']);
  for (const k of ['l1', 'l2']) await sql(k, 'select pilot_join_class($1)', [C11.code]);
  await svc('select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'school', school_id: S.Tsandi, given_by_name: 'P', given_by_relation: 'principal', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20' })]);
  await svc('select pilot_save_consent($1::jsonb)', [JSON.stringify({ kind: 'guardian', learner_id: U.l1, given_by_name: 'M', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20' })]);
  // messages: l1 consented (sent in hours, blocked at night), l2 not consented (blocked)
  const now = new Date();
  const at = (h) => { const d = new Date(now); d.setUTCHours(h - 2, 0, 0, 0); return d.toISOString(); }; // Namibian hour h today
  const dayIsWeekend = [0, 6].includes(new Date(now.getTime() + 2 * 3600e3).getUTCDay());
  const okHour = dayIsWeekend ? 10 : 16;
  const send = (k, h, text) => svc('select pilot_log_message($1::jsonb, $2::timestamptz)', [JSON.stringify({ recipient_kind: 'learner', learner_id: U[k], channel: 'in_app', purpose: 'follow_up', body: text, content_ok: true }), at(h)]);
  await send('l1', okHour, 'Hi Ndapewa! Your netball shot follows a parabola. If h = -t² + 4t, when is the ball highest?');
  await send('l1', 23, 'A late question that should never arrive');
  await send('l2', okHour, 'A message for a learner without consent');


  console.log('\nTeacher pauses the agent for a learner');
  const tp = await newPage('t1', 'Educator');
  await tp.click('button:has-text("Pilot")'); await tp.waitForTimeout(1000);
  let t = await text(tp);
  ok((t.match(/Pause agent/g) || []).length === 2, 'each learner has a Pause agent button');
  await tp.locator('button:has-text("Pause agent")').first().click(); await tp.waitForTimeout(300);
  ok((await text(tp)).includes('the agent sends Ndapewa Shikongo no messages at all, including any already prepared'), 'the teacher is told exactly what pausing does');
  await tp.fill('input[placeholder^="Reason (optional)"]', 'Exams next week');
  await tp.locator('input[placeholder^="Reason (optional)"]').locator('xpath=following-sibling::div/button').click(); await tp.waitForTimeout(1200);
  t = await text(tp);
  ok(t.includes('The agent is paused for Ndapewa Shikongo') && /Agent paused by Ms Amutenya on \d+ \w+ \d{4}: Exams next week/.test(t) && t.includes('Resume agent'), 'the class list shows who paused, when and why', t.match(/Agent paused by[^.]*/));
  await shot(tp, 'p5_teacher.png');
  const r1 = (await svc('select pilot_log_message($1::jsonb, $2::timestamptz) v', [JSON.stringify({ recipient_kind: 'learner', learner_id: U.l1, channel: 'in_app', purpose: 'follow_up', body: 'Prepared before the pause', content_ok: true }), at(okHour)])).rows[0].v;
  ok(r1.status === 'blocked' && r1.reason === 'paused', 'a message prepared earlier is blocked while paused', r1);
  await tp.click('button:has-text("Resume agent")'); await tp.waitForTimeout(1200);
  t = await text(tp);
  ok(t.includes('The agent is active again for Ndapewa Shikongo') && !t.includes('Agent paused by'), 'resume works and the pause line disappears');
  const r2 = (await svc('select pilot_log_message($1::jsonb, $2::timestamptz) v', [JSON.stringify({ recipient_kind: 'learner', learner_id: U.l1, channel: 'in_app', purpose: 'follow_up', body: 'After resuming', content_ok: true }), at(okHour)])).rows[0].v;
  ok(r2.status === 'sent', 'messages flow again after resuming', r2);
  const pp = await newPage('t1', 'Educator', 390);
  await pp.click('button.k12burger'); await pp.waitForTimeout(300); await pp.click('aside button:has-text("Pilot")'); await pp.waitForTimeout(1000);
  ok(await pp.evaluate(() => document.documentElement.scrollWidth) <= 390, 'the pause controls fit a phone');
  await shot(pp, 'p5_phone.png');
  ok(errors.length === 0, 'no page errors', errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
