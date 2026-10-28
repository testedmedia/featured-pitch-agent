'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DEFAULTS, ConfigError, loadConfig } = require('../src/config');
const { writeJsonAtomic } = require('../src/paths');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-config-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const claimsFile = 'config/claims/example-co.md';
  const claims = '# Approved facts\nExample Co serves homeowners in the fictional town of Willow Basin with a five-person plumbing team.\n';
  fs.mkdirSync(path.join(home, 'config', 'claims'), { recursive: true });
  fs.writeFileSync(path.join(home, claimsFile), claims);
  const seat = {
    key: 'example_founder', profileId: '10001', displayName: 'Jane Example', brand: 'Example Co',
    persona: 'Founder of a small residential plumbing company.', topics: ['plumbing'],
    claimsFile, banPatterns: [{ label: 'no-free-claim', regex: '\\bfree (estimate|inspection)s?\\b', flags: 'i' }],
  };
  const file = path.join(home, 'config', 'seats.json');
  const input = { seats: [seat] };
  const load = () => { writeJsonAtomic(file, input); return loadConfig(file, { home }); };
  return { home, file, input, seat, claims, load };
}

test('config deep-merges defaults and normalizes enabled seats and name tokens', (t) => {
  const f = fixture(t);
  f.input.filters = { minDa: 20 };
  f.input.gate = { overall: 9 };
  f.input.models = { grader: 'review-model' };
  f.input.bannedWords = ['forbidden', 'Jane'];
  f.input.seats.push({ ...f.seat, key: 'example_disabled', profileId: '10002', displayName: 'Jo Example Disabled', enabled: false });
  const config = f.load();
  assert.equal(config.baseUrl, DEFAULTS.baseUrl);
  assert.deepEqual(config.filters, { ...DEFAULTS.filters, minDa: 20 });
  assert.deepEqual(config.gate, { ...DEFAULTS.gate, overall: 9 });
  assert.deepEqual(config.models, { ...DEFAULTS.models, grader: 'review-model' });
  assert.deepEqual(config.pitch, DEFAULTS.pitch);
  assert.equal(config.seats.length, 1);
  const seat = config.seats[0];
  assert.equal(config.seatsByKey.example_founder, seat);
  assert.equal(Object.getPrototypeOf(config.seatsByKey), Object.prototype);
  assert.equal(seat.claimsFile, path.resolve(f.home, f.seat.claimsFile));
  assert.equal(seat.claims, f.claims);
  assert.equal(seat.profileId, '10001');
  assert.deepEqual(seat.notTopics, []);
  assert.equal(seat.bans, '');
  assert.equal(seat.autoSubmit, false);
  assert.equal(seat.enabled, true);
  assert.equal(seat.statsUrl, null);
  assert.equal(seat.byline, null);
  assert.equal(seat.minDa, 20);
  assert.equal(seat.maxDa, 100);
  assert.equal(seat.maxPicksPerRun, 10);
  assert.equal(seat.banPatterns[0].label, 'no-free-claim');
  assert.equal(seat.banPatterns[0].re.test('FREE inspections'), true);
  assert.deepEqual(new Set(config.bannedBodyTokens), new Set(['forbidden', 'Jane', 'Example', 'Disabled']));
  config.gate.overall = 0;
  config.bannedWords.push('another');
  assert.equal(DEFAULTS.gate.overall, 8);
  assert.deepEqual(DEFAULTS.bannedWords, []);
});

test('per-seat overrides, absolute claims, and boundary gate values are accepted', (t) => {
  const f = fixture(t);
  Object.assign(f.seat, { claimsFile: path.join(f.home, f.seat.claimsFile), minDa: 0, maxDa: 0, maxPicksPerRun: 1, autoSubmit: true, statsUrl: 'https://www.connectively.us/statistics' });
  f.input.gate = { overall: 0, lie_risk: 10, maxDraftAttempts: 1 };
  let seat = f.load().seats[0];
  assert.equal(seat.minDa, 0);
  assert.equal(seat.maxDa, 0);
  assert.equal(seat.maxPicksPerRun, 1);
  assert.equal(seat.autoSubmit, true);
  f.input.gate.maxDraftAttempts = 5;
  Object.assign(f.seat, { minDa: null, maxDa: null, maxPicksPerRun: null });
  seat = f.load().seats[0];
  assert.equal(seat.maxDa, 100);
  assert.equal(seat.maxPicksPerRun, 10);
});

