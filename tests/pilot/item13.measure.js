// Item 13: how much mobile data K12Plus uses.
//
// Runs the real site in headless Chromium with the service worker on, exactly as a phone
// would load https://k12plus.app, except that the browser is pointed at a local HTTPS
// stand-in for every server the app talks to:
//   k12plus.app   the site files, compressed with brotli and served with the live host's
//                 caching rules ("no-cache, must-revalidate" plus ETag, so a return visit
//                 only asks "has this changed?"; the logo cached for a week)
//   unpkg.com     React, cached for a year as unpkg does
//   Google Fonts  the stylesheet and font files, at the sizes measured on k12plus.app
//   Supabase      sign-in data and the agent; the agent returns replies as long as the
//                 replies real learners receive (agent_logs, August to October 2026), so
//                 no AI calls are made
// Bytes are counted on the raw connections, so they include encryption, handshakes and
// headers: what the phone's data bundle pays for, apart from TCP/IP packet headers
// (about 3% more). Like the live host, the stand-in speaks HTTP/2 (one connection per
// server, compressed headers).
//
// Usage: node item13.measure.js [label]
//   needs port 443 and Chromium at /opt/pw-browsers/chromium; writes item13-<label>.json
const { chromium } = require('playwright');
const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '../..');
const VENDOR = process.env.VENDOR_DIR || '/tmp/claude-0/render';
const TLS = process.env.TLS_DIR;
const LABEL = process.argv[2] || 'now';
const SITE = 'https://k12plus.app';
const SUPA = 'uwqbjjzjdnjlbicxrwnp.supabase.co';

// Real replies: median 95 and 90th percentile 178 output tokens. Every reply here is
// 180 tokens (about 740 characters), so the session estimate errs on the high side.
const REPLY = 'Let us work through it step by step. '.repeat(20).slice(0, 740);
// Font files as measured on k12plus.app (23 October 2026)
const FONT_FILE = { comfortaa: 13416, poppins: 7900, nunito: 9800, baloo: 11800 };

// ---------- byte counting on the raw connections ----------
const sockets = new Set();
const seen = new Map();
const perRequest = [];
const snapshot = () => {
  let n = 0;
  for (const s of sockets) { const now = s.bytesRead + s.bytesWritten; n += now - (seen.get(s) || 0); seen.set(s, now); }
  const reqs = perRequest.splice(0);
  return { bytes: n, requests: reqs };
};

