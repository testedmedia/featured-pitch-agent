'use strict';

const fs = require('fs');
const { STATE_FILE } = require('./paths');

const SYSTEM_CHROMIUM_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function getChromium() {
  try {
    return require('playwright').chromium;
  } catch {
    throw new Error('Playwright is not installed. Run: npm install && npx playwright install chromium');
  }
}

function resolveExecutable({ env = process.env, existsSync = fs.existsSync, chromium = null } = {}) {
  const candidates = [];
  if (env.FEATURED_CHROMIUM_EXECUTABLE) candidates.push(env.FEATURED_CHROMIUM_EXECUTABLE.trim());
  try {
    if (chromium && typeof chromium.executablePath === 'function') candidates.push(chromium.executablePath());
  } catch {
    // A missing bundled browser must not prevent using a system installation.
  }
  candidates.push(...SYSTEM_CHROMIUM_PATHS);
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

function installBrowserCrashGuard() {
  if (process.__featuredBrowserCrashGuardInstalled) return;
  process.__featuredBrowserCrashGuardInstalled = true;
  process.on('unhandledRejection', (err) => {
    const message = (err && err.message) || String(err);
    // Playwright launch cleanup can reject while force-killing its own browser process.
    if (/kill EPERM/.test(message)) return;
    console.error(err);
    process.exit(1);
  });
}

async function launchBrowser({ headless = true } = {}) {
  const chromium = getChromium();
  const executablePath = resolveExecutable({ chromium });
  if (!executablePath) {
    throw new Error('No Chromium executable found. Install Google Chrome or set FEATURED_CHROMIUM_EXECUTABLE to an existing browser path.');
  }
  installBrowserCrashGuard();
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let timer;
    let timedOut = false;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('chromium.launch timed out after 45000ms'));
        }, 45000);
      });
      const launch = chromium.launch({ headless, executablePath, timeout: 45000 }).then(async (browser) => {
        // A late launch must not leave an orphan browser after the outer timeout.
        if (timedOut) await browser.close();
        return browser;
      });
      return await Promise.race([launch, timeout]);
    } catch (err) {
      lastError = err;
      console.error(`[featured-browser-guard] launch attempt ${attempt}/3 failed: ${(err && err.message) || err}`);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`featured chromium launch failed after 3 attempts: ${(lastError && lastError.message) || lastError}`);
}

async function newContext(browser, { stateFile = STATE_FILE, requireState = true } = {}) {
  const hasState = fs.existsSync(stateFile);
  if (requireState && !hasState) throw new Error('No saved Featured session. Run: npm run login');
  return browser.newContext({
    ...(hasState ? { storageState: stateFile } : {}),
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });
}

function isLoginUrl(url) {
  return /\/login|\/sign_in|\/signin/i.test(url);
}

class SessionExpiredError extends Error {
  constructor(message = 'Featured session expired. Run: npm run login') {
    super(message);
    this.name = 'SessionExpiredError';
    this.code = 'SESSION_EXPIRED';
  }
}

module.exports = { getChromium, resolveExecutable, launchBrowser, newContext, isLoginUrl, SessionExpiredError };
