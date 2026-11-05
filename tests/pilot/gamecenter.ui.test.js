// The "in my life" button and the Game Center, in the real app.html in headless Chromium.
// Covers: the button after an agent reply and the home chip send the right request and the
// agent's instructions; coins from practice (with the daily limit), quizzes (once a day for
// each subject) and pilot tests (once); points earned before coins become coins; one purse per
// account; the Game Center with too few coins, the ways to earn, paying for a game and
// playing it to the end; a 390 px phone; no errors.
// Run: NODE_PATH=<node_modules with playwright> VENDOR_DIR=<folder with node_modules/react, react-dom> node gamecenter.ui.test.js
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const PORT = 8768;
const local = { 'react@18.3.1/umd/react.production.min.js': 'node_modules/react/umd/react.production.min.js',
  'react-dom@18.3.1/umd/react-dom.production.min.js': 'node_modules/react-dom/umd/react-dom.production.min.js',
  '@babel/standalone@7.29.0/babel.min.js': 'node_modules/@babel/standalone/babel.min.js' };
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'application/javascript' : 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  }).listen(PORT);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [], asks = [];
  const open = async (width, setup) => {
    const ctx = await browser.newContext({ viewport: { width, height: 860 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://unpkg.com/**', (r) => { const k = Object.keys(local).find((x) => r.request().url().includes(x)); return k ? r.fulfill({ path: path.join(process.env.VENDOR_DIR, local[k]), contentType: 'application/javascript' }) : r.abort(); });
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
    await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await page.route('https://uwqbjjzjdnjlbicxrwnp.supabase.co/**', async (r) => {
      const url = r.request().url();
      if (url.endsWith('/functions/v1/aim')) { asks.push(JSON.parse(r.request().postData())); return r.fulfill({ json: { reply: 'A quadratic like y = x² + 2x is a curve. Here is how it works step by step.' } }); }
      return r.fulfill({ json: [] });
    });
    await page.goto(`http://127.0.0.1:${PORT}/tests/pilot/blank.html`);
    await page.evaluate(setup);
    await page.goto(`http://127.0.0.1:${PORT}/app.html`);
    await page.waitForTimeout(2500);
    return page;
  };
  const tok = 'h.' + b64({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'learner-1' }) + '.s';
  const signedIn = new Function(`
    localStorage.setItem('k12plus-session', JSON.stringify({ access_token: '${tok}', refresh_token: 'r', user_id: 'learner-1' }));
    localStorage.setItem('k12plus-loggedin', '1'); localStorage.setItem('k12plus-role', 'Learner'); localStorage.setItem('k12plus-name', 'Ndapewa');
    localStorage.setItem('k12plus-grade', '11'); localStorage.setItem('k12plus-tour-done', '1'); localStorage.setItem('k12plus-points', '40');`);
  const text = async (p) => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

  console.log('\n1. "Make me understand this, in my life"');
  let p = await open(1280, signedIn);
  ok(await p.locator('button:has-text("Use it in my life")').count() >= 1, 'the home screen has a "Use it in my life" chip');
  await p.click('button:has-text("Use it in my life")'); await p.waitForTimeout(300);
  ok(/Make me understand this equation, and show me how I can apply it in real life, in my life:/.test(await p.locator('textarea').first().inputValue()), 'the chip starts the request for the learner to finish');
  await p.locator('textarea').first().fill('Make me understand this equation, and show me how I can apply it in real life, in my life: y = x² + 2x');
  await p.locator('textarea').first().press('Enter'); await p.waitForTimeout(1500);
  const first = asks.at(-1);
  ok(first && /four short parts/.test(first.system) && /in their own life/.test(first.system) && /230 words/.test(first.system), 'the agent is told how to answer "in my life" requests, typed or spoken', first && first.system.slice(0, 200));
  ok(await p.locator('button[data-my-life]').count() === 1, 'after the reply, the "Make me understand this, in my life" button appears');
  await p.click('button[data-my-life]'); await p.waitForTimeout(1500);
  const second = asks.at(-1);
  ok(second.messages.at(-1).content === 'Make me understand this equation step by step, and show me how I can apply it in real life, in my own life.' && second.messages.length >= 3,
    'the button sends the request with the whole conversation, so the agent knows which equation', second.messages.map((m) => m.content.slice(0, 40)));

  console.log('\n2. Coins');
  ok(await p.evaluate(() => window.k12coins.balance()) === 40, 'points earned before coins existed become coins (40)');
  const capped = await p.evaluate(() => { let n = 0; for (let i = 0; i < 20; i++) n += window.k12coins.earn(30, 'practice'); return n; });
  ok(capped === 300 && await p.evaluate(() => window.k12coins.practiceLeftToday()) === 0, 'practice answers earn at most 300 coins a day', capped);
  ok(await p.evaluate(() => [window.k12coins.earn(50, 'test', 'test:abc'), window.k12coins.earn(50, 'test', 'test:abc')].join()) === '50,0', 'a pilot test earns 50 coins once');
  const bridgeHook = fs.readFileSync(path.join(ROOT, 'k12plus-bridge.js'), 'utf8');
  ok(/k12coins\.earn\(50, 'test', 'test:'/.test(bridgeHook), 'submitting a pilot test pays the 50 coins');
  await p.evaluate(() => { localStorage.setItem('k12plus-coins:learner-1', JSON.stringify({ coins: 0, once: {}, day: '2000-01-01', practiceToday: 0, log: [] })); });
  ok(await p.evaluate(() => window.k12coins.balance()) === 0, 'starting this check from an empty purse');

  console.log('\n3. The Game Center');
  await p.click('text=Game Center'); await p.waitForTimeout(500);
  let t = await text(p);
  ok(/Game Center/.test(t) && /Match Up/.test(t) && /Number Sprint/.test(t) && /Science Scramble/.test(t) && /Your practice games in the Game Arcade are always free/.test(t), 'three reward games, and practice stays free', t.slice(0, 300));
  await p.click('[data-play=sprint]'); await p.waitForTimeout(300);
  t = await text(p);
  ok(/You do not have enough coins to play this game/.test(t) && /costs 20 coins and you have 0/.test(t) && /You need 20 more/.test(t), 'with too few coins: how many are needed', t.slice(0, 400));
  ok(/Take a quiz/.test(t) && /Answer practice questions/.test(t) && /Ask your agent/.test(t), 'and the ways to earn them');
  await p.click('[data-way=quiz]'); await p.waitForTimeout(800);
  ok(!(await p.locator('.k12gc').count()) && /You scored|Assessments|Quiz/i.test(await text(p)), '"Take a quiz" closes the Game Center and opens the quizzes');
  // answer the quiz (whatever the answers) and submit
  const radios = p.locator('input[type=radio]');
  const nr = await radios.count();
  for (let i = 0; i < nr; i += 4) await radios.nth(i).check().catch(() => {});
  await p.locator('button:has-text("Submit")').first().click(); await p.waitForTimeout(800);
  t = await text(p);
  const earned = Number((t.match(/\+(\d+) coins for the Game Center/) || [])[1] || 0);
  ok(earned >= 10 && earned <= 35, 'finishing a quiz earns 10 coins plus 5 for each right answer', t.match(/You scored[^.]*\./));
  await p.click('button:has-text("Try again")'); await p.waitForTimeout(300);
  for (let i = 0; i < nr; i += 4) await radios.nth(i).check().catch(() => {});
  await p.locator('button:has-text("Submit")').first().click(); await p.waitForTimeout(800);
  ok(/already earned today's coins for this quiz/.test(await text(p)) && await p.evaluate(() => window.k12coins.balance()) === earned, 'the same quiz again today earns nothing more');
  await p.evaluate(() => window.k12coins.earn(60, 'test', 'test:for-the-check'));
  const before = await p.evaluate(() => window.k12coins.balance());
  await p.click('text=Game Center'); await p.waitForTimeout(400);
  await p.click('[data-play=scramble]'); await p.waitForTimeout(400);
  ok(await p.evaluate(() => window.k12coins.balance()) === before - 25 && /Word 1 of 5/.test(await text(p)), 'with enough coins, Science Scramble costs 25 and starts');
  for (let i = 0; i < 5; i++) { await p.click('[data-skip]'); await p.waitForTimeout(1300); }
  t = await text(p);
  ok(/0 of 5 words/.test(t) && /Play again \(25 coins\)/.test(t), 'the game ends with a score and the option to play again', t.slice(0, 300));
  await p.click('[data-home]'); await p.waitForTimeout(300);
  await p.click('[data-play=match]'); await p.waitForTimeout(300);
  ok((await p.locator('.k12gc-tile').count()) === 12, 'Match Up deals twelve cards');
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  ok(!(await p.locator('.k12gc').count()), 'Escape closes the Game Center');

  console.log('\n4. One purse per account, and the phone');
  const other = await p.evaluate(() => { const s = localStorage.getItem('k12plus-session'); localStorage.setItem('k12plus-session', JSON.stringify({ user_id: 'learner-2' })); const b = window.k12coins.balance(); localStorage.setItem('k12plus-session', s); return b; });
  ok(other === 0, 'a second learner on the same phone starts with an empty purse');
  const ph = await open(390, signedIn);
  await ph.evaluate(() => window.k12gameCenter.open({ quiz: () => {} }));
  await ph.waitForTimeout(300);
  ok(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the Game Center fits a 390 px phone');
  await ph.screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, 'gamecenter-390.png') });
  const src = fs.readFileSync(path.join(ROOT, 'k12plus-coins.js'), 'utf8');
  const strings = (src.match(/'[^'\n]*'/g) || []).join(' ');
  ok(!/[–—]/.test(strings) && !/\b(don't|can't|won't|isn't|you're|it's|let's)\b/i.test(strings) && !/\btutor|\bstudent/i.test(strings), 'the words follow the house rules (no dashes, no contractions, agent and learners)');
  ok(errors.length === 0, 'no errors in the page', errors);

  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