const br = (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
let aiCalls = 0; const aiUp = [];

const server = http2.createSecureServer({ allowHTTP1: true, key: fs.readFileSync(path.join(TLS, 'key.pem')), cert: fs.readFileSync(path.join(TLS, 'cert.pem')) }, (req, res) => {
  const host = (req.headers[':authority'] || req.headers.host || '').split(':')[0];
  const url = new URL(req.url, 'https://' + host);
  const origin = req.headers.origin;
  const compress = (buf) => /\bbr\b/.test(req.headers['accept-encoding'] || '') ? [br(buf), 'br'] : [buf, null];
  const reply = (status, headers, raw, label) => {
    let body = raw;
    if (raw && raw.length > 256 && /text|javascript|json|css|manifest/.test(headers['Content-Type'] || '')) {
      const [b, enc] = compress(raw); body = b; if (enc) headers['Content-Encoding'] = enc;
    }
    if (body) headers['Content-Length'] = body.length;
    res.writeHead(status, headers); res.end(body || undefined);
    perRequest.push([label || host + url.pathname, status, body ? body.length : 0]);
  };
  let reqBody = [];
  req.on('data', (c) => reqBody.push(c));
  req.on('end', () => {
    reqBody = Buffer.concat(reqBody);
    if (host === 'k12plus.app') {
      let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return reply(404, { 'Content-Type': 'text/html' }, Buffer.from('<h1>404</h1>'), 'k12plus.app 404 ' + p.slice(0, 40));
      const raw = fs.readFileSync(file); const ext = path.extname(file);
      const base = { 'Content-Type': TYPES[ext] || 'application/octet-stream', Server: 'hcdn' };
      if (ext === '.png') return reply(200, { ...base, 'Cache-Control': 'public, max-age=604800' }, raw, 'k12plus.app' + p);
      const etag = '"' + crypto.createHash('md5').update(raw).digest('hex') + '"';
      const h = { ...base, 'Cache-Control': 'no-cache, must-revalidate', ETag: etag };
      if (req.headers['if-none-match'] === etag) return reply(304, h, null, 'k12plus.app' + p + url.search + ' (unchanged)');
      return reply(200, h, raw, 'k12plus.app' + p + url.search);
    }
    if (host === 'unpkg.com') {
      const map = { '/react@18.3.1/umd/react.production.min.js': 'node_modules/react/umd/react.production.min.js', '/react-dom@18.3.1/umd/react-dom.production.min.js': 'node_modules/react-dom/umd/react-dom.production.min.js', '/@babel/standalone@7.29.0/babel.min.js': 'node_modules/@babel/standalone/babel.min.js' };
      if (!map[url.pathname]) return reply(404, { 'Content-Type': 'text/plain' }, Buffer.from('no'));
      return reply(200, { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=31536000, immutable' }, fs.readFileSync(path.join(VENDOR, map[url.pathname])), 'unpkg.com' + url.pathname.split('/')[1]);
    }
    if (host === 'fonts.googleapis.com') {
      const fams = (url.searchParams.getAll('family')).map((f) => f.split(':')[0]);
      const faces = [];
      for (const f of fams) {
        const key = f.toLowerCase().replace(/[^a-z]/g, '').replace('baloo2', 'baloo');
        const weights = /Poppins/.test(f) ? [400, 500, 600, 700, 800] : [700, 800];
        for (const w of weights) faces.push(`/* latin */\n@font-face {\n  font-family: '${f.replace(/\+/g, ' ')}';\n  font-style: normal;\n  font-weight: ${w};\n  font-display: swap;\n  src: url(https://fonts.gstatic.com/s/${key}/v24/${key}-${w}-latin.woff2) format('woff2');\n  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;\n}\n`);
      }
      return reply(200, { 'Content-Type': 'text/css; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=86400' }, Buffer.from(faces.join('')), 'Google Fonts stylesheet');
    }
    if (host === 'fonts.gstatic.com') {
      const key = url.pathname.split('/')[2];
      const size = FONT_FILE[key] || 8000;
      return reply(200, { 'Content-Type': 'font/woff2', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=31536000' }, crypto.randomBytes(size), 'Google font ' + key);
    }
    if (host === SUPA) {
      const cors = { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, prefer', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
      if (req.method === 'OPTIONS') return reply(204, cors, null, 'Supabase permission check (CORS)');
      let json = [];
      if (url.pathname === '/functions/v1/aim') { aiCalls++; aiUp.push(reqBody.length); json = { reply: REPLY }; }
      else if (url.pathname.startsWith('/rest/v1/rpc/')) json = null;
      return reply(200, { ...cors, 'Content-Type': 'application/json' }, Buffer.from(JSON.stringify(json)), 'Supabase ' + url.pathname.replace('/rest/v1/', '').replace('/functions/v1/', 'function ').slice(0, 40));
    }
    reply(404, { 'Content-Type': 'text/plain' }, Buffer.from('unknown host'));
  });
});
server.on('connection', (s) => { sockets.add(s); });

(async () => {
  await new Promise((r) => server.listen(443, '127.0.0.1', r));
  const hosts = ['k12plus.app', 'www.k12plus.app', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com', SUPA];
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--host-resolver-rules=' + hosts.map((h) => 'MAP ' + h + ' 127.0.0.1').join(', ') + ', MAP * ~NOTFOUND', '--disable-quic', '--no-proxy-server'],
    // the test certificate is trusted through a test certificate authority in this HOME, so the
    // browser caches files as it would for the real site (it caches nothing from untrusted sites)
    env: { ...process.env, HOME: path.join(TLS, 'home') },
  });
  const ctx = await browser.newContext({ viewport: { width: 400, height: 820 }, isMobile: true, hasTouch: true, serviceWorkers: 'allow' });
  const errors = [];
  const out = { label: LABEL, measured: new Date().toISOString(), replyChars: REPLY.length };
  const kb = (n) => +(n / 1024).toFixed(1);
  const phase = (extra = {}) => {
    const s = snapshot();
    const byHost = {};
    for (const [lab, , n] of s.requests) { const h = lab.startsWith('k12plus.app') ? 'k12plus.app' : lab.split(' ')[0]; byHost[h] = (byHost[h] || 0) + n; }
    return { totalKB: kb(s.bytes), requests: s.requests.length,
      bodiesKB: Object.fromEntries(Object.entries(byHost).map(([h, n]) => [h, kb(n)])),
      biggest: s.requests.slice().sort((a, b) => b[2] - a[2]).slice(0, 10).map(([l, st, n]) => l + ' ' + st + ' ' + kb(n) + ' KB'), ...extra };
  };
  // what the phone's own data counter (sent by pilot learners' phones) recorded on this page
  const counter = (pg) => pg.evaluate(async () => { if (window.k12pullWorkerData) await window.k12pullWorkerData(); return +((window.k12dataUsed ? window.k12dataUsed() : -1) / 1024).toFixed(1); });
  // DevTools "Slow 3G": 400 kbit/s each way, 400 ms latency
  const slow = async (page) => { const c = await ctx.newCDPSession(page); await c.send('Network.enable'); await c.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50000, uploadThroughput: 50000 }); };
  const ready = async (page, t0) => {
    await page.waitForFunction(() => { const t = document.querySelector('#dc-root textarea'); return !!t && !/\{\{/.test(t.getAttribute('placeholder') || ''); }, null, { timeout: 180000 });
    return +((Date.now() - t0) / 1000).toFixed(1);
  };
  const settle = async (page, ms = 5000) => { await page.evaluate(() => navigator.serviceWorker && navigator.serviceWorker.ready).catch(() => {}); await page.waitForTimeout(ms); };
  const open = async (url, throttle) => {
    const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    if (throttle) await slow(page);
    const t0 = Date.now(); await page.goto(url, { waitUntil: 'commit' }); const secs = await ready(page, t0);
    return [page, secs];
  };

  // 1. First visit: a learner opens k12plus.app for the first time on a new phone.
  snapshot();
  let [page, secs] = await open(SITE + '/', true);
  await settle(page, 8000);
  out.firstVisitHome = phase({ secondsUntilReadySlow3G: secs, phoneCounterKB: await counter(page), serviceWorker: await page.evaluate(() => !!navigator.serviceWorker.controller) });

  // 2. She opens the app from the homepage, the same day.
  await page.close();
  [page, secs] = await open(SITE + '/app.html', true);
  await page.evaluate(() => { localStorage.setItem('k12plus-tour-done', '1'); });
  await settle(page);
  out.firstOpenApp = phase({ secondsUntilReadySlow3G: secs, phoneCounterKB: await counter(page) });

  // she signs in (a stand-in session; sign-in itself is a few KB)
  await page.evaluate(() => {
    const id = '00000000-0000-0000-0000-00000000000a';
    const tok = 'h.' + btoa(JSON.stringify({ exp: 9999999999, sub: id })).replace(/=/g, '') + '.s';
    localStorage.setItem('k12plus-session', JSON.stringify({ access_token: tok, refresh_token: 'r', user_id: id }));
    localStorage.setItem('k12plus-loggedin', '1'); localStorage.setItem('k12plus-role', 'Learner'); localStorage.setItem('k12plus-name', 'Ndapewa');
    localStorage.setItem('k12plus-grade', '11'); localStorage.setItem('k12plus-tutor-subject', 'Mathematics');
  });
  await page.close();
  snapshot();

  // 3. Return visit the next day.
  [page, secs] = await open(SITE + '/app.html', true);
  await page.waitForTimeout(4000);
  out.returnVisit = phase({ secondsUntilReadySlow3G: secs, phoneCounterKB: await counter(page) });

  // 4. A 20-minute session with the AI Math Agent: 12 questions.
  const qs = ['How do I solve 2x + 5 = 17?', 'Why do we subtract 5 first?', 'Can you give me a harder one?', 'Is x = 4 right for 3x - 2 = 10?',
    'What is a quadratic equation?', 'How do I factorise x² + 5x + 6?', 'What does the discriminant tell me?', 'Give me a netball example of a parabola.',
    'How do I find the turning point?', 'Can you check my working: (x+2)(x+3) = x² + 5x + 6', 'What should I revise for the test?', 'Thank you! One more practice question please.'];
  aiCalls = 0; aiUp.length = 0;
  for (const q of qs) {
    const ta = page.locator('#dc-root textarea').first();
    await ta.fill(q); await ta.press('Enter');
    await page.waitForTimeout(1800);
  }
  out.session12Questions = phase({ aiCalls, questionUploadKB: aiUp.map(kb), phoneCounterKBSincePageOpened: await counter(page) });
  // 8 more questions: a long chat. Only what the agent reads is sent, so each question
  // stops growing once the chat passes 16 messages.
  aiCalls = 0; aiUp.length = 0;
  for (const q of ['What is the gradient of y = 3x + 2?', 'And where does it cross the y-axis?', 'How do I draw it?', 'What about y = -2x + 4?',
    'Which one is steeper?', 'Can you give me a word problem?', 'Is the answer N$150?', 'Thank you, that is all for today.']) {
    const ta = page.locator('#dc-root textarea').first();
    await ta.fill(q); await ta.press('Enter');
    await page.waitForTimeout(1800);
  }
  out.eightMoreQuestions = phase({ aiCalls, questionUploadKB: aiUp.map(kb) });
  await page.close();

  // 5. One photo of an exercise book page, shrunk by the app to 1024 pixels wide.
  page = (await open(SITE + '/app.html'))[0];
  snapshot();
  const jpegChars = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 768; const g = c.getContext('2d');
    g.fillStyle = '#f7f3e8'; g.fillRect(0, 0, 1024, 768); g.fillStyle = '#1b2a6b'; g.font = '34px serif';
    for (let i = 0; i < 14; i++) { g.fillRect(0, 50 + i * 52, 1024, 1); g.fillText('2x + 5 = 17   so   2x = 12   x = ' + (6 + (i % 3)), 40 + (i % 2) * 30, 44 + i * 52); }
    for (let i = 0; i < 9000; i++) { g.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.06) + ')'; g.fillRect(Math.random() * 1024, Math.random() * 768, 2, 2); }
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  });
  await page.evaluate(async (data) => { await window.claude.complete({ messages: [{ role: 'user', content: 'Please check my working.' }], image: { mime: 'image/jpeg', data } }).catch(() => {}); }, jpegChars);
  await page.waitForTimeout(1500);
  out.onePhotoQuestion = phase();
  await page.close();

  // 6. Offline: with the network off, does the app still open from the phone?
  await ctx.setOffline(true);
  try { [page] = await open(SITE + '/app.html'); out.opensOffline = true; await page.close(); } catch (e) { out.opensOffline = false; }
  await ctx.setOffline(false);

  out.errors = errors.filter((e) => !/Failed to fetch|NetworkError|Load failed/.test(e));
  const file = path.join(process.env.SHOT_DIR || __dirname, 'item13-' + LABEL + '.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await browser.close(); server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
