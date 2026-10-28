'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const {
  inspectComposerState, readPitchedCount, SUBMIT_FAILURE_PATTERNS,
  ledgerKey, presubmitRejection, classifyPostSubmit, submitItems,
} = require('../src/submit');

const seat = {
  key: 'example_founder', profileId: '10001', displayName: 'Jane Example', brand: 'Example Co',
  enabled: true, bans: '', banPatterns: [], claims: '', topics: [], notTopics: [],
};
const config = {
  seats: [seat], seatsByKey: { example_founder: seat }, bannedWords: [],
  bannedBodyTokens: ['Jane', 'Example'], pitch: { minChars: 500, maxChars: 2200 },
  gate: { overall: 8, lie_risk: 9, fabrication_risk: 8, ai_likelihood: 7, thesis_match: 0, maxDraftAttempts: 3 },
};
const body = 'A clear decision process starts with a written objective and a named owner. '
  + 'Document the constraint before comparing possible changes. Use a small checklist to keep the review focused on the stated question. '
  + 'Each proposed change should explain the tradeoff in plain language and identify the evidence needed to evaluate it. '
  + 'Keep the original notes available so a later review can distinguish a new observation from an old assumption. '
  + 'A useful final review records the decision, its rationale, and the conditions that would justify revisiting it.';
const item = {
  id: 'pitch-1', url: 'https://www.connectively.us/questions/example',
  profileId: '10001', seatKey: 'example_founder', publication: 'Example publication', pitch_body: body,
};
const hasPreflight = fs.existsSync(path.join(__dirname, '..', 'src', 'preflight.js'));

test('composer requires both its counter and the profile strip', () => {
  for (const text of [undefined, '', 'Characters: 0 / 2500', 'Edit Profile', 'Edit Profile Characters: nope / 2500']) {
    assert.deepEqual(inspectComposerState(text), { status: 'unreadable', count: null });
  }
  assert.deepEqual(inspectComposerState('Edit Profile Characters: 0 / 2500'), { status: 'fresh', count: 0 });
  assert.deepEqual(inspectComposerState('Add New Profile Characters:\n625 / 2500'), { status: 'already_answered', count: 625 });
  assert.deepEqual(inspectComposerState('Another expert has answered this question. Edit Profile Characters: 0 / 2500'), { status: 'fresh', count: 0 });
});

test('pitched count accepts commas and returns null without a count', () => {
  assert.equal(readPitchedCount('Pitched\n1,234'), 1234);
  assert.equal(readPitchedCount('Pitched 12,345,678'), 12345678);
  assert.equal(readPitchedCount('Pitched 0'), 0);
  assert.equal(readPitchedCount('Pitched 42'), 42);
  for (const text of [undefined, '', 'Pitched unknown', 'Characters: 0 / 2500']) {
    assert.equal(readPitchedCount(text), null);
  }
});

const classification = (overrides) => classifyPostSubmit({
  postBody: '', pitchedBefore: null, pitchedAfter: null, responseOk: false, storedAfterReload: false,
  ...overrides,
});

test('platform refusal wins over every success signal', () => {
  const refusals = [
    'You have used up all your seats.', 'Add credits or more seats.', 'No credits available.',
    'Out of seats.', 'Upgrade your plan to submit.', "You can't submit.", 'Submission failed.',
  ];
  assert.equal(SUBMIT_FAILURE_PATTERNS.length, refusals.length);
  for (const refusal of refusals) {
    assert.equal(classification({
      postBody: `${refusal} Thank you, submitted.`, pitchedBefore: 10, pitchedAfter: 11,
      responseOk: true, storedAfterReload: true,
    }), 'reject_platform_refused');
  }
  assert.equal(classification({ postBody: 'Add Seats or Credits', pitchedBefore: 10, pitchedAfter: 11 }), 'submitted');
});

test('counter movement confirms submission without other hints', () => {
  assert.equal(classification({ pitchedBefore: 0, pitchedAfter: 1 }), 'submitted');
});

