/**
 * UI smoke test: logs in through the real login form (encrypted payload),
 * visits each page and saves screenshots + console errors to tmp/ui/.
 * Usage: node tests/ui/screenshots.js [path ...]
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const BASE = process.env.UI_BASE_URL || 'http://localhost:5173';
const OUT = path.resolve('tmp/ui');
const EMAIL = 'e2e-studio@example.com';
const PASSWORD = 'E2e-Studio-Pass-123';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1600, height: 960 } });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

  // Prefer the cached e2e access token (skips the login rate limit); fall back to the form.
  const cached = path.resolve('tmp/e2e-token.json');
  if (fs.existsSync(cached)) {
    const { token } = JSON.parse(fs.readFileSync(cached, 'utf8'));
    await page.evaluateOnNewDocument((t) => {
      localStorage.setItem('ams-auth', JSON.stringify({ state: { user: { id: 'e2e', email: 'e2e-studio@example.com', name: 'E2E' }, accessToken: t, refreshToken: '' }, version: 0 }));
    }, token);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 800));
    if (page.url().includes('/login')) {
      await page.type('input[type=email]', EMAIL);
      await page.type('input[type=password]', PASSWORD);
      await page.click('button[type=submit]');
      await page.waitForFunction(() => location.pathname !== '/login', { timeout: 20000 });
      await new Promise((r) => setTimeout(r, 800));
    }
  } else {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.type('input[type=email]', EMAIL);
    await page.type('input[type=password]', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForFunction(() => location.pathname !== '/login', { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 800));
  }

  const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['/', '/library', '/pdf', '/renders'];
  for (const t of targets) {
    await page.goto(`${BASE}${t}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));
    const name = (t.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'dashboard') + '.png';
    await page.screenshot({ path: path.join(OUT, name) });
    console.log('saved', name);
  }
  fs.writeFileSync(path.join(OUT, 'errors.txt'), errors.join('\n'));
  console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
