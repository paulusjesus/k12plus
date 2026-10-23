// Item 11: the USSD simulator on the administrator's Pilot page, end to end.
// app.html runs in headless Chromium; its calls to Supabase go to PGlite (the real
// migrations), and its calls to the `ussd` function go to the real function running
// in Deno, which itself uses the same database through a local stand-in.
const { chromium } = require('playwright');
const { PGlite } = require('@electric-sql/pglite');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const MIGS = fs.readdirSync(path.join(ROOT, 'backend/migrations')).filter((f) => f >= '20261023').sort();
const STAND_IN = 9991, FN = 9990, SERVICE = 'service-key-for-tests';
const local = {
  'react@18.3.1/umd/react.production.min.js': 'node_modules/react/umd/react.production.min.js',
  'react-dom@18.3.1/umd/react-dom.production.min.js': 'node_modules/react-dom/umd/react-dom.production.min.js',
};
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const TYPES = { p_session: 'text', p_phone_hash: 'text', p_simulated: 'boolean', p_state: 'jsonb', p_steps: 'int', p_learner: 'uuid', p_ai: 'int', p_phone: 'text', p_code: 'text', p_events: 'jsonb', p: 'jsonb', p_pack: 'text', p_version: 'int', p_checked: 'boolean', p_days: 'int', p_region: 'smallint' };

