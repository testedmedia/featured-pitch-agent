'use strict';

const fs = require('fs');
const path = require('path');

// Refusal text outranks HTTP 200 responses and success text elsewhere on the page.
const SUBMIT_FAILURE_PATTERNS = [
  /used up all your seats/i,
  /add credits or more seats/i,
  /no (?:seats|credits) (?:remaining|left|available)/i,
  /out of (?:seats|credits)/i,
  /(?:upgrade|purchase) (?:your plan|a plan|more) to (?:submit|answer)/i,
  /you (?:cannot|can't) submit/i,
  /(?:answer|submission) (?:failed|was not submitted|could not be submitted)/i,
];

function readPitchedCount(bodyText) {
  const match = /Pitched\s*([\d,]+)/.exec(bodyText || '');
  if (!match) return null;
  const value = parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(value) ? value : null;
}

function inspectComposerState(bodyText) {
  const body = String(bodyText || '');
  const match = /Characters:\s*(\d+)\s*\/\s*2500/.exec(body);
  const profileStripReady = /Add New Profile|Edit Profile|Profile \(Answer attributed to\)/i.test(body);
  if (!match || !profileStripReady) return { status: 'unreadable', count: null };
  const count = parseInt(match[1], 10);
  if (!Number.isFinite(count)) return { status: 'unreadable', count: null };
  return { status: count > 0 ? 'already_answered' : 'fresh', count };
}

// The answer page names the profile the answer goes out under: "Profile (Answer attributed to):\n<Name>\n<Title>".
function readAttributedProfile(bodyText) {
  const match = /Profile \(Answer attributed to\):\s*\n\s*([^\n]+)\n\s*([^\n]*)/.exec(String(bodyText || ''));
  return match ? { name: match[1].trim(), title: match[2].trim() } : null;
}

function ledgerKey(url, profileId) {
  return `${url.split('?')[0]}__${profileId}`;
}

function presubmitRejection(item, config, ledgerRows) {
  const seat = Object.prototype.hasOwnProperty.call(config.seatsByKey, item.seatKey)
    ? config.seatsByKey[item.seatKey] : null;
  if (!seat || !seat.enabled) {
    return { status: 'reject_unknown_seat', detail: 'Seat is missing or disabled.' };
  }
  if (item.profileId !== seat.profileId) {
    return { status: 'reject_profile_mismatch', detail: 'Profile does not match the configured seat.' };
  }
  if (typeof item.pitch_body !== 'string' || !item.pitch_body.trim()) {
    return { status: 'reject_missing_body', detail: 'Pitch body is empty.' };
  }
  const fails = require('./preflight').preflight(item.pitch_body, seat, config);
  if (fails.length) return { status: 'reject_preflight', detail: fails.join('; ') };
  if (ledgerRows.some((row) => ['submitted', 'submitted_inferred'].includes(row.status)
    && ledgerKey(row.url, row.profileId) === ledgerKey(item.url, item.profileId))) {
    return { status: 'skip_ledger_duplicate', detail: 'This question and profile are already in the submission ledger.' };
  }
  return null;
}

function classifyPostSubmit({ postBody, pitchedBefore, pitchedAfter, responseOk, storedAfterReload }) {
  const successHints = /\b(thank|submitted|pitched|your answer has been|under review|answer recorded|response submitted|in review)\b/i.test(postBody);
  const stillShowsAnswerBtn = /Submit Answer|Submit answer/i.test(postBody);
  const failureHit = SUBMIT_FAILURE_PATTERNS.find((re) => re.test(postBody));
  const counterMoved = pitchedBefore != null && pitchedAfter != null && pitchedAfter > pitchedBefore;
  const counterStuck = pitchedBefore != null && pitchedAfter != null && pitchedAfter === pitchedBefore;
  if (failureHit) return 'reject_platform_refused';
  if (counterMoved) return 'submitted';
  if (counterStuck && storedAfterReload) return 'submitted';
  if (counterStuck) return 'unverified';
  if (responseOk && successHints) return 'submitted_inferred';
  if (successHints && !stillShowsAnswerBtn) return 'submitted_inferred';
  return 'unverified';
}

async function answerIsStoredForProfile(page) {
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const body = await page.evaluate(() => document.body.innerText || '');
      const counter = /Characters:\s*(\d+)\s*\/\s*2500/.exec(body);
      const profileStrip = /Add New Profile|Edit Profile|Profile \(Answer attributed to\)/i.test(body);
      if (counter && profileStrip) return parseInt(counter[1], 10) > 0;
      await page.waitForTimeout(500);
    }
  } catch (_) {
    return false;
  }
  return false;
}

