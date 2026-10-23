// Item 13: data use stays small, and the phone's own data counter tells the truth.
// Runs item13.measure.js (the real site in Chromium behind an HTTPS stand-in for every
// server) and checks the figures against limits well below the pilot budget, then
// checks the service worker set-up that keeps them low.
// Usage: TLS_DIR=<folder with key.pem, cert.pem and home/.pki/nssdb> node item13.test.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };

console.log('\nService worker set-up');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const pre = JSON.parse(sw.match(/var PRECACHE = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
const scriptsOf = (f) => [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/<script src="\.?\/?([^"]+)"/g)].map((m) => '/' + m[1]);
const pageScripts = [...new Set([...scriptsOf('app.html'), ...scriptsOf('index.html')])];
ok(pageScripts.every((s) => pre.includes(s)), 'every script the app and homepage load is saved at install under the same address (no double downloads)', pageScripts.filter((s) => !pre.includes(s)));
ok(pre.filter((u) => /\.js$/.test(u)).length === 0, 'no unversioned copy of a script is saved as well', pre.filter((u) => /\.js$/.test(u)));
ok(pre.every((u) => fs.existsSync(path.join(ROOT, u.split('?')[0]))), 'every saved file exists');
ok(!pre.includes('/about.html') && !pre.includes('/pricing.html') && !pre.includes('/contact.html') && !pre.includes('/'), 'marketing pages and a second copy of the homepage are not downloaded in advance');
const logo = fs.statSync(path.join(ROOT, 'assets/k12plus-logo-128.png')).size;
ok(logo < 10000, 'the logo the pages show is small (' + logo + ' bytes, was 59,853)');
ok(['index.html', 'about.html', 'contact.html', 'pricing.html', 'signup.html', 'app.html'].every((f) => !/src="assets\/k12plus-logo\.png"/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))), 'no page shows the large logo any more');
ok(fs.existsSync(path.join(ROOT, 'assets/k12plus-logo.png')), 'the large logo stays available for anything outside the site that links to it');
ok(/new Response\(null, \{ status: 204 \}\)/.test(sw), 'placeholder image addresses are answered on the phone');

console.log('\nMeasured on the real site (HTTP/2, brotli, the live caching rules)');
execFileSync(process.execPath, [path.join(__dirname, 'item13.measure.js'), 'test'], { env: { ...process.env, SHOT_DIR: process.env.SHOT_DIR || __dirname }, stdio: ['ignore', 'ignore', 'inherit'], timeout: 900000 });
const m = JSON.parse(fs.readFileSync(path.join(process.env.SHOT_DIR || __dirname, 'item13-test.json'), 'utf8'));
const first = m.firstVisitHome.totalKB + m.firstOpenApp.totalKB;
ok(first < 400, 'first visit (homepage, app installed for offline use, then the app opened): ' + first.toFixed(0) + ' KB, under 400 KB', m.firstVisitHome.biggest);
ok(m.returnVisit.totalKB < 25, 'return visit: ' + m.returnVisit.totalKB + ' KB, under 25 KB (unchanged files are only checked, not downloaded)', m.returnVisit.biggest);
ok(m.session12Questions.aiCalls === 12 && m.session12Questions.totalKB < 150, '12 questions to the AI Math Agent: ' + m.session12Questions.totalKB + ' KB, under 150 KB', m.session12Questions);
ok(m.eightMoreQuestions.aiCalls === 8 && Math.max(...m.eightMoreQuestions.questionUploadKB) < 16, 'in a long chat each question sends at most what the agent reads (largest ' + Math.max(...m.eightMoreQuestions.questionUploadKB) + ' KB)', m.eightMoreQuestions.questionUploadKB);
ok(m.onePhotoQuestion.totalKB < 250, 'one photo question: ' + m.onePhotoQuestion.totalKB + ' KB, under 250 KB');
ok(m.opensOffline === true, 'the app opens with the network off');
ok(!m.returnVisit.biggest.some((b) => /\{\{/.test(b)), 'no placeholder image requests reach the server', m.returnVisit.biggest);
ok(m.firstVisitHome.secondsUntilReadySlow3G < 8, 'on a slow 3G connection the homepage is ready to type in after ' + m.firstVisitHome.secondsUntilReadySlow3G + ' s');

console.log('\nThe phone\'s own data counter (sent by pilot learners\' phones for the data-cost report)');
const sess = m.session12Questions.phoneCounterKBSincePageOpened - m.returnVisit.phoneCounterKB;
ok(m.returnVisit.phoneCounterKB <= m.returnVisit.totalKB * 1.5, 'a return visit is no longer counted as the full size of the app (' + m.returnVisit.phoneCounterKB + ' KB counted, ' + m.returnVisit.totalKB + ' KB used; was 889 KB)');
ok(Math.abs(sess - m.session12Questions.totalKB) / m.session12Questions.totalKB < 0.25, 'a session is counted within 25% (' + sess.toFixed(1) + ' KB counted, ' + m.session12Questions.totalKB + ' KB used)');
ok(m.firstVisitHome.phoneCounterKB > m.firstVisitHome.totalKB * 0.5 && m.firstVisitHome.phoneCounterKB <= m.firstVisitHome.totalKB * 1.2, 'a first visit is counted within the right range (' + m.firstVisitHome.phoneCounterKB + ' KB counted, ' + m.firstVisitHome.totalKB + ' KB used)');
ok(m.errors.length === 0, 'no page errors', m.errors);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
