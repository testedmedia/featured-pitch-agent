'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  pitchId, acquireLock, releaseLock, buildPairs, rankPicks, applyCaps,
  draftAndGrade, runDraftStage, parseFlags, validateOutcomes, main,
} = require('../src/pipeline');

const helpers = fs.existsSync(path.join(__dirname, '../src/llm.js')) ? require('../src/llm') : {
  extractJsonObject(text) { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); },
  extractJsonArray(text) { return JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)); },
  parseDraft(text) {
    const draft = JSON.parse(text);
    return draft.decline_reason ? { __decline: draft.decline_reason } : draft;
  },
};

function makeConfig() {
  const primary = {
    key: 'example_founder', profileId: '10001', displayName: 'Jane Example', brand: 'Example Co',
    persona: 'Founder', topics: ['operations'], notTopics: [], bans: '', banPatterns: [],
    claims: 'Builds useful products.', statsUrl: null,
    minDa: 0, maxDa: 100, maxPicksPerRun: 10, autoSubmit: false, enabled: true,
  };
  const alternate = { ...primary, key: 'example_operator', minDa: 10, maxDa: 60 };
  return {
    seats: [primary, alternate], seatsByKey: { [primary.key]: primary, [alternate.key]: alternate },
    models: { classifier: 'sonnet', drafter: 'sonnet', grader: 'sonnet' },
    filters: { includeStretch: false },
    gate: { overall: 8, lie_risk: 9, fabrication_risk: 8, ai_likelihood: 7, thesis_match: 0, maxDraftAttempts: 3 },
    pitch: { minChars: 500, maxChars: 2200 }, bannedBodyTokens: ['Jane', 'Example'],
    linkYieldByDa: { '<20': 0.9, '20-39': 0.57, '40-59': 0.24, '60+': 0.3 },
  };
}

const body = 'I keep a written checklist beside each task. Each step names the person responsible and the evidence needed to finish it. A short note records the reason for any change. That makes the next handoff easier to check. '.repeat(4).trim();
const goodScore = {
  fit: 9, thesis_match: 9, authenticity: 9, specificity: 9, lie_risk: 9,
  ai_likelihood: 9, fabrication_risk: 9, overall: 9, verdict: 'approve', notes: 'Clear and grounded.',
};
const draft = { pitch_body: body, thesis: 'Written handoffs help.', named_asks: ['checklists'], number_used: 'none' };
const pick = (overrides = {}) => ({
  url: 'https://www.connectively.us/questions/example', profileId: '10001', seatKey: 'example_founder',
  strength: 'strong', da: 15, publication: 'Example Publication', text: 'How do you handle handoffs?',
  deadline: 'Open', ...overrides,
});