(async () => {
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
  const rpcAs = async (uid, name, args) => {
    const keys = Object.keys(args || {});
    const sql = `select ${name}(${keys.map((k, i) => `${k} => $${i + 1}::${TYPES[k] || 'text'}`).join(', ')}) as v`;
    return (await as(uid, sql, keys.map((k) => (args[k] === null ? null : typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))))[0].v;
  };
  const sch = (await db.query("insert into schools (name, region, country, region_id) values ('Tsandi Secondary School', 'x', 'Namibia', 10) returning id")).rows[0].id;
  await mk('admin', 'learner', { name: 'Pilot Admin' }); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  await mk('nde', 'learner', { name: 'Ndapewa Shikongo', grade: 11, phone: '081 234 5678' });
  const setup = await rpcAs(U.admin, 'pilot_setup_region', { p_region: 10, p_schools: [{ school_id: sch, setting: 'rural' }] }).catch(async () => (await as(U.admin, 'select pilot_setup_region(10::smallint, $1::jsonb) v', [JSON.stringify([{ school_id: sch, setting: 'rural' }])]))[0].v);
  const C11 = setup.schools[0].classes.find((c) => c.grade === 11);
  await as(U.nde, 'select pilot_join_class($1)', [C11.code]);
  for (const b of [{ kind: 'school', school_id: sch, given_by_relation: 'principal' }, { kind: 'guardian', learner_id: U.nde, given_by_relation: 'mother' }]) {
    await as(null, 'select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', method: 'paper_form', evidence_path: 'x', signed_on: '2026-10-20', ...b })]);
  }
  await as(U.admin, "select pilot_check_lesson('g11-equations', 1, true)");
  const tokenFor = (key) => 'h.' + Buffer.from(JSON.stringify({ exp: 9999999999, sub: U[key] })).toString('base64').replace(/=/g, '') + '.s';
  const uidFromAuth = (h) => { try { return JSON.parse(Buffer.from((h || '').split('.')[1], 'base64').toString()).sub || null; } catch (e) { return null; } };

  // stand-in for Supabase (as seen by the function), the website and the Claude API
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, 'http://x');
    const json = (st, v) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(v === undefined ? '' : JSON.stringify(v)); };
    if (url.pathname.startsWith('/lessons/')) { const f = path.join(ROOT, url.pathname); if (!fs.existsSync(f)) return json(404, {}); res.writeHead(200); return res.end(fs.readFileSync(f)); }
    if (url.pathname === '/v1/messages') return json(200, { content: [{ type: 'text', text: 'Take 4 from both sides first, then divide by 2. So x = 5.' }], usage: { input_tokens: 50, output_tokens: 20 } });
    if (url.pathname === '/rest/v1/agent_logs') return json(201);
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (!m) return json(404, {});
    const auth = req.headers['authorization'] || '';
    const uid = auth === 'Bearer ' + SERVICE ? null : uidFromAuth(auth);
    if (auth !== 'Bearer ' + SERVICE && !uid) return json(401, {});
    try { return json(200, await rpcAs(uid, m[1], body ? JSON.parse(body) : {})); } catch (e) { return json(400, { message: e.message }); }
  });
  await new Promise((r) => server.listen(STAND_IN, '127.0.0.1', r));
  const fn = global.fn = spawn('deno', ['run', '-A', path.join(ROOT, 'supabase/functions/ussd/index.ts')], {
    env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${STAND_IN}`, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: 'anon', ANTHROPIC_API_KEY: 'test',
           ANTHROPIC_URL: `http://127.0.0.1:${STAND_IN}/v1/messages`, SITE_URL: `http://127.0.0.1:${STAND_IN}`, USSD_TEST_PORT: String(FN) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${FN}/`, { method: 'OPTIONS' }); break; } catch (e) { await new Promise((r) => setTimeout(r, 500)); } }

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (who, width = 1280) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await ctx.route('https://unpkg.com/**', (r) => { const k = Object.keys(local).find((x) => r.request().url().includes(x)); return k ? r.fulfill({ path: path.join(process.env.VENDOR_DIR || __dirname, local[k]), contentType: 'application/javascript' }) : r.abort(); });
    await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
    await ctx.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await ctx.route('https://uwqbjjzjdnjlbicxrwnp.supabase.co/**', async (r) => {
      const req = r.request(); const url = new URL(req.url());
      if (url.pathname === '/functions/v1/ussd') {
        const fr = await fetch(`http://127.0.0.1:${FN}/`, { method: req.method(), headers: { 'content-type': 'application/json', authorization: req.headers()['authorization'] || '', origin: 'https://k12plus.app' }, body: req.method() === 'POST' ? req.postData() : undefined });
        return r.fulfill({ status: fr.status, body: await fr.text(), contentType: 'text/plain' });
      }
      const m = url.pathname.match(/^\/rest\/v1\/rpc\/(pilot_[a-z_]+)$/);
      if (m) {
        const uid = uidFromAuth(req.headers()['authorization']);
        try { return r.fulfill({ json: await rpcAs(uid, m[1], JSON.parse(req.postData() || '{}')) }); } catch (e) { return r.fulfill({ status: 400, json: { message: e.message } }); }
      }
      return r.fulfill({ json: [] });
    });
    await page.goto('http://127.0.0.1:8765/app.html');
    await page.evaluate(([tok, uid]) => {
      localStorage.setItem('k12plus-session', JSON.stringify({ access_token: tok, refresh_token: 'r', user_id: uid }));
      localStorage.setItem('k12plus-loggedin', '1'); localStorage.setItem('k12plus-role', 'Learner'); localStorage.setItem('k12plus-tour-done', '1');
    }, [tokenFor(who), U[who]]);
    await page.reload(); await page.waitForTimeout(3000);
    return page;
  };
  const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const screenText = (page) => page.locator('div', { hasText: /K12Plus|AI Math Agent|Type your|Take 4/ }).filter({ has: page.locator(':scope > *') }).last();

  console.log('\nThe administrator tries *141*12# from the Pilot page');
  const ap = await open('admin');
  await ap.click('button:has-text("Pilot")'); await ap.waitForTimeout(2000);
  let t = await text(ap);
  ok(/USSD simulator/.test(t) && /Nothing is recorded for the learner/.test(t), 'the Pilot page has a USSD simulator', t.slice(0, 200));
  ok(/Last 30 days: 0 sessions from 0 phones/.test(t), 'with usage figures (no numbers or names)');
  const card = ap.locator('div', { has: ap.locator('h2:text-is("USSD simulator")') }).last();
  await card.locator('input[placeholder="081 234 5678"]').fill('081 234 5678');
  await card.getByRole('button', { name: '*141*12#', exact: true }).click(); await ap.waitForTimeout(1500);
  t = await card.innerText();
  ok(/Hi Ndapewa! K12Plus/.test(t) && /1 Mathematics/.test(t) && /\*141\*12#/.test(t), 'dialling shows exactly what Ndapewa sees', t);
  const reply = async (v) => { await card.locator('input[placeholder="Reply"]').fill(v); await card.locator('button:text-is("Send")').click(); await ap.waitForTimeout(1500); return card.innerText(); };
  t = await reply('1');
  ok(/AI Math Agent/.test(t) && /1 Practice question/.test(t), '1 opens the AI Math Agent', t);
  t = await reply('3');
  ok(/Type your question for the AI Math Agent/.test(t), '3 asks for a question');
  t = await reply('How do I solve 2x + 4 = 14');
  ok(/Take 4 from both sides first/.test(t) && /characters/.test(t), 'the agent answers, and the screen length is shown', t);
  await ap.screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, 'item11-simulator.png'), fullPage: false });
  await card.getByRole('button', { name: '*141*12*1#', exact: true }).click(); await ap.waitForTimeout(1500);
  t = await card.innerText();
  ok(/AI Math Agent/.test(t) && /\*141\*12\*1#/.test(t), 'the Mathematics code goes straight to the AI Math Agent');
  t = await reply('1');
  ok(/Q1\. /.test(t), 'a practice question from the checked lesson', t);
  await card.locator('button:text-is("End")').click(); await ap.waitForTimeout(300);
  ok(/Session ended/.test(await card.innerText()), 'End closes the session');
  const n = (await db.query('select count(*)::int n from learning_events')).rows[0].n + (await db.query('select count(*)::int n from agent_exchanges')).rows[0].n;
  ok(n === 0, 'nothing was recorded for the learner');
  ok((await db.query('select count(*)::int n from ussd_sessions where simulated')).rows[0].n === 2, 'the two sessions are marked as simulated');

  console.log('\nOnly administrators');
  const lp = await open('nde');
  ok(!/USSD simulator/.test(await text(lp)), 'learners do not see the simulator');
  const r = await fetch(`http://127.0.0.1:${FN}/`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokenFor('nde') }, body: JSON.stringify({ simulate: true, sessionId: 'x', phoneNumber: '0812345678', text: '' }) });
  ok(r.status === 403, 'and the function refuses them');

  console.log('\nPhone width');
  const mp = await open('admin', 390);
  await mp.click('button.k12burger'); await mp.waitForTimeout(300);
  await mp.click('aside button:has-text("Pilot")'); await mp.waitForTimeout(2000);
  ok(/USSD simulator/.test(await text(mp)) && await mp.evaluate(() => document.documentElement.scrollWidth) <= 390, 'the simulator fits a phone screen');

  ok(errors.length === 0, 'no page errors', errors);
  await browser.close(); fn.kill(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); if (global.fn) global.fn.kill(); process.exit(1); });