test('stuck counter is submitted only when the answer is stored after reload', () => {
  assert.equal(classification({ pitchedBefore: 12, pitchedAfter: 12, storedAfterReload: true }), 'submitted');
  assert.equal(classification({ pitchedBefore: 12, pitchedAfter: 12, postBody: 'Submitted', responseOk: true }), 'unverified');
});

test('response and success hints infer submission even with the answer button visible', () => {
  assert.equal(classification({ postBody: 'Thank you. Submit Answer', responseOk: true }), 'submitted_inferred');
});

test('success hints without the answer button infer submission without a response', () => {
  assert.equal(classification({ postBody: 'Your answer has been recorded.' }), 'submitted_inferred');
  assert.equal(classification({ postBody: 'Under review', pitchedBefore: 12, pitchedAfter: 11 }), 'submitted_inferred');
});

test('insufficient evidence remains unverified', () => {
  assert.equal(classification({}), 'unverified');
  assert.equal(classification({ responseOk: true }), 'unverified');
  assert.equal(classification({ storedAfterReload: true }), 'unverified');
  assert.equal(classification({ postBody: 'Submitted. Submit answer' }), 'unverified');
  assert.equal(classification({ pitchedBefore: 12, pitchedAfter: 11 }), 'unverified');
});

test('ledger keys remove queries and retain the profile', () => {
  assert.equal(ledgerKey(`${item.url}?profileId=10001&view=answer`, '10001'), `${item.url}__10001`);
  assert.notEqual(ledgerKey(item.url, '10001'), ledgerKey(item.url, '10002'));
});

test('missing, inherited, and disabled seats are rejected', () => {
  assert.equal(presubmitRejection({ ...item, seatKey: 'missing' }, config, []).status, 'reject_unknown_seat');
  assert.equal(presubmitRejection({ ...item, seatKey: 'toString' }, config, []).status, 'reject_unknown_seat');
  const disabled = { ...config, seatsByKey: { example_founder: { ...seat, enabled: false } } };
  assert.equal(presubmitRejection(item, disabled, []).status, 'reject_unknown_seat');
});

test('profile mismatches are rejected without coercion', () => {
  assert.equal(presubmitRejection({ ...item, profileId: '10002' }, config, []).status, 'reject_profile_mismatch');
  assert.equal(presubmitRejection({ ...item, profileId: 10001 }, config, []).status, 'reject_profile_mismatch');
});

test('missing and whitespace-only bodies are rejected', () => {
  for (const pitch_body of [undefined, null, '', ' \n ', 42]) {
    assert.equal(presubmitRejection({ ...item, pitch_body }, config, []).status, 'reject_missing_body');
  }
});

test('preflight rejects a body containing an em dash and joins its failures', (t) => {
  if (!hasPreflight) { t.skip('Unit 05 src/preflight.js is not available.'); return; }
  const draft = `${body}\u2014A final note.`;
  const fails = require('../src/preflight').preflight(draft, seat, config);
  assert.ok(fails.length > 0);
  assert.deepEqual(presubmitRejection({ ...item, pitch_body: draft }, config, []), {
    status: 'reject_preflight', detail: fails.join('; '),
  });
});

test('both successful ledger statuses prevent duplicate submission', (t) => {
  if (!hasPreflight) { t.skip('Unit 05 src/preflight.js is not available.'); return; }
  for (const status of ['submitted', 'submitted_inferred']) {
    const ledger = [{ url: `${item.url}?view=answer`, profileId: item.profileId, status }];
    assert.equal(presubmitRejection(item, config, ledger).status, 'skip_ledger_duplicate');
  }
});

test('clean body passes; unsuccessful or other-profile ledger rows do not block it', (t) => {
  if (!hasPreflight) { t.skip('Unit 05 src/preflight.js is not available.'); return; }
  assert.equal(presubmitRejection(item, config, []), null);
  assert.equal(presubmitRejection(item, config, [
    { url: item.url, profileId: '10002', status: 'submitted' },
    { url: item.url, profileId: item.profileId, status: 'unverified' },
  ]), null);
});

