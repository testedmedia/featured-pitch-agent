'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildConfigFromAnswers } = require('../src/onboard');
const { loadConfig } = require('../src/config');
const { readJson, writeJsonAtomic } = require('../src/paths');

function answers() {
  return {
    global: { minDa: 0, maxDa: 100, includeStretch: false, maxPicksPerSeatPerRun: 10 },
    seats: [{
      brand: 'Example Co', displayName: 'Jane Example', profileId: '10001',
      niche: 'Residential plumbing for homeowners', topics: ['plumbing'], notTopics: ['legal advice'],
      credentialsNotHeld: ['engineer', 'attorney'], bannedClaims: ['free estimate', 'a.b(c)+[d]?'],
      approvedFacts: ['Founded in 2016.', 'A five-person team serves the fictional town of Willow Basin.'],
      statsUrl: null, minDa: null, maxDa: null, maxPicksPerRun: null, autoSubmit: false,
    }],
  };
}

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-onboard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'config', 'seats.json');
  const input = path.join(home, 'answers.json');
  const env = { ...process.env, FEATURED_AGENT_HOME: home, FEATURED_CONFIG: file, FEATURED_DATA_DIR: path.join(home, 'data') };
  const run = (args, stdin) => spawnSync(process.execPath, [require.resolve('../src/onboard'), ...args], { env, input: stdin, encoding: 'utf8', timeout: 10000 });
  return { home, file, input, env, run };
}