async function findFirstWorking(page, candidates, action = 'click', value = null) {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) {
      try {
        if (action === 'click') await loc.click({ timeout: 5000 });
        else if (action === 'fill') await loc.fill(value || '', { timeout: 5000 });
        return sel;
      } catch (_) { continue; }
    }
  }
  return null;
}

async function submitOne(context, item, config, live, runDir, outcome) {
  const { isLoginUrl } = require('./browser');
  const { buildAnswerUrl } = require('./dedupe');
  const page = await context.newPage();
  try {
    await page.goto(buildAnswerUrl(item.url, item.profileId), { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (isLoginUrl(page.url())) {
      outcome.status = 'error_session_expired';
      outcome.detail = 'Browser session has expired.';
      return;
    }
    await page.waitForSelector('textarea', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);

    let earlyBody = '';
    let composerState = { status: 'unreadable', count: null };
    const readyDeadline = Date.now() + 10000;
    while (Date.now() < readyDeadline) {
      earlyBody = await page.evaluate(() => document.body.innerText || '');
      composerState = inspectComposerState(earlyBody);
      if (composerState.status !== 'unreadable') break;
      await page.waitForTimeout(500);
    }
    if (isLoginUrl(page.url())) {
      outcome.status = 'error_session_expired';
      outcome.detail = 'Browser session has expired.';
      return;
    }
    if (composerState.status === 'unreadable') {
      outcome.status = 'error_preflight_unreadable';
      outcome.detail = 'Composer readiness was not proven before submit.';
      return;
    }
    if (composerState.status === 'already_answered') {
      outcome.status = 'skip_already_answered';
      return;
    }
    if (/unlock more placements|answers? remaining/i.test(earlyBody)) {
      outcome.status = 'held_plan_limit';
      outcome.detail = 'The platform plan limit blocks submission.';
      return;
    }
    const seat = config.seatsByKey[item.seatKey];
    // Exact match on the attributed profile when the page prints it; older pages only show the name somewhere.
    const attributed = readAttributedProfile(earlyBody);
    const bylineOk = Boolean(seat.displayName) && (attributed ? attributed.name === seat.displayName : earlyBody.includes(seat.displayName));
    if (!bylineOk) {
      outcome.status = 'reject_byline_not_visible';
      outcome.detail = attributed
        ? `Page attributes the answer to "${attributed.name}", expected "${seat.displayName}".`
        : `Expected byline "${seat.displayName}" is not visible.`;
      return;
    }

    // Exact text on purpose: a loose "Answer" match would also hit "Submit Answer" and fire an
    // empty submit before the body is typed.
    await findFirstWorking(page, [
      'button:has-text("Edit Answer")', 'a:has-text("Edit Answer")',
      'button:text-is("Answer")', 'a:text-is("Answer")',
    ]).catch(() => null);
    await page.waitForTimeout(1500);
    const filledSelector = await findFirstWorking(page, [
      'textarea[name="answer"]', 'textarea[placeholder*="answer" i]',
      'textarea[placeholder*="response" i]', 'div[role="textbox"]', 'textarea',
    ], 'fill', item.pitch_body);
    if (!filledSelector) throw new Error('Could not find answer textarea.');
    await page.waitForTimeout(1500);
    const screenshotId = encodeURIComponent(String(item.id));
    const presubmitPath = path.join(runDir, 'screenshots', `${screenshotId}-presubmit.png`);
    await page.screenshot({ path: presubmitPath, fullPage: false });
    outcome.presubmit = presubmitPath;
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    outcome.pitched_before = readPitchedCount(bodyText);
    if (!live) {
      outcome.status = 'dry_run_ok';
      return;
    }

    const responsePromise = page.waitForResponse(
      (r) => r.status() === 200 && /(featured\.com|connectively\.us)/.test(r.url())
        && (r.request().method() === 'POST' || r.url().includes('answer')),
      { timeout: 30000 },
    ).catch(() => null);
    // Only buttons labeled Submit. These are the selectors proven on the live site; the generic
    // button[type="submit"] fallback is gone so an unrelated form can never be the one that fires.
    const clicked = await findFirstWorking(page, [
      'button:has-text("Submit Answer")', 'button:has-text("Submit answer")', 'button:has-text("Submit")',
    ]);
    if (!clicked) {
      outcome.status = 'error_no_submit_button';
      outcome.detail = 'No permitted submit button could be clicked.';
      return;
    }
    const response = await responsePromise;
    await page.waitForTimeout(3000);
    const postBody = await page.evaluate(() => (document.body.innerText || '').slice(0, 5000)).catch(() => '');
    const postsubmitPath = path.join(runDir, 'screenshots', `${screenshotId}-postsubmit.png`);
    await page.screenshot({ path: postsubmitPath, fullPage: false });
    outcome.postsubmit = postsubmitPath;
    outcome.pitched_after = readPitchedCount(postBody);
    const failureHit = SUBMIT_FAILURE_PATTERNS.find((re) => re.test(postBody));
    const counterStuck = outcome.pitched_before != null && outcome.pitched_after != null
      && outcome.pitched_before === outcome.pitched_after;
    const storedAfterReload = !failureHit && counterStuck ? await answerIsStoredForProfile(page) : false;
    outcome.status = classifyPostSubmit({
      postBody, pitchedBefore: outcome.pitched_before, pitchedAfter: outcome.pitched_after,
      responseOk: Boolean(response), storedAfterReload,
    });
    if (failureHit) outcome.detail = postBody.match(failureHit)[0].trim();
    else if (counterStuck && !storedAfterReload) {
      outcome.detail = `Pitched counter did not increment (${outcome.pitched_before}).`;
    }
  } finally {
    await page.close().catch(() => {});
  }
}

async function submitItems(items, opts) {
  const { SUBMITTED_LEDGER, readJsonl, appendJsonl, writeJsonAtomic } = require('./paths');
  const { config, live = false, runDir, ledgerFile = SUBMITTED_LEDGER, pauseMs = 4000, browser = null } = opts;
  const ledgerRows = readJsonl(ledgerFile);
  const outcomes = [];
  let activeBrowser = browser;
  let context = null;
  let stopStatus = null;
  let accountBlocks = 0;
  fs.mkdirSync(path.join(runDir, 'screenshots'), { recursive: true });
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const outcome = {
        id: item.id, url: item.url, profileId: item.profileId, seatKey: item.seatKey,
        publication: item.publication, status: 'pending', detail: null, presubmit: null,
        postsubmit: null, pitched_before: null, pitched_after: null, at: new Date().toISOString(),
      };
      if (stopStatus) outcome.status = stopStatus;
      else {
        try {
          const rejection = presubmitRejection(item, config, ledgerRows);
          if (rejection) Object.assign(outcome, rejection);
          else {
            const browserTools = require('./browser');
            if (!activeBrowser) activeBrowser = await browserTools.launchBrowser();
            if (!context) context = await browserTools.newContext(activeBrowser);
            await submitOne(context, item, config, live, runDir, outcome);
          }
        } catch (e) {
          outcome.status = e.code === 'SESSION_EXPIRED' ? 'error_session_expired' : 'error';
          outcome.detail = e.message;
        }
      }
      if (['submitted', 'submitted_inferred'].includes(outcome.status)) {
        const row = {
          at: outcome.at, id: item.id, url: item.url, profileId: item.profileId,
          seatKey: item.seatKey, status: outcome.status,
        };
        appendJsonl(ledgerFile, row);
        ledgerRows.push(row);
      }
      outcomes.push(outcome);
      appendJsonl(path.join(runDir, 'submit-progress.jsonl'), outcome);
      if (outcome.status === 'error_session_expired') stopStatus = 'not_attempted_session_expired';
      accountBlocks = ['reject_platform_refused', 'held_plan_limit'].includes(outcome.status) ? accountBlocks + 1 : 0;
      if (accountBlocks >= 2) stopStatus = 'not_attempted_account_blocked';
      if (!stopStatus && index < items.length - 1) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    writeJsonAtomic(path.join(runDir, 'submit-results.json'), outcomes);
    return outcomes;
  } finally {
    if (context) await context.close().catch(() => {});
    if (activeBrowser && !browser) await activeBrowser.close().catch(() => {});
  }
}

async function main() {
  require('./paths').loadEnvFile();
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (['--live', '--yes', '--all-passed'].includes(arg)) options[arg] = true;
    else if (['--run', '--ids'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      options[arg] = args[++i];
    } else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  if (!options['--run'] || Boolean(options['--ids']) === Boolean(options['--all-passed'])) {
    throw new Error('Usage: node src/submit.js --run <runDir> (--ids id1,id2 | --all-passed) [--live] [--yes]');
  }
  const { readJson } = require('./paths');
  const runDir = path.resolve(options['--run']);
  const report = readJson(path.join(runDir, 'report.json'));
  const passed = report.passed || [];
  const ids = options['--all-passed'] ? passed.map((record) => record.id)
    : [...new Set(options['--ids'].split(',').map((id) => id.trim()).filter(Boolean))];
  const indexed = new Map(passed.map((record) => [record.id, record]));
  const unknown = ids.filter((id) => !indexed.has(id));
  if (unknown.length) throw new Error(`Unknown passed ids: ${unknown.join(', ')}`);
  if (!ids.length) throw new Error('No passed ids selected.');
  const items = ids.map((id) => {
    const record = indexed.get(id);
    return {
      id, pitch_body: record.pitch_body, url: record.url, profileId: record.profileId,
      seatKey: record.seatKey, publication: record.publication, da: record.da, deadline: record.deadline,
    };
  });
  const config = require('./config').loadConfig();
  if (options['--live']) {
    console.table(items.map((item) => ({
      id: item.id, expert: config.seatsByKey[item.seatKey]?.displayName || '(unknown seat)',
      publication: item.publication, DA: item.da, body: String(item.pitch_body || '').slice(0, 80),
    })));
    if (!options['--yes']) {
      const refusal = 'Refusing to submit live without confirmation. Re-run with --yes after reviewing review.html.';
      if (!process.stdin.isTTY) throw new Error(refusal);
      const readline = require('readline/promises');
      const input = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await input.question('Type SUBMIT to submit these pitches: ');
        if (answer !== 'SUBMIT') throw new Error(refusal);
      } finally {
        input.close();
      }
    }
  } else console.log('DRY RUN: forms are filled and screenshotted, nothing is submitted.');
  const outcomes = await submitItems(items, { config, live: Boolean(options['--live']), runDir });
  console.table(outcomes.map(({ id, publication, status, detail }) => ({ id, publication, status, detail })));
  console.log(`Results: ${path.join(runDir, 'submit-results.json')}`);
  const accepted = ['submitted', 'submitted_inferred', 'dry_run_ok', 'skip_already_answered'];
  process.exitCode = outcomes.every((outcome) => accepted.includes(outcome.status)) ? 0 : 3;
}

module.exports = { readAttributedProfile, inspectComposerState, readPitchedCount, SUBMIT_FAILURE_PATTERNS, ledgerKey, presubmitRejection, classifyPostSubmit, submitItems };

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
