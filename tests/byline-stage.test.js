'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { pickAuthorOption, stagedSummary, bylineLedgerDuplicate } = require('../src/byline-stage');
const paths = require('../src/paths');

const author = 'Jane Example Founder, Example Co';

test('pickAuthorOption matches exact normalized text, never partial or different-case text', () => {
  assert.equal(pickAuthorOption(['Another author', author], author), 1);
  assert.equal(pickAuthorOption([' Jane  Example\nFounder,\tExample Co '], ` ${author} `), 0);
  assert.equal(pickAuthorOption([`${author} Extra`, author.toLowerCase()], author), -1);
  assert.equal(pickAuthorOption([], author), -1);
});

test('stagedSummary reports mark counts and whether any submit button is enabled', () => {
  assert.equal(stagedSummary({ fix: 2, advice: 5, submitButtons: [{ text: 'Submit', disabled: false }] }),
    'Featured check: 2 must-fix, 5 advice. Submit enabled.');
  for (const submitButtons of [[], [{ text: 'Submit', disabled: true }]]) {
    assert.equal(stagedSummary({ fix: 0, advice: 1, submitButtons }), 'Featured check: 0 must-fix, 1 advice. Submit disabled.');
  }
  assert.match(stagedSummary({ fix: 0, advice: 0, submitButtons: [{ disabled: true }, { disabled: false }] }), /Submit enabled/);
});

test('bylineLedgerDuplicate requires the same seat, exact headline, and submitted status', () => {
  const row = { seat: 'example_co', headline: 'Maintain your plumbing', status: 'submitted' };
  assert.equal(bylineLedgerDuplicate([row], row.seat, row.headline), true);
  assert.equal(bylineLedgerDuplicate([], row.seat, row.headline), false);
  for (const changed of [{ seat: 'other_co' }, { headline: 'Another headline' }, { status: 'unverified' }, { status: 'submitted_inferred' }]) {
    assert.equal(bylineLedgerDuplicate([{ ...row, ...changed }], row.seat, row.headline), false);
  }
});