function fakeLlm(drafts = [draft], scores = [goodScore]) {
  const calls = [];
  let draftIndex = 0;
  let scoreIndex = 0;
  return {
    ...helpers, calls,
    async callClaude(args) {
      calls.push(args);
      const values = args.stage === 'draft' ? drafts : scores;
      const index = args.stage === 'draft' ? draftIndex++ : scoreIndex++;
      const value = values[Math.min(index, values.length - 1)];
      if (value instanceof Error) throw value;
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
  };
}

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-pipeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('pitchId is stable, query-insensitive, and separates seats and questions', () => {
  const id = pitchId('example_founder', 15, pick().url);
  assert.match(id, /^example_founder-da15-[a-f0-9]{8}$/);
  assert.equal(id, pitchId('example_founder', 15, `${pick().url}?profileId=10001`));
  assert.notEqual(id, pitchId('example_operator', 15, pick().url));
  assert.notEqual(id, pitchId('example_founder', 15, `${pick().url}/second`));
});

test('a live lock refuses acquisition and the owner can release it', (t) => {
  const file = path.join(temporary(t), 'pipeline.lock');
  assert.equal(acquireLock(file).ok, true);
  const held = acquireLock(file);
  assert.equal(held.ok, false);
  assert.equal(held.holder.pid, process.pid);
  assert.ok(held.holder.startedAt);
  releaseLock(file);
  assert.equal(fs.existsSync(file), false);
});

test('dead and junk locks are recovered; release preserves other owners', (t) => {
  const file = path.join(temporary(t), 'pipeline.lock');
  for (const text of [JSON.stringify({ pid: 999999 }), 'junk']) {
    fs.writeFileSync(file, text);
    assert.equal(acquireLock(file).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid);
    releaseLock(file);
  }
  fs.writeFileSync(file, JSON.stringify({ pid: 999999 }));
  releaseLock(file);
  assert.equal(fs.existsSync(file), true);
  fs.writeFileSync(file, 'junk');
  releaseLock(file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'junk');
});

test('buildPairs honors strength, wide, DA bounds, enabled seats, and seat filter', () => {
  const config = makeConfig();
  const items = [0, 10, 60, 61, 100, 101].map((da) => ({ ...pick({ da }), fits: [
    { seat: 'example_founder', strength: 'strong' }, { seat: 'example_operator', strength: 'stretch' },
  ] }));
  assert.equal(buildPairs({ items }, config).length, 5);
  assert.equal(buildPairs({ items }, config, { wide: true }).length, 7);
  assert.deepEqual(buildPairs({ items }, config, { wide: true, seatKey: 'example_operator' }).map((row) => row.da), [10, 60]);
  config.filters.includeStretch = true;
  assert.equal(buildPairs(items, config).length, 7);
  config.seatsByKey.example_operator.enabled = false;
  assert.equal(buildPairs(items, config).length, 5);
});

test('rankPicks keeps one question, preserves fallbacks, and ranks strength before yield', () => {
  const config = makeConfig();
  const stretch = pick({ strength: 'stretch', da: 15 });
  const strong = pick({ seatKey: 'example_operator', da: 55, url: `${pick().url}?profileId=10001` });
  const rows = [stretch, strong, pick({ da: 15, url: `${pick().url}/other` })];
  const ranked = rankPicks(rows, config);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].da, 15);
  assert.equal(ranked[1].seatKey, 'example_operator');
  assert.deepEqual(ranked[1].fallbacks, [stretch]);
  assert.equal(rows.length, 3);
  const equalStrength = rankPicks([pick({ da: 55 }), pick({ da: 15, seatKey: 'example_operator' })], config);
  assert.equal(equalStrength[0].da, 15);
  const tiedYield = rankPicks([pick({ da: 10 }), pick({ da: 15, url: `${pick().url}/other` })], config);
  assert.equal(tiedYield[0].da, 15);
});

test('applyCaps preserves rank order and enforces per-seat and total caps', () => {
  const config = makeConfig();
  config.seatsByKey.example_founder.maxPicksPerRun = 1;
  const picks = [pick(), pick({ url: `${pick().url}/second` }), pick({ seatKey: 'example_operator' })];
  const result = applyCaps(picks, config, { max: 2 });
  assert.deepEqual(result.kept, [picks[0], picks[2]]);
  assert.deepEqual(result.capped, [picks[1]]);
  assert.equal(applyCaps(picks, config, { max: 1 }).kept.length, 1);
  assert.equal(applyCaps(picks, config, { max: 0 }).capped.length, 3);
});

test('draftAndGrade passes on the first try with a separate grader call', async () => {
  const llm = fakeLlm();
  const record = await draftAndGrade(pick(), { config: makeConfig(), llm, question: pick().text });
  assert.equal(record.status, 'passed');
  assert.equal(record.attempts, 1);
  assert.equal(record.pitch_body, body);
  assert.deepEqual(record.gate_failures, []);
  assert.deepEqual(llm.calls.map((call) => call.stage), ['draft', 'grade']);
});

test('mechanical failure retries with the failure text in the next prompt', async () => {
  const llm = fakeLlm([{ ...draft, pitch_body: 'Too short.' }, draft]);
  const record = await draftAndGrade(pick(), { config: makeConfig(), llm, question: pick().text });
  assert.equal(record.status, 'passed');
  assert.equal(record.attempts, 2);
  assert.match(llm.calls[1].prompt, /YOUR PREVIOUS DRAFT FAILED THESE MECHANICAL GATES: len:10/);
  assert.deepEqual(llm.calls.map((call) => call.stage), ['draft', 'draft', 'grade']);
});

