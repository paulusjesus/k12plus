const { chromium } = require('playwright');
const path = require('path');
const local = { 'react@18.3.1/umd/react.production.min.js': 'node_modules/react/umd/react.production.min.js', 'react-dom@18.3.1/umd/react-dom.production.min.js': 'node_modules/react-dom/umd/react-dom.production.min.js', '@babel/standalone@7.29.0/babel.min.js': 'node_modules/@babel/standalone/babel.min.js' };
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://unpkg.com/**', (r) => { const k = Object.keys(local).find((x) => r.request().url().includes(x)); return k ? r.fulfill({ path: path.join(process.env.VENDOR_DIR || __dirname, local[k]), contentType: 'application/javascript' }) : r.abort(); });
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' })); await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
  let revoked = null;
  await page.route('https://uwqbjjzjdnjlbicxrwnp.supabase.co/**', (r) => {
    const u = r.request().url();
    if (u.includes('/auth/v1/logout')) { revoked = r.request().headers()['authorization']; return r.fulfill({ status: 204, body: '' }); }
    return r.fulfill({ json: u.includes('pilot_whoami') ? { signed_in: true } : [] });
  });
  await page.goto('http://127.0.0.1:8765/app.html');
  const tok = 'h.' + Buffer.from(JSON.stringify({ exp: 9999999999, sub: 'u1' })).toString('base64') + '.s';
  await page.evaluate((t) => { localStorage.setItem('k12plus-session', JSON.stringify({ access_token: t, refresh_token: 'r', user_id: 'u1' })); localStorage.setItem('k12plus-loggedin', '1'); localStorage.setItem('k12plus-role', 'Educator'); localStorage.setItem('k12plus-name', 'Ms Teacher'); }, tok);
  await page.reload(); await page.waitForTimeout(2500);
  // open the profile panel from the account card and press Sign out
  console.log('page:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160));
  await page.locator('aside button', { hasText: 'Ms Amukoto' }).first().click();
  await page.waitForTimeout(500);
  const link = page.locator('a:has-text("Sign out")');
  console.log('sign-out link visible:', await link.count() > 0);
  await Promise.all([page.waitForURL('**/index.html', { timeout: 8000 }).catch(() => {}), link.first().click()]);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({ session: localStorage.getItem('k12plus-session'), loggedIn: localStorage.getItem('k12plus-loggedin') }));
  console.log('after sign-out:', JSON.stringify(after), '| server asked to cancel session:', !!revoked && revoked.endsWith(tok), '| landed on', page.url().split('/').pop(), '| errors', errors.length);
  await browser.close();
})();