test('requiring byline-stage loads neither Playwright nor the browser and performs no CLI work', () => {
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('module');
    const original = Module._load;
    Module._load = function (request, ...args) {
      if (/playwright/i.test(request) || request === './browser' || request === './paths') {
        throw new Error('Unexpected side effect: ' + request);
      }
      return original.call(this, request, ...args);
    };
    require(${JSON.stringify(require.resolve('../src/byline-stage'))});
    assert.equal(Object.keys(require.cache).some((file) => /playwright/i.test(file)), false);
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

// Run the CLI entrypoint with isolated modules and a DOM fake. No session or browser is read or opened.
function offlineStage(t, scenario = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-byline-stage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'record.json');
  const record = {
    seat: 'example_co', status: 'passed', draft: {
      headline: 'Maintain your plumbing', subheading: 'A guide for homeowners.',
      bio_html: '<p>Founder at Example Co.</p>', article_html: '<p>Check your plumbing regularly.</p>',
    }, ...scenario.record,
  };
  paths.writeJsonAtomic(file, record);
  const seat = { key: 'example_co', byline: { authorOption: author } };
  const config = { baseUrl: 'https://www.connectively.us', seatsByKey: { example_co: { ...seat, ...scenario.seat } } };
  const ledgerFile = path.join(dir, 'bylines-submitted.jsonl');
  for (const row of scenario.rows || []) paths.appendJsonl(ledgerFile, row);
  const events = [];
  const output = [];
  let submitted = false;
  let polls = 0;
  const optionTexts = scenario.options || ['Jane Example Adviser, Example Co', ` ${author}\n`];
  let selected = '';
  const editors = [0, 1].map((index) => ({
    innerText: index === 1 ? 'Check your plumbing regularly.' : 'Founder at Example Co.',
    editor: scenario.missingEditor ? null : {
      chain() { return this; }, focus() { return this; },
      setContent(html, update) { events.push(['editor', index, html, update]); return this; }, run() {},
    },
  }));
  const buttons = () => scenario.noButton ? [] : [{
    innerText: 'Submit', disabled: submitted ? !scenario.stillEnabled : Boolean(scenario.disabled),
  }];
  const document = {
    body: { get innerText() { return submitted ? scenario.afterText ?? 'Thank you. Under review.' : 'Check for AI Complete'; } },
    querySelector(selector) {
      assert.equal(selector, 'main');
      polls += 1;
      return { innerText: scenario.pending || polls < 3 ? 'Check for AI Screening' : 'Check for AI Complete' };
    },
    querySelectorAll(selector) {
      if (selector === '.tiptap.ProseMirror') return editors;
      if (selector === '.tiptap.ProseMirror a') return [{ getAttribute(name) { assert.equal(name, 'href'); return 'https://example.com/'; } }];
      if (selector === '.fn-fix, .fn-span-fix') return [{ innerText: 'Fix this wording.' }, { innerText: 'Clarify this sentence.' }];
      if (selector === '.fn-advice, .fn-span-advice') return Array.from({ length: 14 }, () => ({ innerText: 'a'.repeat(200) }));
      if (selector === 'button') return buttons();
      assert.fail(`Unexpected DOM selector: ${selector}`);
    },
  };
  const page = {
    async setViewportSize(size) { events.push(['viewport', size]); },
    async goto(url, options) { events.push(['goto', url, options]); },
    url() { return config.baseUrl + (scenario.login ? '/login' : '/experts/bylined-articles'); },
    async waitForTimeout(ms) { events.push(['wait', ms]); },
    async click(selector) { events.push(['click', selector]); },
    async fill(selector, value) { events.push(['fill', selector, value]); },
    async screenshot(options) { events.push(['screenshot', options.path, options.fullPage]); },
    async evaluate(fn, args) {
      return vm.runInNewContext(`(${fn.toString()})(args)`, { document, args });
    },
    locator(selector, options) {
      if (selector === '[role="option"]') return {
        async count() { return optionTexts.length; },
        nth(index) { return {
          async innerText() { return optionTexts[index]; },
          async click() { selected = optionTexts[index]; events.push(['author', index]); },
        }; },
      };
      if (selector === 'button[role="combobox"]') return { async innerText() { return scenario.authorShown ?? selected; } };
      assert.equal(selector, 'button');
      assert.equal(String(options.hasText), '/^Submit/');
      return { first() { return {
        async count() { return buttons().length; },
        async isDisabled() { return buttons()[0].disabled; },
        async click() { submitted = true; events.push(['submit']); },
      }; } };
    },
  };
  const browser = { async close() { events.push(['close']); } };
  const browserTools = {
    async launchBrowser(options) { events.push(['launch', options]); return browser; },
    async newContext(given) { assert.equal(given, browser); return { async newPage() { return page; } }; },
    isLoginUrl: (url) => /\/login/.test(url),
    SessionExpiredError: class extends Error { constructor(message) { super(message); this.code = 'SESSION_EXPIRED'; } },
  };
  const fakeProcess = { argv: ['node', 'byline-stage.js', file, ...(scenario.args || [])], stdin: { isTTY: Boolean(scenario.tty) }, stdout: {} };
  const localRequire = (name) => {
    if (name === './paths') return { ...paths, DATA_DIR: dir, loadEnvFile() { events.push(['env']); } };
    if (name === './config') return { loadConfig: () => config };
    if (name === './browser') return browserTools;
    if (name === 'readline/promises') return { createInterface() { return {
      async question(text) { events.push(['confirm', text]); return scenario.answer; },
      close() { events.push(['input-close']); },
    }; } };
    assert.ok(['fs', 'path'].includes(name), `Unexpected import: ${name}`);
    return require(name);
  };
  const source = fs.readFileSync(require.resolve('../src/byline-stage'), 'utf8');
  const main = vm.runInNewContext(`${source}\nmain;`, {
    require: localRequire, module: { exports: {} }, process: fakeProcess,
    console: { log: (text) => output.push(text), error: (text) => output.push(text) },
  });
  return {
    events, output, record, dir, ledgerFile, process: fakeProcess, run: main,
    polls: () => polls,
    staged: () => {
      const shots = path.join(dir, 'shots');
      return paths.readJson(path.join(shots, fs.readdirSync(shots).find((name) => name.endsWith('.json'))));
    },
  };
}

test('offline staging selects the author, fills TipTap, polls, and saves the contract without submitting', async (t) => {
  const f = offlineStage(t);
  await f.run();
  assert.equal(f.polls(), 3);
  assert.deepEqual(f.events.filter(([event]) => event === 'editor'), [
    ['editor', 0, f.record.draft.bio_html, true], ['editor', 1, f.record.draft.article_html, true],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.events.find(([event]) => event === 'viewport'))), ['viewport', { width: 1600, height: 1400 }]);
  assert.equal(f.events.find(([event]) => event === 'goto')[1], 'https://www.connectively.us/experts/bylined-articles');
  assert.deepEqual(f.events.filter(([event]) => event === 'fill'), [
    ['fill', 'textarea[placeholder="Say what happened or what you learned"]', f.record.draft.headline],
    ['fill', 'textarea[placeholder="One or two sentences on what readers get"]', f.record.draft.subheading],
  ]);
  const staged = f.staged();
  assert.deepEqual(Object.keys(staged).sort(), ['author', 'before', 'checkPanel', 'headline', 'marks', 'screenshot', 'seat']);
  assert.equal(staged.author, author);
  assert.deepEqual(staged.before, { words: 4, links: ['https://example.com/'] });
  assert.equal(staged.marks.fix, 2);
  assert.equal(staged.marks.advice, 14);
  assert.equal(staged.marks.adviceText.length, 12);
  assert.equal(staged.marks.adviceText[0].length, 160);
  assert.match(staged.screenshot, /example_co-staged-.*\.png$/);
  assert.equal(staged.checkPanel, 'Check for AI Complete');
  assert.ok(f.events.some(([event, selector]) => event === 'click' && selector === 'button:has-text("Check for AI")'));
  assert.equal(f.events.some(([event]) => event === 'submit'), false);
  assert.equal(fs.existsSync(f.ledgerFile), false);
  assert.ok(f.output.includes('Staged only. Read the screenshot, then re-run with --submit.'));
  assert.equal(f.events.at(-1)[0], 'close');
});