test('three below-floor grades hold with the failed score and gate diagnostics', async () => {
  const llm = fakeLlm([draft], [{ ...goodScore, overall: 7, notes: 'Give a concrete step.' }]);
  const record = await draftAndGrade(pick(), { config: makeConfig(), llm, question: pick().text });
  assert.equal(record.status, 'held');
  assert.equal(record.attempts, 3);
  assert.equal(record.score, null);
  assert.equal(record.score_last_failed.overall, 7);
  assert.deepEqual(record.gate_failures, ['overall 7 < 8']);
  assert.match(llm.calls[2].prompt, /YOUR PREVIOUS DRAFT SCORED BELOW THE GATE/);
  assert.match(llm.calls[2].prompt, /Rewrite to fix: Give a concrete step\./);
});

test('junk JSON, invalid scores, and grader transport errors hold without retry', async () => {
  for (const score of ['Not JSON', { overall: 10 }, new Error('Grader unavailable')]) {
    const llm = fakeLlm([draft], [score]);
    const record = await draftAndGrade(pick(), { config: makeConfig(), llm, question: pick().text });
    assert.equal(record.status, 'held');
    assert.equal(record.score, null);
    assert.equal(record.attempts, 1);
    assert.match(record.why, /^grader_failed:/);
  }
});

test('declines and missing bodies stop before grading', async () => {
  for (const [response, status, why] of [
    [{ decline_reason: 'Requires a license.' }, 'declined', /^drafter_declined:/],
    [{ thesis: 'No body.' }, 'held', /^drafter_bad_shape/],
    // Plain prose is the drafter refusing the question; the original pipeline treats it as a decline.
    ['This question needs a licensed engineer.', 'declined', /^drafter_declined:/],
    // Assistant-register chat text is a malformed reply, held and never graded.
    ["Here's the draft, it's on your clipboard.", 'held', /^drafter_bad_shape/],
  ]) {
    const llm = fakeLlm([response]);
    const record = await draftAndGrade(pick(), { config: makeConfig(), llm, question: pick().text });
    assert.equal(record.status, status);
    assert.match(record.why, why);
    assert.equal(llm.calls.length, 1);
    // Nothing was graded, so no floor can be reported as failed.
    assert.deepEqual(record.gate_failures, []);
  }
});

test('drafter transport errors carry the outage tag', async () => {
  await assert.rejects(draftAndGrade(pick(), {
    config: makeConfig(), question: pick().text, llm: fakeLlm([new Error('Unavailable')]),
  }), (error) => error.drafterFailure === true && error.record.attempts === 1);
});

test('a decline after a failed grade does not retain the previous pitch body', async () => {
  const record = await draftAndGrade(pick(), {
    config: makeConfig(), question: pick().text,
    llm: fakeLlm([draft, { decline_reason: 'Requires a license.' }], [{ ...goodScore, overall: 7 }]),
  });
  assert.equal(record.status, 'declined');
  assert.equal(record.pitch_body, '');
  assert.equal(record.thesis, null);
  assert.equal(record.score_last_failed.overall, 7);
});

test('runDraftStage re-offers a decline to the fallback seat and saves both records', async (t) => {
  const runDir = temporary(t);
  const llm = fakeLlm([{ decline_reason: 'Outside scope.' }, draft]);
  const picks = [pick({ fallbacks: [pick({ seatKey: 'example_operator' })] })];
  const result = await runDraftStage(picks, { config: makeConfig(), llm, runDir,
    details: { details: { [pick().url]: { full_text: 'Question\nFull question text\nAnswer\nEditor' } } },
  });
  assert.equal(result.declined.length, 1);
  assert.equal(result.passed.length, 1);
  assert.equal(result.passed[0].seatKey, 'example_operator');
  assert.equal(result.passed[0].question, 'Full question text');
  assert.equal(fs.readdirSync(path.join(runDir, 'pitches')).length, 2);
  assert.equal(picks.length, 1);
  assert.equal(result.critical, null);
});