// Exercise orchestration with an in-memory browser, never a live session.
function offlineRun(t, scenarios) {
  const missing = ['preflight', 'paths', 'dedupe'].filter((name) => !fs.existsSync(path.join(__dirname, '..', 'src', `${name}.js`)));
  if (missing.length) { t.skip(`Required units are not available: ${missing.join(', ')}`); return null; }
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-submit-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const events = [];
  let opened = 0;
  const fresh = 'Jane Example Edit Profile Characters: 0 / 2500 Pitched 10';
  const context = {
    async newPage() {
      const scenario = scenarios[opened++];
      assert.ok(scenario, 'No extra pages may open after a stop condition');
      let submitted = false;
      let reloaded = false;
      return {
        async goto(url) { events.push(['goto', url]); },
        url() { return scenario.login ? 'https://www.connectively.us/login' : item.url; },
        async waitForSelector() {},
        async waitForTimeout() {},
        async evaluate() { return reloaded ? scenario.stored : submitted ? scenario.post : scenario.before ?? fresh; },
        locator(selector) {
          const isSubmit = selector.startsWith('button:has-text("Submit');
          return { first() { return {
            async count() { return isSubmit && scenario.noButton ? 0 : 1; },
            async click() { events.push(['click', selector]); if (isSubmit) submitted = true; },
            async fill(value) { events.push(['fill', value]); },
          }; } };
        },
        async screenshot(options) { events.push(['screenshot', options.path]); },
        async waitForResponse(predicate) {
          const response = { status: () => 200, url: () => 'https://www.connectively.us/answer', request: () => ({ method: () => 'POST' }) };
          assert.equal(predicate(response), true);
          return response;
        },
        async reload() { events.push(['reload']); reloaded = true; },
        async close() { events.push(['close']); },
      };
    },
    async close() { events.push(['context-close']); },
  };
  const browser = { async close() { assert.fail('Caller-owned browser must stay open'); } };
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (request, parent, ...rest) {
    if (request === './browser' && parent.filename === require.resolve('../src/submit')) {
      return {
        isLoginUrl: (url) => /\/login|\/sign_in|\/signin/i.test(url),
        newContext: async (supplied) => { assert.equal(supplied, browser); return context; },
        launchBrowser: async () => { assert.fail('No real browser may launch'); },
      };
    }
    return originalLoad.call(this, request, parent, ...rest);
  });
  const ledgerFile = path.join(runDir, 'ledger.jsonl');
  return {
    events, runDir, ledgerFile,
    run: (items, live = false) => submitItems(items, { config, live, runDir, ledgerFile, pauseMs: 0, browser }),
  };
}

test('offline dry run fills and screenshots without clicking submit or writing the ledger', async (t) => {
  const fixture = offlineRun(t, [{}]);
  if (!fixture) return;
  const outcomes = await fixture.run([item]);
  assert.equal(outcomes[0].status, 'dry_run_ok');
  assert.ok(fixture.events.some(([event]) => event === 'fill'));
  assert.ok(!fixture.events.some(([event, selector]) => event === 'click' && selector.includes('Submit')));
  assert.equal(outcomes[0].presubmit, path.join(fixture.runDir, 'screenshots', 'pitch-1-presubmit.png'));
  assert.equal(fs.existsSync(fixture.ledgerFile), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.runDir, 'submit-results.json'), 'utf8')), outcomes);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.runDir, 'submit-progress.jsonl'), 'utf8')), outcomes[0]);
});

