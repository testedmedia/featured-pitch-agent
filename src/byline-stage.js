'use strict';

const fs = require('fs');
const path = require('path');

const normalizeSpace = (value) => value.replace(/\s+/g, ' ').trim();

function pickAuthorOption(optionTexts, wanted) {
  return optionTexts.findIndex((text) => normalizeSpace(text) === normalizeSpace(wanted));
}

function stagedSummary(marks) {
  const enabled = marks.submitButtons.some((button) => !button.disabled);
  return `Featured check: ${marks.fix} must-fix, ${marks.advice} advice. Submit ${enabled ? 'enabled' : 'disabled'}.`;
}

function bylineLedgerDuplicate(rows, seat, headline) {
  return rows.some((row) => row.seat === seat && row.headline === headline && row.status === 'submitted');
}

async function main() {
  require('./paths').loadEnvFile();
  const args = process.argv.slice(2);
  const file = args.shift();
  if (!file || file.startsWith('--') || args.some((arg) => !['--submit', '--allow-held', '--yes'].includes(arg))) {
    throw new Error('Usage: node src/byline-stage.js <record.json> [--submit] [--allow-held] [--yes]');
  }
  const submit = args.includes('--submit');
  const allowHeld = args.includes('--allow-held');
  if (allowHeld && submit) throw new Error('--allow-held cannot be combined with --submit');
  const { DATA_DIR, readJson, readJsonl, appendJsonl, writeJsonAtomic } = require('./paths');
  const config = require('./config').loadConfig();
  const record = readJson(file);
  const seat = Object.hasOwn(config.seatsByKey, record.seat) ? config.seatsByKey[record.seat] : null;
  if (!seat || !seat.byline) throw new Error(`Seat missing or byline disabled: ${record.seat}`);
  if (record.status !== 'passed' && !(allowHeld && record.status === 'held' && record.draft)) {
    throw new Error(`draft status is ${record.status}, not passed`);
  }
  const { draft } = record;
  if (!draft || typeof draft.headline !== 'string' || !draft.headline.trim()
    || typeof draft.bio_html !== 'string' || typeof draft.article_html !== 'string') {
    throw new Error('Record must contain a headline, bio_html, and article_html');
  }
  const ledgerFile = path.join(DATA_DIR, 'bylines-submitted.jsonl');
  if (submit && bylineLedgerDuplicate(readJsonl(ledgerFile), seat.key, draft.headline)) {
    throw new Error('This seat and headline are already submitted in the byline ledger');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shotDir = path.join(path.dirname(path.resolve(file)), 'shots');
  fs.mkdirSync(shotDir, { recursive: true });

  const { launchBrowser, newContext, isLoginUrl, SessionExpiredError } = require('./browser');
  const browser = await launchBrowser({ headless: true });
  try {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1600, height: 1400 });
    await page.goto(`${config.baseUrl}/experts/bylined-articles`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);
    if (isLoginUrl(page.url())) throw new SessionExpiredError('Session expired. Run: npm run login');

    // Pick and verify the exact author before writing either editor.
    const wanted = seat.byline.authorOption;
    await page.click('button[role="combobox"]');
    await page.waitForTimeout(800);
    const options = page.locator('[role="option"]');
    const optionTexts = [];
    for (let index = 0; index < await options.count(); index += 1) {
      optionTexts.push(await options.nth(index).innerText());
    }
    const picked = pickAuthorOption(optionTexts, wanted);
    if (picked === -1) throw new Error(`author option not found: ${wanted}. Options seen: ${optionTexts.map(normalizeSpace).join(' | ')}`);
    await options.nth(picked).click();
    await page.waitForTimeout(2000);
    const authorShown = normalizeSpace(await page.locator('button[role="combobox"]').innerText());
    if (authorShown !== normalizeSpace(wanted)) throw new Error(`author shows "${authorShown}", wanted "${wanted}"`);

    // Bio first, article second, through the TipTap editor instance on each element.
    const setEditor = (index, html) => page.evaluate(([i, h]) => {
      const el = document.querySelectorAll('.tiptap.ProseMirror')[i];
      if (!el || !el.editor) return 'no editor instance';
      el.editor.chain().focus().setContent(h, true).run();
      return 'ok';
    }, [index, html]);
    const bioResult = await setEditor(0, draft.bio_html);
    const articleResult = await setEditor(1, draft.article_html);
    if (bioResult !== 'ok' || articleResult !== 'ok') throw new Error(`editor set failed: bio ${bioResult}, article ${articleResult}`);
    await page.fill('textarea[placeholder="Say what happened or what you learned"]', draft.headline);
    await page.fill('textarea[placeholder="One or two sentences on what readers get"]', draft.subheading || '');
    await page.waitForTimeout(3000);
    const before = await page.evaluate(() => ({
      words: (document.querySelectorAll('.tiptap.ProseMirror')[1].innerText.match(/\S+/g) || []).length,
      links: Array.from(document.querySelectorAll('.tiptap.ProseMirror a')).map((a) => a.getAttribute('href')),
    }));

    await page.click('button:has-text("Check for AI")');
    let result = '';
    for (let index = 0; index < 80; index += 1) {
      await page.waitForTimeout(3000);
      result = await page.evaluate(() => (document.querySelector('main') || document.body).innerText);
      if (index >= 2 && !/Screening|Checking/i.test(result)) break;
    }
    const marks = await page.evaluate(() => ({
      fix: document.querySelectorAll('.fn-fix, .fn-span-fix').length,
      advice: document.querySelectorAll('.fn-advice, .fn-span-advice').length,
      fixText: Array.from(document.querySelectorAll('.fn-fix, .fn-span-fix')).map((el) => el.innerText.slice(0, 160)).slice(0, 12),
      adviceText: Array.from(document.querySelectorAll('.fn-advice, .fn-span-advice')).map((el) => el.innerText.slice(0, 160)).slice(0, 12),
      submitButtons: Array.from(document.querySelectorAll('button')).filter((button) => /^submit/i.test((button.innerText || '').trim())).map((button) => ({ text: button.innerText.trim(), disabled: button.disabled })),
    }));
    const screenshot = path.join(shotDir, `${seat.key}-staged-${stamp}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    const panel = result.replace(/\s+/g, ' ');
    const index = panel.search(/Check for AI/i);
    const out = {
      seat: seat.key, author: authorShown, headline: draft.headline, before, marks,
      checkPanel: panel.slice(Math.max(0, index - 200), index + 1500), screenshot,
    };
    writeJsonAtomic(path.join(shotDir, `${seat.key}-staged-${stamp}.json`), out);
    console.log(stagedSummary(marks));
    console.log(`Screenshot: ${screenshot}`);
    if (!submit) {
      console.log('Staged only. Read the screenshot, then re-run with --submit.');
      return;
    }

    const button = page.locator('button', { hasText: /^Submit/ }).first();
    if (/Screening|Checking/i.test(result) || !(await button.count()) || await button.isDisabled()) {
      process.exitCode = 3;
      console.error("Featured's check did not unlock Submit");
      return;
    }
    if (!args.includes('--yes')) {
      const refusal = 'Refusing to submit without confirmation. Re-run with --yes after reviewing the staged screenshot.';
      if (!process.stdin.isTTY) throw new Error(refusal);
      const readline = require('readline/promises');
      const input = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        if (await input.question('Type SUBMIT to submit this article: ') !== 'SUBMIT') throw new Error(refusal);
      } finally {
        input.close();
      }
    }
    await button.click();
    await page.waitForTimeout(5000);
    const submittedShot = path.join(shotDir, `${seat.key}-submitted-${stamp}.png`);
    await page.screenshot({ path: submittedShot, fullPage: true });
    const after = await page.evaluate(() => ({
      text: document.body.innerText,
      enabledSubmit: Array.from(document.querySelectorAll('button')).some((el) => /^submit/i.test((el.innerText || '').trim()) && !el.disabled),
    }));
    const status = /submitted|under review|thank|received/i.test(after.text) && !after.enabledSubmit ? 'submitted' : 'unverified';
    appendJsonl(ledgerFile, { at: new Date().toISOString(), seat: seat.key, headline: draft.headline, status });
    console.log(`${status}. Screenshot: ${submittedShot}`);
    process.exitCode = status === 'submitted' ? 0 : 3;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(e.code === 'SESSION_EXPIRED' ? 2 : 1); });
}

module.exports = { pickAuthorOption, stagedSummary, bylineLedgerDuplicate };
