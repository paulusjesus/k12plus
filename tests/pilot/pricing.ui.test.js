// Pricing (30 October 2026), on the phone: the app sends a random phone ID with every
// question, sends a signed-in learner's own sign-in, shows the warm note when the day's
// questions are used up, and keeps a question asked offline for the next day.
const { chromium } = require('playwright');
const path = require('path');
const local = { 'react@18.3.1/umd/react.production.min.js': 'node_modules/react/umd/react.production.min.js',
  'react-dom@18.3.1/umd/react-dom.production.min.js': 'node_modules/react-dom/umd/react-dom.production.min.js' };
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const seen = [];
  let mode = 'limit';
  await page.route('https://unpkg.com/**', (r) => { const k = Object.keys(local).find((x) => r.request().url().includes(x)); return k ? r.fulfill({ path: path.join(process.env.VENDOR_DIR, local[k]), contentType: 'application/javascript' }) : r.abort(); });
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
  await page.route('https://uwqbjjzjdnjlbicxrwnp.supabase.co/**', async (r) => {
    if (r.request().url().endsWith('/functions/v1/aim')) {
      seen.push(JSON.parse(r.request().postData()));
      return mode === 'limit'
        ? r.fulfill({ status: 402, json: { error: 'daily_limit', reply: "You have used today's 5 free questions. They come back tomorrow." } })
        : r.fulfill({ json: { reply: 'Good effort!' } });
    }
    return r.fulfill({ json: [] });
  });
  await page.goto('http://127.0.0.1:8765/app.html');
  await page.waitForTimeout(1500);
  let reply = await page.evaluate(() => window.claude.complete({ system: 'x', messages: [{ role: 'user', content: 'hi' }] }));
  ok(/used today's 5 free questions/.test(reply), 'when the day\'s questions are used up, the learner sees the warm note (not an error)', reply);
  ok(/^[A-Za-z0-9-]{8,64}$/.test(seen[0].k12device || '') && !seen[0].k12token, 'a visitor sends a random phone ID and no sign-in', seen[0]);
  const dev = seen[0].k12device;
  await page.evaluate(() => window.claude.complete({ system: 'x', messages: [{ role: 'user', content: 'again' }] }));
  ok(seen[1].k12device === dev, 'the same phone ID is kept on the phone');
  const tok = 'h.' + b64({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'u1' }) + '.s';
  await page.evaluate((t) => { localStorage.setItem('k12plus-session', JSON.stringify({ access_token: t, refresh_token: 'r', user_id: 'u1' })); localStorage.setItem('k12plus-loggedin', '1'); }, tok);
  await page.evaluate(() => window.claude.complete({ system: 'x', messages: [{ role: 'user', content: 'signed in' }] }));
  ok(seen[2].k12token === tok, 'a signed-in learner who is not in the pilot sends her own sign-in, so her plan is counted', seen[2]);
  await page.evaluate(() => { localStorage.setItem('k12plus-outbox', JSON.stringify([{ id: 'q1', payload: { action: 'chat', system: 'x', messages: [{ role: 'user', content: 'offline question' }] }, at: Date.now() }])); localStorage.removeItem('k12plus-outbox-lock'); });
  await page.evaluate(() => window.k12flushQuestions());
  ok(await page.evaluate(() => window.k12pendingQuestions()) === 1, 'a question asked offline stays saved when the day\'s questions are used up, to be answered tomorrow');
  mode = 'ok';
  await page.evaluate(() => localStorage.removeItem('k12plus-outbox-lock'));
  await page.evaluate(() => window.k12flushQuestions());
  ok(await page.evaluate(() => window.k12pendingQuestions()) === 0, 'and it is answered once questions are available again');
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