test('fallbacks respect reserved seat caps and run at most once per question', async (t) => {
  const config = makeConfig();
  config.seatsByKey.example_operator.maxPicksPerRun = 0;
  const fallback = pick({ seatKey: 'example_operator', fallbacks: [pick()] });
  const picks = [pick({ fallbacks: [fallback] })];
  const options = { config, llm: fakeLlm([{ decline_reason: 'Outside scope.' }]), details: {}, runDir: temporary(t) };
  assert.equal((await runDraftStage(picks, options)).declined.length, 1);
  config.seatsByKey.example_operator.maxPicksPerRun = 10;
  assert.equal((await runDraftStage(picks, { ...options, runDir: temporary(t) })).declined.length, 2);
});

test('five consecutive drafter failures abort with remaining picks undrafted', async (t) => {
  const runDir = temporary(t);
  const picks = Array.from({ length: 7 }, (_, index) => pick({ url: `${pick().url}/${index}` }));
  const llm = fakeLlm([new Error('Unavailable')]);
  const result = await runDraftStage(picks, { config: makeConfig(), llm, details: {}, runDir });
  assert.equal(llm.calls.length, 5);
  assert.equal(result.held.length, 5);
  assert.match(result.critical, /2 picks left undrafted/);
  assert.equal(fs.readdirSync(path.join(runDir, 'pitches')).length, 5);
});

test('CLI flags are parsed strictly', () => {
  assert.deepEqual(parseFlags(['--max', '2', '--wide', '--seat', 'example_founder', '--from-scan', 'feed.json', '--auto-submit']), {
    max: 2, wide: true, seat: 'example_founder', fromScan: 'feed.json', autoSubmit: true, help: false,
  });
  for (const args of [['--max', '-1'], ['--max', '1x'], ['--max'], ['--seat'], ['--unknown']]) {
    assert.throws(() => parseFlags(args));
  }
});

test('submission integrity requires each expected ID exactly once', () => {
  const items = [{ id: 'one' }, { id: 'two' }];
  assert.doesNotThrow(() => validateOutcomes(items, [{ id: 'two' }, { id: 'one' }]));
  for (const outcomes of [null, [{ id: 'one' }], [{ id: 'one' }, { id: 'one' }], [{ id: 'one' }, { id: 'other' }]]) {
    assert.throws(() => validateOutcomes(items, outcomes));
  }
});

function mainFixture(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const root = temporary(t);
  const paths = require('../src/paths');
  const config = makeConfig();
  const runDir = path.join(root, 'run');
  const stateFile = path.join(root, 'state.json');
  fs.writeFileSync(stateFile, '{}');
  let submitCalls = 0;
  const dependencies = {
    paths: { ...paths, STATE_FILE: stateFile, LOCK_FILE: path.join(root, 'lock'),
      newRunDir() { fs.mkdirSync(runDir); return runDir; } },
    config: { loadConfig: () => config, ConfigError: class ConfigError extends Error {} },
    scan: { scanQuestions: async () => ({ scannedAt: new Date().toISOString(), count: 1, items: [pick()] }) },
    classify: { classifyQuestions: async (items) => ({ total: items.length, anyFit: items.length, noFit: 0, failed: 0,
      items: items.map((item) => ({ ...item, fits: [{ seat: 'example_founder', strength: 'strong' }] })),
    }) },
    dedupe: { checkPairs: async (pairs) => pairs.map((row) => ({ ...row, prefilter: row.id ? 'already_answered' : 'fresh' })) },
    details: { fetchDetails: async () => ({ complete: true, details: {} }) },
    llm: fakeLlm(),
    submit: { submitItems: async (items, options) => {
      submitCalls++;
      assert.equal(options.live, true);
      return items.map((row) => ({ id: row.id, status: 'submitted' }));
    } },
  };
  return { dependencies, config, runDir, read: () => paths.readJson(path.join(runDir, 'report.json')),
    submitCalls: () => submitCalls };
}

test('main writes every stage artifact and defaults to manual review', async (t) => {
  const fixture = mainFixture(t);
  fixture.config.seatsByKey.example_founder.autoSubmit = true;
  assert.equal(await main([], fixture.dependencies), 0);
  assert.equal(fixture.submitCalls(), 0);
  assert.equal(fixture.read().counts.passed, 1);
  assert.equal(fixture.read().counts.drafted, 1);
  assert.equal(fixture.read().gate.overall, 8);
  for (const file of ['feed.json', 'classified.json', 'pairs.json', 'dedupe.json', 'picks.json', 'details.json', 'report.json', 'review.html']) {
    assert.equal(fs.existsSync(path.join(fixture.runDir, file)), true, file);
  }
  assert.equal(fs.existsSync(fixture.dependencies.paths.LOCK_FILE), false);
});

