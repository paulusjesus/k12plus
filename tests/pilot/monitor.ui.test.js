// K12Plus Monitor end to end: the real monitor/ pages in headless Chromium, the real
// account-admin Edge Function running in Deno, and a stand-in for Supabase (REST, Auth
// and Storage) backed by PGlite with every migration loaded.
//
// Covers: charts for every period (daily to yearly), registrations per region, school
// and class, drill-down from the country to a class without names, groups under five
// hidden, the learner's own page, the Accounts section (add a learner with a temporary
// password, the forced password change, reset, switch off and on, edit, rights, history,
// school logo), what a regional manager may and may not do, the same password change in
// the K12Plus app (k12plus-bridge.js), a 390 px phone, and the house writing rules.
//
// Run: NODE_PATH=<node_modules with @electric-sql/pglite and playwright> DENO=<path to deno> node monitor.ui.test.js
const { chromium } = require('playwright');
const { PGlite } = require('@electric-sql/pglite');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const MIGS = ['20261023_pilot_structure.sql', '20261024_pilot_consent.sql', '20261025_pilot_messaging.sql', '20261026_pilot_pause.sql',
  '20261027_pilot_learning_and_summaries.sql', '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql',
  '20261031_pilot_evaluator_export.sql', '20261101_pilot_offline_lessons.sql', '20261102_pilot_ussd.sql', '20261103_plan_allowance.sql',
  '20261105_monitoring.sql', '20261106_monitor_accounts.sql'];
const TYPES = { p_learner: 'uuid', p_class: 'uuid', p_school: 'uuid', p_region: 'smallint', p_grain: 'text', p_identifier: 'text', p_title: 'text', p_user: 'uuid',
  p_scope: 'text', p_id: 'text', p_search: 'text', p_role: 'text', p_page: 'int', p: 'jsonb', p_right: 'bigint', p_can_grant: 'boolean', p_action: 'text', p_target: 'uuid',
  p_audit: 'bigint', p_ok: 'boolean', p_result: 'jsonb' };