test('answer builder is pure and produces the specified persona, bans, claims, and inheritance', () => {
  const input = answers();
  const before = JSON.stringify(input);
  const { config, claimsFiles } = buildConfigFromAnswers(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(config.filters, input.global);
  const seat = config.seats[0];
  assert.equal(seat.key, 'example_co');
  assert.equal(seat.persona, 'Jane Example at Example Co: Residential plumbing for homeowners. Not: engineer, attorney.');
  assert.equal(seat.bans, 'Never claim to be, or speak with the authority of: engineer, attorney. Decline any question that needs one.');
  assert.equal(seat.claimsFile, 'config/claims/example_co.md');
  assert.equal(seat.autoSubmit, false);
  assert.equal(seat.enabled, true);
  assert.deepEqual(seat.topics, ['plumbing']);
  assert.deepEqual(seat.notTopics, ['legal advice']);
  for (const key of ['minDa', 'maxDa', 'maxPicksPerRun']) assert.equal(Object.hasOwn(seat, key), false);
  assert.equal(claimsFiles[seat.claimsFile], '# Approved facts for Example Co\nONLY facts in this file may be stated as fact in a pitch. Everything else must be framed as opinion.\n- Founded in 2016.\n- A five-person team serves the fictional town of Willow Basin.\n');
  assert.equal(seat.banPatterns[0].label, 'banned:free estimate');
  assert.equal(seat.banPatterns[0].regex, '\\bfree estimate\\b');
  const re = new RegExp(seat.banPatterns[0].regex, seat.banPatterns[0].flags);
  assert.equal(re.test('A FREE ESTIMATE is available'), true);
  assert.equal(re.test('free estimates'), false);
  assert.equal(seat.banPatterns[1].regex, '\\ba\\.b\\(c\\)\\+\\[d\\]\\?\\b');
  assert.doesNotThrow(() => new RegExp(seat.banPatterns[1].regex, 'i'));
  input.seats[0].credentialsNotHeld = [];
  Object.assign(input.seats[0], { minDa: 10, maxDa: 80, maxPicksPerRun: 3 });
  const updated = buildConfigFromAnswers(input).config.seats[0];
  assert.equal(updated.persona, 'Jane Example at Example Co: Residential plumbing for homeowners.');
  assert.equal(updated.bans, '');
  assert.equal(updated.minDa, 10);
  assert.equal(updated.maxDa, 80);
  assert.equal(updated.maxPicksPerRun, 3);
});

test('brand slugs stay unique and within 40 characters after truncation and suffixes', () => {
  const input = answers();
  const brands = ['!! Example  Co !!', 'Example Co', 'Example Co', 'x'.repeat(50), 'x'.repeat(50), 'Example Co 2'];
  input.seats = brands.map((brand, index) => ({ ...input.seats[0], brand, profileId: String(10001 + index) }));
  const built = buildConfigFromAnswers(input);
  const keys = built.config.seats.map((seat) => seat.key);
  assert.deepEqual(keys, ['example_co', 'example_co_2', 'example_co_3', 'x'.repeat(40), 'x'.repeat(38) + '_2', 'example_co_2_2']);
  assert.equal(Object.keys(built.claimsFiles).length, brands.length);
});

test('answer validation reports all required field errors and rejects invalid controls', () => {
  const input = answers();
  Object.assign(input.seats[0], { brand: '', displayName: '', profileId: 'not-digits', topics: [], approvedFacts: [] });
  assert.throws(() => buildConfigFromAnswers(input), (e) => {
    for (const field of ['brand', 'displayName', 'profileId', 'topics', 'approvedFacts']) assert.match(e.message, new RegExp(field));
    assert.equal(e.message.split('\n').length, 5);
    return true;
  });
  for (const value of [null, [], {}, { seats: [] }, { seats: [null] }]) assert.throws(() => buildConfigFromAnswers(value));
  for (const [field, value] of Object.entries({ autoSubmit: 'yes', minDa: -1, maxDa: 101, maxPicksPerRun: 0, statsUrl: 'http://www.connectively.us', bannedClaims: [null], niche: 42 })) {
    const invalid = answers();
    invalid.seats[0][field] = value;
    assert.throws(() => buildConfigFromAnswers(invalid), new RegExp(field));
  }
  const duplicate = answers();
  duplicate.seats.push({ ...duplicate.seats[0] });
  assert.throws(() => buildConfigFromAnswers(duplicate), /profileId is duplicated/);
  const invalidGlobal = answers();
  invalidGlobal.global = { minDa: 90, maxDa: 20, includeStretch: 'yes', maxPicksPerSeatPerRun: 0 };
  assert.throws(() => buildConfigFromAnswers(invalidGlobal), /global.minDa[\s\S]*global.maxPicksPerSeatPerRun[\s\S]*global.includeStretch/);
});

test('non-interactive onboarding writes validated files, refuses overwrite, and supports force', (t) => {
  const f = sandbox(t);
  const input = answers();
  writeJsonAtomic(f.input, input);
  let result = f.run(['--from', f.input]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /example_co \| Example Co \| profile 10001 \| DA 0-100 \| max picks 10 \| auto-submit OFF/);
  let config = loadConfig(f.file, { home: f.home });
  assert.match(config.seats[0].claims, /Founded in 2016/);
  const saved = fs.readFileSync(f.file, 'utf8');
  result = f.run(['--from', f.input]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved);
  input.seats[0].autoSubmit = true;
  writeJsonAtomic(f.input, input);
  result = f.run(['--from', f.input, '--force']);
  assert.equal(result.status, 0, result.stderr);
  config = loadConfig(f.file, { home: f.home });
  assert.equal(config.seats[0].autoSubmit, true);
  const check = spawnSync(process.execPath, [require.resolve('../src/config'), '--check'], { env: f.env, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(result.stdout, check.stdout);
  assert.equal(fs.existsSync(path.join(f.home, '.env')), false);
  assert.doesNotMatch(saved, /password/i);
});

test('add keeps existing config and claims while allocating unique seat keys', (t) => {
  const f = sandbox(t);
  const first = answers();
  first.global.minDa = 15;
  writeJsonAtomic(f.input, first);
  assert.equal(f.run(['--from', f.input, '--add']).status, 0);
  const claimsPath = path.join(f.home, 'config', 'claims', 'example_co.md');
  const claims = fs.readFileSync(claimsPath, 'utf8');
  const existing = readJson(f.file);
  existing.gate = { overall: 9 };
  writeJsonAtomic(f.file, existing);
  const next = answers();
  next.seats[0].profileId = '10002';
  next.seats[0].approvedFacts = ['A new approved fact for the additional seat.'];
  next.seats.push({ ...next.seats[0], profileId: '10003' });
  writeJsonAtomic(f.input, next);
  const result = f.run(['--from', f.input, '--add']);
  assert.equal(result.status, 0, result.stderr);
  const config = loadConfig(f.file, { home: f.home });
  assert.deepEqual(config.seats.map((seat) => seat.key), ['example_co', 'example_co_2', 'example_co_3']);
  assert.equal(config.gate.overall, 9);
  assert.equal(config.seats.every((seat) => seat.minDa === 15), true);
  assert.equal(fs.readFileSync(claimsPath, 'utf8'), claims);
  assert.match(config.seats[1].claims, /new approved fact/);
  const saved = fs.readFileSync(f.file, 'utf8');
  const duplicate = f.run(['--from', f.input, '--add']);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /profileId is duplicated/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved);
});

test('interactive onboarding collects multiple seats and defaults approval to manual review', (t) => {
  const f = sandbox(t);
  const seatLines = (id, auto) => [
    'Example Co', 'Jane Example', id, 'Residential plumbing for homeowners', 'plumbing, maintenance',
    'legal advice', 'attorney', 'free estimate', 'Founded in 2016.', 'A five-person team serves Willow Basin.',
    '', '', '', '', '', auto,
  ];
  const stdin = ['', '', '', '', ...seatLines('10001', ''), 'y', ...seatLines('10002', 'yes'), '', ''].join('\n');
  const result = f.run([], stdin);
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const config = loadConfig(f.file, { home: f.home });
  assert.equal(config.seats.length, 2);
  assert.equal(config.seats[0].autoSubmit, false);
  assert.equal(config.seats[1].autoSubmit, true);
  assert.equal(config.seats[0].maxPicksPerRun, 10);
  assert.match(result.stdout, /lower-DA sites link back more often; 0 keeps everything/);
  assert.match(result.stdout, /number after profileId= in the URL/);
  assert.match(result.stdout, /NO means every pitch waits on the review page for your approval/);
  assert.doesNotMatch(result.stdout, /password/i);
});

test('incomplete input, invalid answers, and bad CLI arguments fail without creating config', (t) => {
  const f = sandbox(t);
  let result = f.run([], '');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Input ended/);
  assert.equal(fs.existsSync(f.file), false);
  writeJsonAtomic(f.input, { seats: [] });
  result = f.run(['--from', f.input]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /seats must/);
  for (const args of [['--from'], ['--unknown']]) {
    result = f.run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  assert.equal(fs.existsSync(f.file), false);
});
