// Item 15: the website matches the profile.
// Loads every public page and the app in headless Chromium and checks what a visitor actually sees:
// "agent" not "tutor", "learners" not "students", the four agent names with the STEM subjects first,
// Grades 8-12 on the homepage, the USSD screen, the reworded promises and no small uppercase titles.
// A source scan then catches wording that only appears later (error replies, offline messages).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const local = {
  'react@18.3.1/umd/react.production.min.js': 'node_modules/react/umd/react.production.min.js',
  'react-dom@18.3.1/umd/react-dom.production.min.js': 'node_modules/react-dom/umd/react-dom.production.min.js',
  '@babel/standalone@7.29.0/babel.min.js': 'node_modules/@babel/standalone/babel.min.js',
};
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const BAD = /\btutor|\bstudent/i;
const AGENTS = ['AI Math Agent', 'AI Physical Science Agent', 'AI Biology Agent', 'AI Business Studies Agent'];
const inOrder = (t, list) => list.every((x, i) => t.indexOf(x) >= 0 && (i === 0 || t.indexOf(x) > t.indexOf(list[i - 1])));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (file, width = 1280, before) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(file + ': ' + e.message));
    await page.route('https://unpkg.com/**', (r) => {
      const k = Object.keys(local).find((x) => r.request().url().includes(x));
      return k ? r.fulfill({ path: path.join(process.env.VENDOR_DIR || __dirname, local[k]), contentType: 'application/javascript' }) : r.abort();
    });
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
    await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await page.route('https://uwqbjjzjdnjlbicxrwnp.supabase.co/**', (r) => r.fulfill({ json: [] }));
    if (before) { await page.goto('http://127.0.0.1:8765/' + file); await page.evaluate(before); }
    await page.goto('http://127.0.0.1:8765/' + file);
    await page.waitForTimeout(2200);
    return page;
  };
  const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const shot = (page, n, full = true) => page.screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, n), fullPage: full });
  // small uppercase titles: text-transform uppercase with wide letter spacing (the old eyebrow style)
  const eyebrows = (page) => page.evaluate(() => [...document.querySelectorAll('p, span, div, h1, h2, h3, h4, small, label')]
    .filter((el) => { const cs = getComputedStyle(el); return cs.textTransform === 'uppercase' && parseFloat(cs.letterSpacing) >= 1.8 && el.offsetParent !== null && el.innerText.trim(); })
    .map((el) => el.innerText.trim()));

  console.log('\nPublic pages: no tutor or student wording, no small uppercase titles');
  const pages = {};
  for (const f of ['index.html', 'about.html', 'contact.html', 'pricing.html', 'signup.html']) {
    const p = await open(f);
    pages[f] = { page: p, text: await text(p) };
    const t = pages[f].text;
    ok(t.length > 300 && !BAD.test(t), f + ' says "agent" and "learners" everywhere a visitor can read', [p.url(), t.length, (t.match(/.{0,60}(tutor|student).{0,60}/i) || [])[0]]);
    const html = await p.content();
    ok(!/>\s*(Tutor|Students?)\b/i.test(html) && !/(title|placeholder|alt|aria-label)="[^"]*(tutor|student)/i.test(html), f + ' has no hidden labels, titles or placeholders with the old words');
    if (f !== 'signup.html') {
      const eb = await eyebrows(p);
      ok(eb.length === 0, f + ' has no small uppercase titles', eb);
    }
  }
  ok(/>AI Agents<\/a>/.test(await pages['index.html'].page.content()), 'the menu link to the app reads "AI Agents"');

  console.log('\nHomepage');
  const home = pages['index.html'];
  ok(/Four AI agents for Grades 8-12/.test(home.text), 'the homepage states Grades 8-12');
  const subj = await home.page.evaluate(() => [...document.querySelectorAll('main button')].map((b) => b.innerText.trim().split('\n').pop().trim()).filter((x) => ['Mathematics', 'Physical Science', 'Biology', 'Business Studies'].includes(x)));
  ok(JSON.stringify(subj.slice(0, 4)) === JSON.stringify(['Mathematics', 'Physical Science', 'Biology', 'Business Studies']), 'the subject buttons put the STEM subjects first', subj);
  await shot(home.page, 'item15-home.png', false);
  // USSD simulation: the Mathematics screen no longer says "Grade 10/11"
  await home.page.click('button:has-text("No smartphone? Dial *141*12#")'); await home.page.waitForTimeout(400);
  for (const k of '*141*12*1#') await home.page.locator('.ussd-area-phone button', { hasText: new RegExp('^' + k.replace(/[*#]/, '\\$&') + '$') }).first().click();
  await home.page.locator('.ussd-area-phone button').filter({ hasText: /call/i }).first().click().catch(() => {});
  await home.page.waitForTimeout(400);
  const ussd = await home.page.locator('.ussd-area-phone').innerText();
  ok(/AI Math Agent, Grades 8-12/.test(ussd) && !/Grade 10\/11/.test(ussd), 'the USSD Mathematics screen names the AI Math Agent and Grades 8-12', ussd.slice(0, 160));
  await home.page.locator('.ussd-area-phone').screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, 'item15-ussd.png') });

  console.log('\nAbout page');
  const about = pages['about.html'];
  ok(inOrder(about.text, AGENTS), 'the four agent names appear exactly as in the profile, STEM first');
  ok(!/Edge AI|images and videos|blockchain/i.test(about.text), 'no Edge AI, AI images and videos, or blockchain promises');
  ok(/animated scene and a short story/.test(about.text) && /Pre-cached lessons, practice and study recommendations keep working without a signal/.test(about.text), 'Real-Life Lab and offline wording match the profile');
  ok(/being connected to the mobile networks for the pilot/.test(about.text), 'USSD is described as being connected for the pilot');
  const heads = await about.page.evaluate(() => [...document.querySelectorAll('h3')].map((h) => h.innerText.trim()));
  ok(heads.includes('Our mission') && heads.includes('Our vision') && heads.includes('Supported by'), 'Our mission, Our vision and Supported by are ordinary headings now', heads);
  ok(!/About k12plus Watch|Why we exist|Our competitive advantage|The team Meet|Get started with k12plus/i.test(about.text), 'the other small titles are gone');
  const demo = await about.page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter((x) => ['Mathematics', 'Physical Science', 'Biology', 'Business Studies'].includes(x)));
  ok(demo.indexOf('Physical Science') >= 0 && demo.indexOf('Physical Science') < demo.indexOf('Biology'), 'the Real-Life Lab demo tabs put Physical Science before Biology', demo);
  await shot(about.page, 'item15-about.png');

  console.log('\nPricing and contact');
  const pr = pages['pricing.html'];
  ok(/Common questions/.test(pr.text) && !/\bFAQ\b/.test(pr.text) && !/Compare plans Free/.test(pr.text), 'the FAQ and Compare plans labels are gone and the headings stay');
  ok(/Unlimited agent conversations/.test(pr.text) && /AI agent questions/.test(pr.text) && /Offline lessons and practice/.test(pr.text) && /Real-Life Lab/.test(pr.text) && !/Edge AI|images and videos/.test(pr.text), 'plan features use the agent wording and the reworded promises');
  await shot(pr.page, 'item15-pricing.png');
  await shot(pages['contact.html'].page, 'item15-contact.png', false);

  console.log('\nSign up, privacy policy and terms');
  // the policy and terms open in a pop-up from the sign-up form, so read them from the page source
  const su = fs.readFileSync(path.join(ROOT, 'signup.html'), 'utf8');
  ok(/5\. The AI agents/.test(su) && inOrder(su, AGENTS) && /Learners, parents and school administrators/.test(su), 'the terms name the four agents and the privacy policy says learners');

  console.log('\nThe app');
  const app = await open('app.html', 1280, () => { localStorage.setItem('k12plus-tutor-subject', 'Physical Science'); localStorage.setItem('k12plus-tour-done', '1'); });
  let t = await text(app);
  ok(/AI Physical Science Agent/.test(t), 'the chat header names the agent for the chosen subject', t.slice(0, 200));
  ok(!BAD.test(t), 'the app says "agent" and "learners" everywhere a visitor can read', (t.match(/.{0,60}(tutor|student).{0,60}/i) || [])[0]);
  const ah = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  ok(/placeholder="Ask your AI agent anything…"/.test(ah) && /title="Chat with your AI agent"/.test(ah) && /AI Math Agent<\/span>/.test(ah), 'the floating chat uses the agent wording');
  ok(!/(title|placeholder|alt|aria-label)="[^"]*(tutor|student)/i.test(ah), 'no titles or placeholders with the old words');
  ok(/Back to the agent/.test(ah) && /The k12plus agents are AI/.test(ah), 'the back button and the AI notice say agent');
  await shot(app, 'item15-app.png', false);
  const app2 = await open('app.html', 1280, () => { localStorage.setItem('k12plus-tutor-subject', 'Mathematics'); localStorage.setItem('k12plus-tour-done', '1'); });
  ok(/AI Math Agent/.test(await text(app2)), 'Mathematics shows the AI Math Agent');
  const names = await app2.evaluate(() => [window.k12agentName('Biology'), window.k12agentName('Business Studies'), window.k12agentName('History')]);
  ok(JSON.stringify(names) === JSON.stringify(['AI Biology Agent', 'AI Business Studies Agent', 'AI Agent']), 'agent names come from one list, with a plain fallback', names);
  const tour = await open('app.html', 1280, () => { localStorage.removeItem('k12plus-tour-done'); });
  const tt = await text(tour);
  ok(!BAD.test(tt), 'the first-visit tour says "agent"', (tt.match(/.{0,60}tutor.{0,60}/i) || [])[0]);

  console.log('\nSource scan: wording a visitor sees later (error replies, offline messages, prompts)');
  const allowed = [/k12plus-tutor-(chat|subject|recents)/g, /tutor(First|Grade|Who)/g, /Use "learners" not "students"/g, /not "tutor"|never "tutor"/g];
  const files = ['index.html', 'about.html', 'contact.html', 'pricing.html', 'signup.html', 'app.html', 'k12plus-bridge.js', 'k12plus-syllabus.js', 'k12plus-arcade.js', 'k12plus-scenes.js', 'support.js', 'manifest.webmanifest'];
  const hits = [];
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // code comments
      let l = line; for (const a of allowed) l = l.replace(a, '');
      l = l.replace(/\/\/ .*$/, '');
      if (BAD.test(l)) hits.push(f + ':' + (i + 1) + ' ' + l.trim().slice(0, 100));
    });
  }
  ok(hits.length === 0, 'no "tutor" or "student" left in any text the app can show', hits);
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  ok(man.name === 'K12Plus - AI agents for Grades 8-12' && /Mathematics, Physical Science, Biology and Business Studies/.test(man.description), 'the installed app name says agents, with the STEM subjects first');
  const be = fs.readFileSync(path.join(ROOT, 'backend/index.js'), 'utf8');
  const edge = fs.readFileSync(path.join(ROOT, 'supabase/functions/aim/index.ts'), 'utf8');
  ok(/Kai, the AI Math Agent \(AIM\)/.test(be) && !/AI Math Tutor/.test(be) && !/You are the k12plus tutor/.test(be), 'the backend calls itself the AI Math Agent');
  ok(edge.includes('Kai, the AI Math Agent (AIM)') && !edge.includes('AI Math Tutor'), 'the Edge Function was rebuilt from the backend');

  console.log('\nNothing else broke');
  ok(errors.length === 0, 'no page errors', errors);

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