const SVC = 'service-key', ANON = 'anon-key', FAKE = 9990, SITE = 8766, APP = 8767;
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 600)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------- the database ----------
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  await db.exec("alter table auth.users add column banned_until timestamptz, add column last_sign_in_at timestamptz, add column raw_app_meta_data jsonb default '{}'::jsonb, add column pw text");
  await db.exec('create unique index on auth.users (lower(email))');
  for (const f of MIGS) await db.exec(fs.readFileSync(path.join(ROOT, 'backend/migrations', f), 'utf8'));
  const U = {}, S = {}, PW = {};
  const mk = async (key, role, o = {}) => {
    PW[key] = 'Pass-' + key + '1';
    U[key] = (await db.query('insert into auth.users (email, pw) values ($1, $2) returning id', [key.toLowerCase() + '@school.na', PW[key]])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, class_letter, country, learner_uid, school_id, phone, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [U[key], o.name || key, role, o.grade || null, o.letter || null, 'Namibia', o.uid || null, o.school || null, o.phone || null, o.at || new Date()]);
  };
  const asUser = (claims, fn) => db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await tx.query(`set local role ${claims.role}`);
    return fn(tx);
  });
  const sql = (who, q, p) => asUser({ sub: U[who], role: 'authenticated' }, (tx) => tx.query(q, p));
  const consent = (b) => asUser({ role: 'service_role' }, (tx) => tx.query('select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-09-01', ...b })]));

  await mk('admin', 'learner', { name: 'Pilot Admin' }); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  for (const [k, name, reg] of [['T', 'Tsandi Secondary School', 10], ['O', 'Outapi Secondary School', 10], ['K', 'Karibib Secondary School', 1], ['W', 'Swakopmund Secondary School', 1]])
    S[k] = (await db.query("insert into schools (name, region, country, region_id) values ($1, 'x', 'Namibia', $2) returning id", [name, reg])).rows[0].id;
  const cls = {};
  for (const [reg, a, b] of [[10, 'T', 'O'], [1, 'K', 'W']]) {
    const set = (await sql('admin', 'select pilot_setup_region($1::smallint, $2::jsonb) v', [reg, JSON.stringify([{ school_id: S[a], setting: 'rural' }, { school_id: S[b], setting: 'urban' }])])).rows[0].v;
    for (const sc of set.schools) for (const c of sc.classes) cls[sc.id + c.grade] = c;
  }
  await mk('national', 'educator', { name: 'Dr Shilongo' });
  await mk('director', 'educator', { name: 'Mr Regional Director' });
  await mk('principal', 'educator', { name: 'Mrs Nangolo', school: S.T }); await db.query("update profiles set role = 'principal' where id = $1", [U.principal]);
  await mk('deputy', 'educator', { name: 'Mr Deputy', school: S.T });
  await mk('teacher', 'educator', { name: 'Ms Amutenya', school: S.T });
  await sql('admin', 'select pilot_assign_teacher($1::uuid, $2)', [cls[S.T + 11].id, 'teacher@school.na']);
  await sql('admin', "select account_grant('national@school.na', 'country', null, true)");
  await sql('admin', "select monitor_add_official('national@school.na', null, 'Ministry of Education')");
  await sql('national', "select account_grant('director@school.na', 'region', '10', false)");
  for (const k of ['T', 'O', 'K', 'W']) await consent({ kind: 'school', school_id: S[k], given_by_relation: 'principal' });

  // learners: spread over the last two years so every period has something to draw
  const SURN = ['Shikongo', 'Haufiku', 'Nangolo', 'Iipinge', 'Gowases', 'Amukoto', 'Nghifikwa', 'Kaulinge', 'Mbango', 'Uushona', 'Hamutenya', 'Shipanga', 'Nakale', 'Kamati', 'Tjiriange', 'Muyamba', 'Situde', 'Beukes', 'Kandjii', 'Mwala', 'Hango', 'Iyambo', 'Ndjoze', 'Kahuure', 'Simasiku'];
  const FIRST = ['Ndapewa', 'Tomas', 'Selma', 'Petrus', 'Maria', 'Johannes', 'Hilma', 'Josef', 'Frieda', 'Elia'];
  const names = [];
  const plan = [['T', 11, 'A', 6, true], ['T', 12, 'A', 3, true], ['T', 11, 'B', 4, false], ['O', 11, 'C', 5, true], ['K', 12, 'B', 5, false]];
  let n = 0, ref = 0;
  const ago = (days) => new Date(Date.now() - days * 86400e3);
  for (const [sch, g, letter, count, pilot] of plan) for (let i = 0; i < count; i++, n++) {
    const key = 'L' + n, name = FIRST[n % 10] + ' ' + SURN[n];
    names.push(name);
    await mk(key, 'learner', { name, grade: g, letter, school: S[sch], uid: 'K12-NA-' + String(n).padStart(6, '0'), at: ago(3 + n * 29) });
    if (!pilot) continue;
    await sql(key, 'select pilot_join_class($1)', [cls[S[sch] + g].code]);
    await consent({ kind: 'guardian', learner_id: U[key] });
    for (const w of [0, 1, 3, 6]) {
      const at = ago(w * 7 + 1).toISOString();
      const ev = (kind, o = {}) => db.query('insert into learning_events (learner_id, class_id, kind, subject, topic, correct, attempted, duration_seconds, client_ref, occurred_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [U[key], cls[S[sch] + g].id, kind, 'Mathematics', o.topic || null, o.correct ?? null, o.attempted ?? null, o.duration ?? null, 'u-' + String(++ref).padStart(6, '0'), at]);
      await ev('practice', { topic: 'Algebra', correct: 5 + ((i + w) % 4), attempted: 10 });
      await ev('quiz', { topic: 'Trigonometry', correct: 2 + (i % 3), attempted: 10 });
      await ev('active', { duration: 900 }); await ev('question');
    }
  }
  const learnerCount = n;

  // ---------- the stand-in for Supabase ----------
  const tokenFor = (id) => 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: id })).toString('base64url') + '.s';
  const fromToken = (h) => { const t = String(h || '').replace(/^Bearer\s+/i, ''); if (t === SVC) return 'service'; if (t === ANON) return 'anon'; try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sub; } catch (e) { return null; } };
  const userJson = async (id) => { const r = (await db.query('select id, email, raw_app_meta_data from auth.users where id = $1', [id])).rows[0]; return r && { id: r.id, email: r.email, app_metadata: r.raw_app_meta_data || {} }; };
  const session = async (u) => {
    if (u.banned_until && new Date(u.banned_until) > new Date()) return [400, { error: 'user_banned', error_description: 'User is banned' }];
    await db.query('update auth.users set last_sign_in_at = now() where id = $1', [u.id]);
    return [200, { access_token: tokenFor(u.id), refresh_token: 'r-' + u.id, user: await userJson(u.id) }];
  };
  const logos = {};
  const fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks), body = (() => { try { return JSON.parse(raw.toString() || '{}'); } catch (e) { return {}; } })();
    const send = (status, obj, type) => {
      res.writeHead(status, { 'Content-Type': type || 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
      res.end(Buffer.isBuffer(obj) ? obj : obj == null ? '' : JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') return send(204, null);
    const who = fromToken(req.headers.authorization);
    try {
      let m;
      if ((m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/))) {
        const keys = Object.keys(body);
        const q = `select ${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}::${TYPES[k] || 'text'}`).join(', ')}) as v`;
        const claims = who === 'service' ? { role: 'service_role' } : who === 'anon' || !who ? { role: 'anon' } : { sub: who, role: 'authenticated' };
        try {
          const rows = await asUser(claims, (tx) => tx.query(q, keys.map((k) => (body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]))));
          return send(200, rows.rows[0].v);
        } catch (e) { return send(/permission denied/.test(e.message) ? 401 : 400, { message: e.message }); }
      }
      if (url.pathname === '/rest/v1/regions') return send(200, (await db.query('select id, name from regions order by name')).rows);
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
        const u = (await db.query('select * from auth.users where lower(email) = lower($1)', [body.email || ''])).rows[0];
        if (!u || u.pw !== body.password) return send(400, { error_description: 'Invalid login credentials' });
        return send(...(await session(u)));
      }
      if (url.pathname === '/auth/v1/token') return send(400, { error: 'invalid_grant' });
      if (url.pathname === '/functions/v1/auth-login') {
        const u = (await db.query('select u.* from auth.users u join profiles p on p.id = u.id where p.learner_uid = upper($1) or p.phone_e164 = $2', [body.identifier || '', String(body.identifier || '').replace(/\D/g, '').replace(/^0/, '264')])).rows[0];
        if (!u || u.pw !== body.password) return send(400, { error: 'Those details do not match a k12plus account. Check your number or ID and password.' });
        const [st, out] = await session(u);
        return send(st, st === 200 ? out : { error: out.error_description });
      }
      if (url.pathname === '/auth/v1/user') { const u = who && who !== 'anon' && who !== 'service' ? await userJson(who) : null; return u ? send(200, u) : send(401, { msg: 'no' }); }
      if (url.pathname === '/auth/v1/logout') return send(204, null);
      if (url.pathname === '/auth/v1/admin/users' && req.method === 'POST') {
        if (who !== 'service') return send(403, { msg: 'service only' });
        try {
          const r = await db.query('insert into auth.users (email, pw, raw_app_meta_data) values ($1, $2, $3) returning id', [body.email, body.password, JSON.stringify(body.app_metadata || {})]);
          return send(200, await userJson(r.rows[0].id));
        } catch (e) { return send(422, { msg: 'A user with this email address has already been registered' }); }
      }
      if ((m = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/))) {
        if (who !== 'service') return send(403, { msg: 'service only' });
        if (req.method === 'DELETE') { await db.query('delete from auth.users where id = $1', [m[1]]); return send(200, {}); }
        if (body.password) await db.query('update auth.users set pw = $2 where id = $1', [m[1], body.password]);
        if (body.app_metadata) await db.query('update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, \'{}\') || $2::jsonb where id = $1', [m[1], JSON.stringify(body.app_metadata)]);
        if (body.ban_duration) await db.query("update auth.users set banned_until = case when $2 = 'none' then null else now() + interval '100 years' end where id = $1", [m[1], body.ban_duration]);
        return send(200, await userJson(m[1]));
      }
      if ((m = url.pathname.match(/^\/storage\/v1\/object\/school-logos\/(.+)$/)) && req.method === 'POST') {
        if (who !== 'service') return send(403, { msg: 'service only' });
        logos[m[1]] = { type: req.headers['content-type'], data: raw }; return send(200, { Key: 'school-logos/' + m[1] });
      }
      if ((m = url.pathname.match(/^\/storage\/v1\/object\/public\/school-logos\/(.+)$/))) {
        const f = logos[m[1]]; return f ? send(200, f.data, f.type) : send(404, { msg: 'not found' });
      }
      if (url.pathname === '/functions/v1/account-admin') {
        const r = await fetch('http://127.0.0.1:8000/', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: req.headers.authorization || '', origin: 'https://monitor.k12plus.app' }, body: raw });
        return send(r.status, Buffer.from(await r.arrayBuffer()));
      }
      return send(404, { message: 'not in the stand-in: ' + url.pathname });
    } catch (e) { console.error(e); return send(500, { message: e.message }); }
  }).listen(FAKE);

  const deno = spawn(process.env.DENO || 'deno', ['run', '--allow-net', '--allow-env', path.join(ROOT, 'supabase/functions/account-admin/index.ts')], {
    env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:' + FAKE, SUPABASE_SERVICE_ROLE_KEY: SVC, SUPABASE_ANON_KEY: ANON }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let denoLog = ''; deno.stdout.on('data', (d) => { denoLog += d; }); deno.stderr.on('data', (d) => { denoLog += d; });
  for (let i = 0; i < 60 && !/Listening/.test(denoLog); i++) await sleep(250);
  ok(/Listening/.test(denoLog), 'the account-admin function starts in Deno', denoLog.slice(0, 300));

  const serve = (dir, port) => http.createServer((req, res) => {
    const f = path.join(dir, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'application/javascript' : f.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); fs.createReadStream(f).pipe(res);
  }).listen(port);
  const site = serve(path.join(ROOT, 'monitor'), SITE);
  const appSite = serve(ROOT, APP);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const newPage = async (width = 1280, start = 'http://127.0.0.1:' + SITE + '/') => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
    await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await page.route('https://uwqbjjzjdnjlbicxrwnp.supabase.co/**', async (r) => {
      const req = r.request(), u = new URL(req.url());
      const headers = { ...req.headers() };
      if (headers.authorization && /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/.test(headers.authorization)) headers.authorization = 'Bearer ' + ANON; // the page's public key
      const resp = await fetch('http://127.0.0.1:' + FAKE + u.pathname + u.search, { method: req.method(), headers, body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() });
      return r.fulfill({ status: resp.status, headers: { 'content-type': resp.headers.get('content-type') || 'application/json', 'access-control-allow-origin': '*' }, body: Buffer.from(await resp.arrayBuffer()) });
    });
    await page.goto(start);
    return page;
  };
  const text = async (p) => (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  const shot = (p, f) => p.screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, f), fullPage: true });
  const signIn = async (p, ident, pw) => { await p.fill('#u', ident); await p.fill('#p', pw); await p.click('form#f button[type=submit]'); await p.waitForTimeout(1200); };
  const noNames = (t) => !names.some((x) => t.includes(x));
  const go = async (p, hash) => { await p.evaluate((h) => { location.hash = h; }, hash); await p.waitForTimeout(900); };

  console.log('\n1. The principal: registrations and learning for the school, in every period');
  let p = await newPage();
  await signIn(p, 'principal@school.na', PW.principal);
  let t = await text(p);
  ok(p.url().includes('#school/' + S.T) && /Tsandi Secondary School/.test(t), 'the principal lands on the school', p.url());
  ok(/Registrations/.test(t) && /Registered accounts 1[0-9]/.test(t) && /Learners 13/.test(t), 'registration tiles: 13 learners at Tsandi', t.slice(0, 600));
  ok(await p.locator('#c-reg-total svg path.kc-line').count() === 1 && await p.locator('#c-reg-new svg .kc-hit').count() === 12, 'a line of accounts over time and twelve weekly columns of new accounts');
  ok(await p.locator('#c-reg-roles .kc-part').count() >= 2 && /Learners 13/.test(await p.locator('#c-reg-roles').innerText().then((x) => x.replace(/\s+/g, ' '))), 'who has registered, as parts of a whole with a legend');
  ok(/Grade 11 A 6 Grade 11 B 4 Grade 12 A 3/.test((await p.locator('#c-reg-children').innerText()).replace(/\s+/g, ' ')), 'learners registered per class', await p.locator('#c-reg-children').innerText());
  ok(await p.locator('#c-active svg .kc-hit').count() === 12 && await p.locator('#c-acc svg path.kc-line').count() === 1 && await p.locator('#c-meter .kc-meter').count() === 1, 'learning: active learners, accuracy line and the taking-part meter');
  await p.hover('#c-reg-new svg .kc-hit >> nth=11');
  ok(/New accounts: \d+/.test(await p.locator('.kc-tip').innerText()), 'hovering a column shows its figure', await p.locator('.kc-tip').innerText());
  await shot(p, 'monitor2-school-weekly.png');
  for (const [g, label, points] of [['day', 'Daily', 30], ['month', 'Monthly', 12], ['quarter', 'Quarterly', 8], ['year', 'Yearly', 5]]) {
    await p.click(`[data-grain=${g}]`); await p.waitForTimeout(900);
    const c = await p.locator('#c-reg-new svg .kc-hit').count();
    ok(c === points && (await p.locator(`[data-grain=${g}].on`).count()) === 1, `${label}: ${points} periods`, c);
  }
  await shot(p, 'monitor2-school-yearly.png');
  await p.click('[data-grain=week]'); await p.waitForTimeout(800);

  console.log('\n2. The national official: Namibia down to a class, never a name');
  let pn = await newPage();
  await signIn(pn, 'national@school.na', PW.national);
  t = await text(pn);
  ok(/Namibia/.test(t) && /Registered per region/.test(t) && noNames(t) && /Accounts/.test(t), 'the country view with registrations per region and an Accounts tab', t.slice(0, 500));
  const omRow = (await pn.locator('#c-reg-children .kc-bar').first().innerText()).replace(/\s+/g, ' ');
  ok(/^Omusati/.test(omRow), 'regions are sorted by accounts registered, Omusati first', omRow);
  await shot(pn, 'monitor2-country.png');
  await pn.click('#c-reg-children a.kc-bar:has-text("Omusati")'); await pn.waitForTimeout(900);
  t = await text(pn);
  ok(/Omusati Region/.test(t) && /Registered per school/.test(t) && noNames(t), 'clicking the region bar opens the region');
  await pn.click('#c-reg-children a.kc-bar:has-text("Tsandi")'); await pn.waitForTimeout(900);
  t = await text(pn);
  ok(/Namibia › Omusati › Tsandi Secondary School/.test(t) && /Grade 11 B fewer than five/.test((await pn.locator('#c-reg-children').innerText()).replace(/\s+/g, ' ')) && noNames(t), 'the school shows class counts, with classes under five hidden');
  const [dl] = await Promise.all([pn.waitForEvent('download'), pn.click('#csv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok(/Registrations,total,learners/.test(csv) && /Grade,class,learners registered/.test(csv) && noNames(csv), 'the CSV has registrations, per class and over time, with no names', csv.split('\n').slice(0, 6));

  console.log('\n3. Accounts: the principal adds a learner with a temporary password');
  await p.click('.chip:has-text("Accounts")'); await p.waitForTimeout(1000);
  t = await text(p);
  ok(/Accounts · Tsandi Secondary School/.test(t) && t.includes(names[0]) && /Ms Amutenya/.test(t) && !/Mrs Nangolo Principal/.test(t), 'the school accounts list learners and staff, not the principal herself', t.slice(0, 500));
  await p.click('#add'); await p.waitForTimeout(500);
  await p.fill('#an', 'Nangula Hamukoto');
  await p.selectOption('#ac', { label: 'Grade 11 Mathematics' });
  await p.selectOption('#ag', '11'); await p.selectOption('#al', 'A');
  const temp = await p.inputValue('#at');
  ok(/^[A-Za-z]+\d{4}$/.test(temp), 'a readable temporary password is suggested', temp);
  await p.click('dialog button[type=submit]'); await p.waitForTimeout(1500);
  t = await text(p);
  const newId = (t.match(/K12-NA-[A-Z0-9]{6}/) || [])[0];
  ok(/Account added/.test(t) && newId && t.includes(temp), 'the account is added and its k12plus ID shown with the temporary password', t.slice(t.indexOf('Account added'), t.indexOf('Account added') + 300));
  await p.click('dialog [data-close]'); await p.waitForTimeout(500);
  const joined = (await db.query("select e.status from profiles p join enrolments e on e.learner_id = p.id where p.learner_uid = $1", [newId])).rows[0];
  ok(joined && joined.status === 'active', 'the new learner is in the Grade 11 class');

  console.log('\n4. The new learner must choose their own password');
  let pl = await newPage(390);
  await signIn(pl, newId, temp);
  ok(/Choose your own password/.test(await text(pl)), 'signing in with the temporary password asks for a new one');
  await pl.fill('#np1', 'MyOwnPass77'); await pl.fill('#np2', 'MyOwnPass7'); await pl.click('dialog button[type=submit]'); await pl.waitForTimeout(400);
  ok(/not the same/.test(await text(pl)), 'the two must match');
  await pl.fill('#np2', 'MyOwnPass77'); await pl.click('dialog button[type=submit]'); await pl.waitForTimeout(1500);
  t = await text(pl);
  ok(/Your progress will appear here|My progress/.test(t) && !/Choose your own password/.test(t), 'after saving, the learner is in', t.slice(0, 300));
  const meta = (await db.query("select u.pw, u.raw_app_meta_data m from auth.users u join profiles p on p.id = u.id where p.learner_uid = $1", [newId])).rows[0];
  ok(meta.pw === 'MyOwnPass77' && meta.m.must_change_password === false, 'the new password is saved and the temporary one is gone');
  pl = await newPage(390); await signIn(pl, newId, temp);
  ok(/do not match/.test(await text(pl)), 'the temporary password no longer works');

  console.log('\n5. Reset, switch off and on, edit, history');
  await go(p, '#accounts/school/' + S.T);
  await p.fill('#q', 'Selma Nangolo'); await p.waitForTimeout(1300);
  ok((await p.locator('table.users tbody tr').count()) === 1, 'search finds one learner');
  await p.click('[data-act=reset]'); await p.waitForTimeout(400);
  await p.fill('#tp', 'Mopane2468Kudu'); await p.click('dialog button[type=submit]'); await p.waitForTimeout(1200);
  ok(/Temporary password set/.test(await text(p)), 'the principal sets a temporary password');
  await p.click('dialog [data-close]');
  pl = await newPage(390); await signIn(pl, 'K12-NA-000002', 'Mopane2468Kudu');
  ok(/Choose your own password/.test(await text(pl)), 'the learner signs in with it and is asked to choose their own');
  await p.fill('#q', 'Amutenya'); await p.waitForTimeout(1300);
  await p.click('[data-act=disable]'); await p.waitForTimeout(300); await p.click('dialog button[type=submit]'); await p.waitForTimeout(1200);
  ok(/switched off/.test(await text(p)), 'the teacher\'s account is switched off');
  let pt = await newPage(); await signIn(pt, 'teacher@school.na', PW.teacher);
  ok(/has been switched off/.test(await text(pt)), 'and the teacher cannot sign in', await text(pt));
  await p.click('[data-act=enable]'); await p.waitForTimeout(300); await p.click('dialog button[type=submit]'); await p.waitForTimeout(1200);
  pt = await newPage(); await signIn(pt, 'teacher@school.na', PW.teacher);
  ok(/Grade 11 Mathematics/.test(await text(pt)), 'switched on again, the teacher signs in and sees the class');
  await p.fill('#q', names[4]); await p.waitForTimeout(1300);
  await p.click('[data-act=edit]'); await p.waitForTimeout(300);
  await p.selectOption('#el', 'D'); await p.click('dialog button[type=submit]'); await p.waitForTimeout(1200);
  ok(/Grade 11D/.test(await text(p)), 'the class letter is corrected', (await text(p)).slice(0, 400));
  t = await text(p);
  ok(/Mrs Nangolo added Nangula Hamukoto/.test(t) && /gave a temporary password to Selma/.test(t) && /switched off Ms Amutenya/.test(t) && /edited .* \(class letter\)/.test(t), 'the history records each change with who made it', t.slice(t.indexOf('History'), t.indexOf('History') + 600));

  console.log('\n6. Rights and the school logo');
  await p.fill('#q', ''); await p.waitForTimeout(1200);
  await p.click('#give'); await p.waitForTimeout(400);
  ok(await p.locator('#gg').isDisabled(), 'a principal cannot let others give school rights (the box is off)');
  await p.fill('#gi', 'deputy@school.na'); await p.click('dialog button[type=submit]'); await p.waitForTimeout(1500);
  ok(/Mr Deputy School: Tsandi Secondary School · given/.test(await text(p)), 'the deputy now holds school rights', (await text(p)).slice(0, 200));
  const pd = await newPage(); await signIn(pd, 'deputy@school.na', PW.deputy);
  ok(/Tsandi Secondary School/.test(await text(pd)) && (await pd.locator('.chip:has-text("Accounts")').count()) === 1, 'the deputy sees the school and the Accounts tab');
  await p.setInputFiles('#logo', path.join(ROOT, 'monitor/favicon.png')); await p.waitForTimeout(2000);
  await go(p, '#school/' + S.T); await p.waitForTimeout(600);
  const logoOk = await p.evaluate(() => { const i = document.querySelector('.head img.school-logo'); return !!(i && i.complete && i.naturalWidth > 0); });
  ok(logoOk, 'the uploaded logo shows on the school page');
  await shot(p, 'monitor2-school-logo.png');

  console.log('\n7. A regional manager: staff only');
  const pr = await newPage();
  await signIn(pr, 'director@school.na', PW.director);
  await pr.click('.chip:has-text("Accounts")'); await pr.waitForTimeout(1000);
  t = await text(pr);
  ok(/only staff accounts are listed/.test(t) && noNames(t) && /Ms Amutenya/.test(t), 'the director sees staff in Omusati and no learner names', [names.filter((x) => t.includes(x)), t.slice(0, 900)]);
  await pr.click('#add'); await pr.waitForTimeout(400);
  ok((await pr.locator('#ar option').count()) === 1 && (await pr.locator('#ar option').first().innerText()) === 'Teacher', 'the director can add teachers, not learners');
  await pr.fill('#an', 'Mr New Teacher'); await pr.fill('#ass', 'Outapi'); await pr.click('#asb'); await pr.waitForTimeout(700);
  await pr.fill('#ae', 'new.teacher@school.na');
  await pr.click('dialog button[type=submit]'); await pr.waitForTimeout(1500);
  ok(/Account added/.test(await text(pr)) && /new.teacher@school.na/.test(await text(pr)), 'a teacher is added at Outapi with their email address');
  await pr.click('dialog [data-close]');
  ok(!(await pr.locator('#give').count()), 'the director was not allowed to give rights, so there is no button');
  await shot(pr, 'monitor2-accounts-region.png');

  console.log('\n8. The same password step in the K12Plus app');
  const pa = await newPage(390, 'http://127.0.0.1:' + APP + '/tests/pilot/blank.html');
  await pa.addScriptTag({ url: 'http://127.0.0.1:' + APP + '/k12plus-bridge.js' });
  const loginP = pa.evaluate(() => window.k12auth.login('K12-NA-000002', 'Mopane2468Kudu'));
  await pa.waitForTimeout(1500);
  ok(/Choose your own password/.test(await text(pa)), 'the app shows the same step after a temporary password');
  await pa.fill('#k12np1', 'SelmaOwn2026'); await pa.fill('#k12np2', 'SelmaOwn2026'); await pa.click('form button[type=submit]');
  const res = await loginP;
  ok(res.ok === true && (await db.query("select pw from auth.users u join profiles p on p.id = u.id where p.learner_uid = 'K12-NA-000002'")).rows[0].pw === 'SelmaOwn2026', 'and finishes signing in once the new password is saved', res);

  console.log('\n9. Phones, words and errors');
  const pp = await newPage(390); await signIn(pp, 'national@school.na', PW.national);
  ok(await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the country page fits a 390 px phone');
  await shot(pp, 'monitor2-country-390.png');
  await go(pp, '#accounts/country');
  ok(await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'so does Accounts');
  const src = ['index.html', 'monitor.js', 'charts.js'].map((f) => fs.readFileSync(path.join(ROOT, 'monitor', f), 'utf8')).join('\n');
  const strings = (src.match(/'[^'\n]*'|"[^"\n]*"|>[^<>{}\n]{3,}</g) || []).join(' ');
  ok(!/\btutor|\bstudent/i.test(strings), 'the screens say agent and learners, never tutor or student');
  ok(!/[–—]/.test(strings), 'no en or em dashes in anything a user sees');
  ok(!/\b(don't|can't|won't|isn't|aren't|doesn't|didn't|you're|it's|we're|they're|let's)\b/i.test(strings), 'no contractions');
  ok(!/text-transform:\s*uppercase/.test(src), 'no small uppercase titles');
  ok(errors.length === 0, 'no errors in any page', errors);

  await browser.close(); site.close(); appSite.close(); fake.close(); deno.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
