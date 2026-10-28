'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveExecutable, newContext, isLoginUrl, SessionExpiredError } = require('../src/browser');

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-browser-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('executable resolution prefers the existing environment path', () => {
  assert.equal(resolveExecutable({ env: { FEATURED_CHROMIUM_EXECUTABLE: ' custom-chrome ' },
    chromium: { executablePath: () => 'bundled-chrome' }, existsSync: () => true }), 'custom-chrome');
});

test('executable resolution prefers bundled Chromium over system browsers', () => {
  assert.equal(resolveExecutable({ env: { FEATURED_CHROMIUM_EXECUTABLE: 'missing' },
    chromium: { executablePath: () => 'bundled-chrome' },
    existsSync: (candidate) => candidate !== 'missing' }), 'bundled-chrome');
});

test('executable resolution falls back to the system list and tolerates bundle errors', () => {
  for (const candidate of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    assert.equal(resolveExecutable({ env: {}, existsSync: (file) => file === candidate,
      chromium: { executablePath() { throw new Error('No bundle'); } } }), candidate);
  }
  assert.equal(resolveExecutable({ env: {}, existsSync: () => false }), null);
});

test('login URL recognition and session expiration errors match the contract', () => {
  for (const suffix of ['/login', '/sign_in', '/signin', '/LOGIN?next=questions']) {
    assert.equal(isLoginUrl(`https://www.connectively.us${suffix}`), true);
  }
  assert.equal(isLoginUrl('https://www.connectively.us/experts/questions'), false);
  assert.equal(isLoginUrl(''), false);
  const error = new SessionExpiredError('Please log in again');
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'SESSION_EXPIRED');
  assert.equal(error.name, 'SessionExpiredError');
  assert.equal(error.message, 'Please log in again');
});

test('missing required session rejects before touching the browser', async (t) => {
  const browser = { get newContext() { assert.fail('Browser must not be touched'); } };
  await assert.rejects(newContext(browser, { stateFile: path.join(sandbox(t), 'missing.json') }),
    { message: 'No saved Featured session. Run: npm run login' });
});

test('contexts use saved state when present and normal desktop options', async (t) => {
  const stateFile = path.join(sandbox(t), 'state.json');
  const calls = [];
  const context = {};
  const browser = { async newContext(options) { calls.push(options); return context; } };
  assert.equal(await newContext(browser, { stateFile, requireState: false }), context);
  assert.equal(Object.hasOwn(calls[0], 'storageState'), false);
  fs.writeFileSync(stateFile, '{}');
  assert.equal(await newContext(browser, { stateFile }), context);
  assert.deepEqual(calls[1].viewport, { width: 1440, height: 900 });
  assert.equal(calls[1].locale, 'en-US');
  assert.match(calls[1].userAgent, /Mozilla\/5\.0 .*Chrome\/.*Safari\//);
  assert.equal(calls[1].storageState, stateFile);
  assert.deepEqual(Object.keys(calls[1]).sort(), ['locale', 'storageState', 'userAgent', 'viewport']);
});

test('requiring browser does not load Playwright or install global handlers', () => {
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('module');
    const original = Module._load;
    let attempts = 0;
    Module._load = function (request, ...args) {
      if (/playwright/i.test(request)) { attempts += 1; throw new Error('Not installed'); }
      return original.call(this, request, ...args);
    };
    const handlers = process.listenerCount('unhandledRejection');
    const browser = require(${JSON.stringify(require.resolve('../src/browser'))});
    assert.equal(attempts, 0);
    assert.equal(Object.keys(require.cache).some((file) => /playwright/i.test(file)), false);
    assert.equal(process.listenerCount('unhandledRejection'), handlers);
    assert.throws(() => browser.getChromium(), {
      message: 'Playwright is not installed. Run: npm install && npx playwright install chromium'
    });
    assert.equal(attempts, 1);
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
