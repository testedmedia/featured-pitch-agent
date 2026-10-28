'use strict';

const fs = require('fs');
const path = require('path');


async function saveFailure(page) {
  const { DATA_DIR } = require('./paths');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'login-failed.png');
  await page.screenshot({ path: file, fullPage: true });
  console.error(`Login verification failed. Screenshot: ${file}`);
}

async function verifySession(context, config) {
  const { isLoginUrl } = require('./browser');
  const page = await context.newPage();
  try {
    let verified = false;
    try {
      await page.goto(`${config.baseUrl}/experts/questions`, {
        waitUntil: 'networkidle', timeout: 60000,
      });
      const body = await page.locator('body').innerText();
      verified = !isLoginUrl(page.url()) && /Deadline|Domain Authority|\bDA\b|Questions/i.test(body);
    } catch {
      // Navigation failures cannot prove that the saved session is usable.
    }
    if (!verified) await saveFailure(page);
    return verified;
  } finally {
    await page.close();
  }
}

async function main() {
  const { STATE_FILE, loadEnvFile } = require('./paths');
  loadEnvFile();
  const manual = process.argv.includes('--manual');
  if (!manual) {
    if (!process.env.FEATURED_EMAIL || !process.env.FEATURED_PASSWORD) {
      console.error('Set FEATURED_EMAIL and FEATURED_PASSWORD in the environment or in AGENT_HOME/.env, or use --manual.');
      process.exitCode = 1;
      return;
    }
  }
  const config = require('./config').loadConfig();
  const { launchBrowser, newContext, isLoginUrl } = require('./browser');
  const browser = await launchBrowser({ headless: !manual });
  try {
    const context = await newContext(browser, { requireState: false });
    const page = await context.newPage();
    await page.goto(`${config.baseUrl}/login`, { waitUntil: 'networkidle', timeout: 60000 });
    let leftLogin = false;
    if (manual) {
      console.log('Log in in the browser window. This waits up to 10 minutes.');
      const deadline = Date.now() + 10 * 60 * 1000;
      while (isLoginUrl(page.url()) && Date.now() < deadline) {
        await page.waitForTimeout(2000);
      }
      leftLogin = !isLoginUrl(page.url());
    } else {
      const dismiss = page.locator('button:has-text("Got it, let")').first();
      const visible = await dismiss.waitFor({ state: 'visible', timeout: 6000 })
        .then(() => true).catch(() => false);
      if (visible) {
        await dismiss.click();
        await page.waitForTimeout(1500);
      }
      await page.waitForFunction(() => {
        return document.querySelectorAll('[data-state="open"][aria-hidden="true"]').length === 0;
      }, null, { timeout: 8000 }).catch(() => {});
      await page.locator('input[name="email"]').fill(process.env.FEATURED_EMAIL);
      await page.locator('input[name="password"]').fill(process.env.FEATURED_PASSWORD);
      await page.locator('form button[type="submit"]', { hasText: 'Submit' }).first().click();
      leftLogin = await page.waitForURL((url) => !isLoginUrl(url.toString()), { timeout: 25000 })
        .then(() => true).catch(() => false);
    }
    if (!leftLogin) {
      await saveFailure(page);
      process.exitCode = 2;
      return;
    }
    if (!await verifySession(context, config)) {
      process.exitCode = 2;
      return;
    }
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    await context.storageState({ path: STATE_FILE });
    fs.chmodSync(STATE_FILE, 0o600);
    console.log('Session saved.');
  } finally {
    await browser.close();
  }
}

module.exports = { verifySession };

if (require.main === module) {
  main().catch((e) => {
    // Browser errors can echo form values, so mask the credentials before printing anything.
    let message = String((e && e.message) || e);
    for (const secret of [process.env.FEATURED_PASSWORD, process.env.FEATURED_EMAIL]) {
      if (secret) message = message.split(secret).join('***');
    }
    console.error(`Login failed: ${message.split('\n')[0]}`);
    console.error('Check .env and try again, or use: npm run login -- --manual');
    process.exit(1);
  });
}