test('offline byline mismatch and already-answered composer never type', async (t) => {
  const fixture = offlineRun(t, [
    { before: 'Edit Profile Characters: 0 / 2500' },
    { before: 'Jane Example Edit Profile Characters: 200 / 2500' },
  ]);
  if (!fixture) return;
  const outcomes = await fixture.run([item, { ...item, id: 'pitch-2' }]);
  assert.deepEqual(outcomes.map((row) => row.status), ['reject_byline_not_visible', 'skip_already_answered']);
  assert.ok(!fixture.events.some(([event]) => ['click', 'fill'].includes(event)));
});

test('offline session expiry stops immediately and records the remaining items', async (t) => {
  const fixture = offlineRun(t, [{ login: true }]);
  if (!fixture) return;
  const outcomes = await fixture.run([item, { ...item, id: 'pitch-2' }, { ...item, id: 'pitch-3' }], true);
  assert.deepEqual(outcomes.map((row) => row.status), ['error_session_expired', 'not_attempted_session_expired', 'not_attempted_session_expired']);
  assert.equal(fs.readFileSync(path.join(fixture.runDir, 'submit-progress.jsonl'), 'utf8').trim().split('\n').length, 3);
});

test('offline consecutive plan limits stop the batch before a third page', async (t) => {
  const before = 'Jane Example Edit Profile Characters: 0 / 2500 Unlock more placements';
  const fixture = offlineRun(t, [{ before }, { before }]);
  if (!fixture) return;
  const outcomes = await fixture.run([item, { ...item, id: 'pitch-2' }, { ...item, id: 'pitch-3' }], true);
  assert.deepEqual(outcomes.map((row) => row.status), ['held_plan_limit', 'held_plan_limit', 'not_attempted_account_blocked']);
  assert.ok(!fixture.events.some(([event]) => event === 'fill'));
});

test('offline live flow records success and deduplicates later items in the same batch', async (t) => {
  const fixture = offlineRun(t, [{ post: 'Pitched 11 Submitted' }]);
  if (!fixture) return;
  const outcomes = await fixture.run([item, { ...item, id: 'pitch-2' }], true);
  assert.deepEqual(outcomes.map((row) => row.status), ['submitted', 'skip_ledger_duplicate']);
  assert.deepEqual(fixture.events.filter(([event, selector]) => event === 'click' && selector.includes('Submit')),
    [['click', 'button:has-text("Submit Answer")']]);
  const ledger = JSON.parse(fs.readFileSync(fixture.ledgerFile, 'utf8'));
  assert.deepEqual(ledger, { at: outcomes[0].at, id: item.id, url: item.url, profileId: item.profileId, seatKey: item.seatKey, status: 'submitted' });
});

test('offline stuck counter reloads the composer before confirming submission', async (t) => {
  const fixture = offlineRun(t, [{ post: 'Pitched 10 Submitted', stored: 'Jane Example Edit Profile Characters: 600 / 2500' }]);
  if (!fixture) return;
  const outcomes = await fixture.run([item], true);
  assert.equal(outcomes[0].status, 'submitted');
  assert.ok(fixture.events.some(([event]) => event === 'reload'));
});

test('offline missing submit button never writes a successful ledger entry', async (t) => {
  const fixture = offlineRun(t, [{ noButton: true }]);
  if (!fixture) return;
  const outcomes = await fixture.run([item], true);
  assert.equal(outcomes[0].status, 'error_no_submit_button');
  assert.equal(fs.existsSync(fixture.ledgerFile), false);
});

test('offline consecutive platform refusals stop without reloading or writing a ledger', async (t) => {
  const post = 'Pitched 10 Submitted. You have used up all your seats.';
  const fixture = offlineRun(t, [{ post }, { post }]);
  if (!fixture) return;
  const outcomes = await fixture.run([item, { ...item, id: 'pitch-2' }, { ...item, id: 'pitch-3' }], true);
  assert.deepEqual(outcomes.map((row) => row.status), ['reject_platform_refused', 'reject_platform_refused', 'not_attempted_account_blocked']);
  assert.ok(!fixture.events.some(([event]) => event === 'reload'));
  assert.equal(fs.existsSync(fixture.ledgerFile), false);
});