test('config reports independent problems together, including disabled seats', (t) => {
  const f = fixture(t);
  Object.assign(f.input, { baseUrl: 'http://www.connectively.us', filters: { minDa: 90, maxDa: 20 }, models: { classifier: '' }, gate: { overall: 11, lie_risk: 1.5, maxDraftAttempts: 0 } });
  Object.assign(f.seat, { key: 'INVALID', profileId: 10001, displayName: '', brand: '', persona: '', topics: [], claimsFile: 'missing.md', statsUrl: 'http://www.connectively.us', banPatterns: [{ label: 'invalid', regex: '[', flags: 'i' }], enabled: false });
  f.input.seats.push({ ...f.seat });
  assert.throws(f.load, (e) => {
    assert.equal(e instanceof ConfigError, true);
    assert.equal(e.message, e.problems.join('\n'));
    for (const text of ['baseUrl', 'filters.minDa', 'models.classifier', 'gate.overall', 'gate.lie_risk', 'gate.maxDraftAttempts', '.key must match', '.key is duplicated', '.profileId must', '.profileId is duplicated', '.displayName', '.brand', '.persona', '.topics', '.claimsFile', '.statsUrl', 'invalid regex', 'At least one seat']) {
      assert.equal(e.message.includes(text), true, text);
    }
    return true;
  });
});

test('config rejects missing, malformed, short-claims, and malformed schema inputs', (t) => {
  const f = fixture(t);
  assert.throws(() => loadConfig(f.file, { home: f.home }), ConfigError);
  fs.writeFileSync(f.file, '{');
  assert.throws(() => loadConfig(f.file, { home: f.home }), ConfigError);
  for (const input of [null, [], {}, { seats: [] }, { seats: [null] }, { seats: 'invalid' }]) {
    writeJsonAtomic(f.file, input);
    assert.throws(() => loadConfig(f.file, { home: f.home }), ConfigError);
  }
  fs.writeFileSync(path.join(f.home, f.seat.claimsFile), ' '.repeat(80) + 'a'.repeat(49));
  assert.throws(f.load, /50 non-whitespace/);
  fs.writeFileSync(path.join(f.home, f.seat.claimsFile), 'a'.repeat(50));
  assert.equal(f.load().seats.length, 1);
  for (const [field, value] of Object.entries({ topics: [''], notTopics: null, bans: null, banPatterns: null, autoSubmit: 'false', enabled: 'true', statsUrl: '', minDa: -1, maxDa: 101, maxPicksPerRun: 0 })) {
    const original = f.seat[field];
    f.seat[field] = value;
    assert.throws(f.load, (e) => e instanceof ConfigError && e.message.includes(field), field);
    if (original === undefined) delete f.seat[field];
    else f.seat[field] = original;
  }
  for (const block of ['models', 'gate', 'bylineGate', 'filters', 'pitch', 'linkYieldByDa', 'bannedWords']) {
    f.input[block] = null;
    assert.throws(f.load, (e) => e instanceof ConfigError && e.message.includes(block));
    delete f.input[block];
  }
  f.seat.banPatterns = [{ label: 'bad-flags', regex: 'x', flags: 'ii' }];
  assert.throws(f.load, /invalid regex/);
  f.seat.banPatterns = [null, { label: 'bad-regex', regex: 5 }];
  assert.throws(f.load, /regex string/);
});

test('config CLI reports summaries, all validation errors, and missing-file guidance', (t) => {
  const f = fixture(t);
  const env = { ...process.env, FEATURED_AGENT_HOME: f.home, FEATURED_CONFIG: f.file, FEATURED_DATA_DIR: path.join(f.home, 'data') };
  const run = (...args) => spawnSync(process.execPath, [require.resolve('../src/config'), '--check', ...args], { env, encoding: 'utf8' });
  let result = run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'No config yet. Run: npm run onboard');
  f.load();
  result = run(f.file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'example_founder | Example Co | profile 10001 | DA 0-100 | max picks 10 | auto-submit OFF | byline OFF');
  f.seat.autoSubmit = true;
  f.load();
  assert.match(run().stdout, /auto-submit ON/);
  f.seat.topics = [];
  f.seat.profileId = 'invalid';
  writeJsonAtomic(f.file, f.input);
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /profileId/);
  assert.match(result.stderr, /topics/);
  assert.equal(result.stdout, '');
});