test('auto-submit requires seat opt-in and verifies returned outcomes', async (t) => {
  for (const autoSubmit of [false, true]) {
    const fixture = mainFixture(t);
    fixture.config.seatsByKey.example_founder.autoSubmit = autoSubmit;
    assert.equal(await main(['--auto-submit'], fixture.dependencies), 0);
    assert.equal(fixture.submitCalls(), Number(autoSubmit));
    assert.equal(fixture.read().counts.verified, Number(autoSubmit));
  }
});

test('mostly failed classification and expired sessions stop before drafting', async (t) => {
  for (const stage of ['classify', 'dedupe']) {
    const fixture = mainFixture(t);
    if (stage === 'classify') fixture.dependencies.classify.classifyQuestions = async () => ({ total: 1, failed: 1, anyFit: 0, noFit: 0, items: [] });
    else fixture.dependencies.dedupe.checkPairs = async (pairs) => pairs.map((row) => ({ ...row, prefilter: 'session_expired' }));
    assert.equal(await main([], fixture.dependencies), 1);
    assert.equal(fixture.read().counts.drafted, 0);
    assert.equal(fixture.submitCalls(), 0);
    assert.equal(fs.existsSync(fixture.dependencies.paths.LOCK_FILE), false);
  }
});

test('page-check errors are held and never drafted', async (t) => {
  const fixture = mainFixture(t);
  fixture.dependencies.dedupe.checkPairs = async (pairs) => pairs.map((row) => ({ ...row, prefilter: 'error:render_timeout' }));
  assert.equal(await main([], fixture.dependencies), 0);
  assert.equal(fixture.read().counts.held, 1);
  assert.equal(fixture.read().counts.drafted, 0);
  assert.equal(fixture.dependencies.llm.calls.length, 0);
});

test('stale or empty live scans are critical; an imported older feed is allowed', async (t) => {
  for (const feed of [{ scannedAt: new Date(0).toISOString(), items: [pick()] }, { scannedAt: new Date().toISOString(), items: [] }]) {
    const fixture = mainFixture(t);
    fixture.dependencies.scan.scanQuestions = async () => feed;
    assert.equal(await main([], fixture.dependencies), 1);
    assert.equal(fixture.read().counts.drafted, 0);
  }
  const fixture = mainFixture(t);
  const file = path.join(path.dirname(fixture.runDir), 'import.json');
  fs.writeFileSync(file, JSON.stringify({ scannedAt: new Date(0).toISOString(), items: [pick()] }));
  fixture.dependencies.scan.scanQuestions = async () => { throw new Error('Must not scan'); };
  assert.equal(await main(['--from-scan', file], fixture.dependencies), 0);
});

test('outcome mismatch is critical and preserves returned outcomes in the report', async (t) => {
  const fixture = mainFixture(t);
  fixture.config.seatsByKey.example_founder.autoSubmit = true;
  fixture.dependencies.submit.submitItems = async (items) => [
    { id: items[0].id, status: 'submitted' }, { id: items[0].id, status: 'submitted' },
  ];
  assert.equal(await main(['--auto-submit'], fixture.dependencies), 1);
  assert.match(fixture.read().errors.at(-1), /Duplicate outcome ID/);
  assert.equal(fixture.read().submitted.length, 2);
  assert.equal(fixture.read().counts.submitted, 1);
  assert.ok(fixture.read().submitted.every((row) => row.verified === false));
});

test('inconclusive server verification stays false and records an error', async (t) => {
  const fixture = mainFixture(t);
  fixture.config.seatsByKey.example_founder.autoSubmit = true;
  fixture.dependencies.dedupe.checkPairs = async (pairs) => pairs.map((row) => ({ ...row, prefilter: row.id ? 'error:render_timeout' : 'fresh' }));
  assert.equal(await main(['--auto-submit'], fixture.dependencies), 0);
  assert.equal(fixture.read().submitted[0].verified, false);
  assert.match(fixture.read().errors[0], /could not be verified/);
});
