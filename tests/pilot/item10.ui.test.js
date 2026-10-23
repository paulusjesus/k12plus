// Item 10 end to end: the administrator downloads the evaluator export from the real
// app.html (headless Chromium, Supabase replaced by PGlite with the real migrations).
// The zip is opened with Python's zipfile module to prove it is a valid zip file.
const { chromium } = require('playwright');
const { PGlite } = require('@electric-sql/pglite');
const { execFileSync } = require('child_process');
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
  '20261028_pilot_tests.sql', '20261029_pilot_reports.sql', '20261030_pilot_feedback_review.sql', '20261031_pilot_evaluator_export.sql'];

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
  for (const f of MIGS) await db.exec(fs.readFileSync(path.join(__dirname, '../../backend/migrations', f), 'utf8'));
  const U = {}, S = {};
  const mk = async (key, role, o = {}) => {
    U[key] = (await db.query('insert into auth.users (email) values ($1) returning id', [key + '@test.na'])).rows[0].id;
    await db.query('insert into profiles (id, username, role, grade, country, learner_uid, phone) values ($1,$2,$3,$4,$5,$6,$7)', [U[key], o.name || key, role, o.grade || null, 'Namibia', o.uid || null, o.phone || null]);
  };
  for (const [k, name] of [['A', 'Tsandi Secondary School'], ['B', 'Outapi Secondary School']]) S[k] = (await db.query("insert into schools (name, region, country, region_id) values ($1, 'x', 'Namibia', 10) returning id", [name])).rows[0].id;
  await mk('admin', 'learner', { name: 'Pilot Admin' }); await db.query("update profiles set role = 'admin' where id = $1", [U.admin]);
  const asUser = (uid, fn) => db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await tx.query('set local role authenticated');
    return fn(tx);
  });
  const sql = (who, q, p) => asUser(U[who], (tx) => tx.query(q, p));
  const svc = (q, p) => db.transaction(async (tx) => { await tx.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)"); return tx.query(q, p); });
  const set = (await sql('admin', 'select pilot_setup_region(10::smallint, $1::jsonb) v', [JSON.stringify([{ school_id: S.A, setting: 'rural' }, { school_id: S.B, setting: 'urban' }])])).rows[0].v;
  const consent = (b) => svc('select pilot_save_consent($1::jsonb)', [JSON.stringify({ given_by_name: 'P', given_by_relation: 'mother', method: 'paper_form', evidence_path: 'x', signed_on: '2026-09-01', ...b })]);
  for (const k of ['A', 'B']) await consent({ kind: 'school', school_id: S[k], given_by_relation: 'principal' });
  let n = 0;
  for (const sc of set.schools) for (const c of sc.classes) for (let i = 0; i < (c.grade === 11 ? 6 : 2); i++) {
    const key = 'l' + (++n);
    await mk(key, 'learner', { name: 'Learner Name ' + n, grade: c.grade, phone: '+2648100000' + String(n).padStart(2, '0'), uid: 'K12-NA-UI' + n });
    await sql(key, 'select pilot_join_class($1)', [c.code]);
    await consent({ kind: 'guardian', learner_id: U[key] });
  }
  await db.query("insert into learning_events (learner_id, class_id, kind, topic, client_ref, occurred_at) select learner_id, class_id, 'question', 'Algebra', 'ui-' || learner_id, now() - interval '2 days' from enrolments");

  const tokenFor = (key) => 'h.' + Buffer.from(JSON.stringify({ exp: 9999999999, sub: U[key] })).toString('base64').replace(/=/g, '') + '.s';
  const uidFromAuth = (h) => { try { return JSON.parse(Buffer.from((h || '').split('.')[1], 'base64').toString()).sub; } catch (e) { return null; } };
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
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
    return r.fulfill({ json: [] });
  });
  await page.goto('http://127.0.0.1:8765/app.html');
  await page.evaluate(([tok, uid]) => {
    localStorage.setItem('k12plus-session', JSON.stringify({ access_token: tok, refresh_token: 'r', user_id: uid }));
    localStorage.setItem('k12plus-loggedin', '1'); localStorage.setItem('k12plus-role', 'Learner');
    localStorage.setItem('k12plus-name', 'admin'); localStorage.setItem('k12plus-tour-done', '1');
  }, [tokenFor('admin'), U.admin]);
  await page.reload(); await page.waitForTimeout(2500);
  await page.click('button:has-text("Pilot")'); await page.waitForTimeout(1500);
  const text = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

  console.log('\nThe administrator downloads the export');
  let t = await text();
  ok(/Export for the independent evaluator/.test(t), 'the Pilot page has the export panel');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Download the export (zip)")')]);
  const zipPath = path.join(process.env.SHOT_DIR || __dirname, 'item10-export.zip');
  await dl.saveAs(zipPath);
  await page.waitForTimeout(500);
  t = await text();
  ok(/Export ready: 16 learners, 8 files \(README\.txt, data_dictionary\.csv, learners\.csv/.test(t), 'the page confirms what was exported', t.match(/Export ready[^)]*\)/));
  ok(/^k12plus-pilot-export-\d{4}-\d\d-\d\d-to-\d{4}-\d\d-\d\d\.zip$/.test(dl.suggestedFilename()), 'the file is named with the period it covers', dl.suggestedFilename());
  const py = execFileSync('python3', ['-I', '-c', `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
out = {'bad': bad, 'names': z.namelist(), 'files': {}}
for n in z.namelist():
    t = z.read(n).decode('utf-8')
    out['files'][n] = {'head': t[:400], 'lines': len(t.strip().splitlines()), 'bom': t.startswith('\\ufeff')}
print(json.dumps(out))
`, zipPath]).toString();
  const z = JSON.parse(py);
  ok(z.bad === null && z.names.length === 8, 'the zip opens with a standard zip tool and every file checks out (no damaged files)', z.names);
  ok(['README.txt', 'data_dictionary.csv', 'learners.csv', 'test_scores.csv', 'test_items.csv', 'usage_weekly.csv', 'schools.csv', 'costs_monthly.csv'].every((f) => z.names.includes(f)), 'it holds the README, the data dictionary and the six data files');
  ok(/K12Plus 2027 pilot: data export for the independent evaluator/.test(z.files['README.txt'].head) && /Learners included: 16\./.test(z.files['README.txt'].head), 'the README says what the export is, the period and how many learners');
  ok(z.files['learners.csv'].bom && /pilot_id,grade,syllabus,region,setting,school_code,class_code,small_group,enrolled_week/.test(z.files['learners.csv'].head) && z.files['learners.csv'].lines === 17,
    'the CSV files open cleanly in Excel (UTF-8 with a marker) and have a header row plus one row per learner', z.files['learners.csv'].head.slice(0, 120));
  ok(/file,field,type,description/.test(z.files['data_dictionary.csv'].head) && z.files['data_dictionary.csv'].lines > 40, 'the data dictionary is included as a CSV');
  const everything = Object.values(z.files).map((f) => f.head).join(' ') + fs.readFileSync(zipPath).toString('latin1');
  ok(!/Learner Name|\+264|K12-NA-|Secondary School|@test\.na/.test(everything), 'no names, phone numbers, K12Plus IDs, school names or emails in the zip');
  const small = execFileSync('python3', ['-I', '-c', `
import zipfile, csv, io, sys, json
z = zipfile.ZipFile(sys.argv[1])
rows = list(csv.DictReader(io.StringIO(z.read('learners.csv').decode('utf-8-sig'))))
print(json.dumps([r for r in rows if r['small_group'] == '1']))
`, zipPath]).toString();
  const smallRows = JSON.parse(small);
  ok(smallRows.length === 4 && smallRows.every((r) => !r.region && !r.setting && !r.school_code && !r.class_code), 'Grade 12 learners at schools with only 2 in that grade appear without region, setting or school', smallRows.length);

  console.log('\nThe school code key');
  const [dk] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("School code key (keep this private)")')]);
  const keyCsv = fs.readFileSync(await dk.path(), 'utf8');
  ok(/PRIVATE/.test(dk.suggestedFilename()) && /school_code,school,region,setting/.test(keyCsv) && /Tsandi Secondary School/.test(keyCsv), 'the key from codes to schools downloads separately, marked private');
  t = await text();
  ok(/never send it with the export/.test(t), 'with a reminder to keep it apart from the export');

  ok(errors.length === 0, 'no page errors', errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