function byline() {
  return {
    title: 'Founder', homepage: 'https://example.com/', topic: 'Plumbing maintenance for homeowners.',
    sources: ['https://example.com/plumbing-statistics'],
  };
}

test('byline config normalizes fields, defaults the author, and accepts null', (t) => {
  const f = fixture(t);
  f.seat.byline = { ...byline(), title: ' Founder ', topic: ' Plumbing maintenance for homeowners. ' };
  assert.deepEqual(f.load().seats[0].byline, { ...byline(), authorOption: 'Jane Example Founder, Example Co' });
  f.seat.byline.authorOption = ' Jane Example Owner, Example Co ';
  const config = f.load();
  assert.equal(config.seats[0].byline.authorOption, 'Jane Example Owner, Example Co');
  const result = spawnSync(process.execPath, [require.resolve('../src/config'), '--check', f.file], {
    env: { ...process.env, FEATURED_AGENT_HOME: f.home }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /byline ON/);
  f.seat.byline = null;
  assert.equal(f.load().seats[0].byline, null);
});

test('byline config collects every field problem alongside other seat problems', (t) => {
  const f = fixture(t);
  f.seat.byline = { title: '', homepage: 'http://example.com/', topic: ' ', sources: ['http://example.com/', 42], authorOption: '' };
  f.seat.topics = [];
  assert.throws(f.load, (e) => {
    assert.ok(e instanceof ConfigError);
    for (const field of ['title', 'homepage', 'topic', 'sources[0]', 'sources[1]', 'authorOption']) {
      assert.ok(e.problems.some((problem) => problem.startsWith(`seats[0].byline.${field} `)), field);
    }
    assert.ok(e.problems.some((problem) => problem.startsWith('seats[0].topics ')));
    assert.equal(e.problems.length, 7);
    return true;
  });
});

test('byline config rejects invalid shapes, fields, source counts, and URL protocols', (t) => {
  const f = fixture(t);
  for (const value of [false, [], 'enabled']) {
    f.seat.byline = value;
    assert.throws(f.load, /byline must be an object or null/);
  }
  const invalid = {
    title: [undefined, null, 1, ' '], topic: [undefined, null, 1, ' '],
    homepage: [undefined, null, 'http://example.com/', 'https://', 'not a URL'],
    sources: [undefined, null, [], 'https://example.com/', Array(6).fill('https://example.com/'), ['https://']],
    authorOption: [null, 1, ' '],
  };
  for (const [field, values] of Object.entries(invalid)) {
    for (const value of values) {
      f.seat.byline = { ...byline(), [field]: value };
      assert.throws(f.load, (e) => e instanceof ConfigError && e.message.includes(`byline.${field}`));
    }
  }
  f.seat.byline = { ...byline(), sources: Array(5).fill('https://example.com/') };
  assert.equal(f.load().seats[0].byline.sources.length, 5);
});

test('bylineGate defaults, partial overrides, and integer boundaries are validated independently', (t) => {
  const f = fixture(t);
  const expected = { overall: 8, lie_risk: 9, sourcing: 8, fabrication_risk: 8, ai_likelihood: 7, guideline_fit: 8, maxDraftAttempts: 3 };
  assert.deepEqual(f.load().bylineGate, expected);
  f.input.bylineGate = { overall: 10, sourcing: 0, maxDraftAttempts: 5 };
  const config = f.load();
  assert.deepEqual(config.bylineGate, { ...expected, ...f.input.bylineGate });
  assert.deepEqual(config.gate, DEFAULTS.gate);
  config.bylineGate.overall = 1;
  assert.deepEqual(DEFAULTS.bylineGate, expected);
  for (const key of Object.keys(expected)) {
    for (const value of key === 'maxDraftAttempts' ? [0, 6, 1.5, '3', null] : [-1, 11, 1.5, '8', null]) {
      f.input.bylineGate = { [key]: value };
      assert.throws(f.load, (e) => e instanceof ConfigError && e.message.includes(`bylineGate.${key}`));
    }
  }
  f.input.bylineGate = { maxDraftAttempts: 1 };
  assert.equal(f.load().bylineGate.maxDraftAttempts, 1);
});