test('offline stager rejects status, seat, flag, draft, and duplicate problems before browser launch', async (t) => {
  const scenarios = [
    { args: ['--allow-held', '--submit'] }, { args: ['--unknown'] },
    { record: { status: 'held' } }, { record: { status: 'declined' }, args: ['--allow-held'] },
    { record: { status: 'error' }, args: ['--allow-held'] }, { record: { draft: null } },
    { record: { seat: 'unknown' } }, { record: { seat: 'toString' } }, { seat: { byline: null } },
    { args: ['--submit', '--yes'], rows: [{ seat: 'example_co', headline: 'Maintain your plumbing', status: 'submitted' }] },
  ];
  for (const scenario of scenarios) {
    const f = offlineStage(t, scenario);
    await assert.rejects(f.run);
    assert.equal(f.events.some(([event]) => event === 'launch'), false);
  }
  const held = offlineStage(t, { args: ['--allow-held'], record: { status: 'held' } });
  await held.run();
  assert.equal(held.staged().seat, 'example_co');
  assert.equal(held.events.some(([event]) => event === 'submit'), false);
});

test('offline stager closes the browser on session, missing-author, author-verification, and editor failures', async (t) => {
  for (const [scenario, pattern] of [
    [{ login: true }, /Session expired\. Run: npm run login/],
    [{ options: ['Jane Example Adviser, Example Co'] }, /Options seen: Jane Example Adviser, Example Co/],
    [{ authorShown: 'Wrong author' }, /author shows/], [{ missingEditor: true }, /editor set failed/],
  ]) {
    const f = offlineStage(t, scenario);
    await assert.rejects(f.run, pattern);
    assert.equal(f.events.at(-1)[0], 'close');
    assert.equal(f.events.some(([event]) => event === 'submit'), false);
  }
});

test('offline submission refuses missing, disabled, or still-screening Submit with exit 3', async (t) => {
  for (const scenario of [{ noButton: true }, { disabled: true }, { pending: true }]) {
    const f = offlineStage(t, { ...scenario, args: ['--submit', '--yes'] });
    await f.run();
    assert.equal(f.process.exitCode, 3);
    assert.ok(f.output.includes("Featured's check did not unlock Submit"));
    assert.equal(f.events.some(([event]) => event === 'submit'), false);
    assert.equal(fs.existsSync(f.ledgerFile), false);
    if (scenario.pending) assert.equal(f.polls(), 80);
  }
});

test('offline submission requires a TTY and exact SUBMIT unless --yes is given', async (t) => {
  for (const scenario of [{}, { tty: true, answer: 'submit' }, { tty: true, answer: 'SUBMIT ' }]) {
    const f = offlineStage(t, { ...scenario, args: ['--submit'] });
    await assert.rejects(f.run, /Refusing to submit without confirmation/);
    assert.equal(f.events.some(([event]) => event === 'submit'), false);
    assert.equal(fs.existsSync(f.ledgerFile), false);
    assert.equal(f.events.at(-1)[0], 'close');
  }
  const f = offlineStage(t, { args: ['--submit'], tty: true, answer: 'SUBMIT' });
  await f.run();
  assert.equal(f.process.exitCode, 0);
  assert.equal(f.events.filter(([event]) => event === 'submit').length, 1);
  assert.ok(f.events.some(([event]) => event === 'input-close'));
});

test('offline submission records submitted only with success text and no enabled Submit', async (t) => {
  for (const [scenario, status] of [[{}, 'submitted'], [{ stillEnabled: true }, 'unverified'], [{ afterText: 'Please try again.' }, 'unverified']]) {
    const f = offlineStage(t, { ...scenario, args: ['--submit', '--yes'] });
    await f.run();
    const rows = paths.readJsonl(f.ledgerFile);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { at: rows[0].at, seat: 'example_co', headline: f.record.draft.headline, status });
    assert.ok(Number.isFinite(Date.parse(rows[0].at)));
    assert.equal(f.process.exitCode, status === 'submitted' ? 0 : 3);
    assert.ok(f.events.some(([event, ms]) => event === 'wait' && ms === 5000));
    assert.ok(f.events.some(([event, file, fullPage]) => event === 'screenshot' && /example_co-submitted-.*\.png$/.test(file) && fullPage));
    assert.ok(f.output.some((text) => text.startsWith(`${status}. Screenshot:`)));
    assert.equal(f.events.at(-1)[0], 'close');
  }
});
