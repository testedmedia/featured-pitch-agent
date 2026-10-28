'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { preflight, FABRICATION_PATTERNS, SLOP_WORDS, SENTINELS } = require('../src/preflight');

const config = { pitch: { minChars: 500, maxChars: 2200 }, bannedBodyTokens: ['Jane'] };
const seat = { banPatterns: [] };
const clean = 'I keep a written record of each task and check the details before I pass the work along. '.repeat(12).slice(0, 899) + '.';
const check = (text) => preflight(`${clean} ${text}`, seat, config);

test('clean 900-character pitch passes; configurable length limits are inclusive', () => {
  assert.equal(clean.length, 900);
  assert.deepEqual(preflight(clean, seat, config), []);
  const bounded = { ...config, pitch: { minChars: 900, maxChars: 901 } };
  assert.deepEqual(preflight(clean.slice(1), seat, bounded), ['len:899']);
  assert.deepEqual(preflight(clean, seat, bounded), []);
  assert.deepEqual(preflight(clean + ' ', seat, bounded), []);
  assert.deepEqual(preflight(clean + '  ', seat, bounded), ['len:902']);
});

test('sentinels are literal and seat bans do not retain regex state', () => {
  assert.deepEqual(SENTINELS, ['\u2014', '\u2013', ' -- ', 'SKIP', 'TODO', 'FIXME', 'PLACEHOLDER']);
  for (const token of SENTINELS) assert.ok(check(token).includes(`banned:${token}`), token);
  assert.deepEqual(check('skip todo placeholder'), []);
  const bannedSeat = { banPatterns: [{ label: 'accuracy-claim', re: /perfect accuracy/gi }] };
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(preflight(`${clean} Perfect accuracy.`, bannedSeat, config), ['seat-ban:accuracy-claim']);
  }
  assert.equal(bannedSeat.banPatterns[0].re.lastIndex, 0);
  assert.deepEqual(check('gratis free app App Store'), []);
});

test('configured names and slop use escaped, case-insensitive whole words', () => {
  assert.deepEqual(check('JANE'), ['banned-name:Jane']);
  assert.deepEqual(check('Janet'), []);
  const literal = { ...config, bannedBodyTokens: ['Example.Co'] };
  assert.deepEqual(preflight(`${clean} EXAMPLE.CO`, seat, literal), ['banned-name:Example.Co']);
  assert.deepEqual(preflight(`${clean} ExampleXCo`, seat, literal), []);
  assert.deepEqual(SLOP_WORDS, ['delve', 'leverage', 'elevate', 'harness', 'navigate the', 'realm', 'tapestry', 'ever-evolving', 'myriad', 'plethora', 'underscore', 'synergy', 'paradigm', 'transformative', 'supercharge', 'cutting-edge', 'state-of-the-art', 'game-changer', 'revolutionize', 'world-class', 'seamless']);
  for (const word of SLOP_WORDS) assert.deepEqual(check(word.toUpperCase()), [`slop:${word}`]);
  assert.deepEqual(check('leveraged realms'), []);
});

test('each structural pattern rejects its source example', () => {
  const examples = [
    ['neg-parallel-split', "Teams don't automate a task. They automate a title."],
    ['neg-parallel-comma', "It isn't one job, it's twenty small tasks."],
    ['neg-parallel-cant', "AI can carry the repeatable half. It can't carry the parts."],
    ['tailing-negation', 'Not just more listings to gamble on.'],
    ['authority-trope', 'The real question is how long this takes.'],
    ['engineered-closer', 'Scope the task before you cut the title.'],
    ['aphorism-formula', "It becomes tomorrow's clutter."],
  ];
  for (const [label, example] of examples) assert.ok(check(example).includes(`ai-structure:${label}`), label);
  assert.ok(check('Remember to check the steps.').includes('ai-structure:engineered-closer'));
  assert.deepEqual(check('Scope the task before you cut the title. I write each step on paper.'), []);
});

test('false attribution and every fabrication pattern are rejected in gate order', () => {
  for (const owner of ['my own', 'our own', 'our internal', 'my internal']) {
    for (const noun of ['numbers', 'data', 'figures', 'stats']) {
      assert.deepEqual(check(`${owner} ${noun}`), ['false-attribution:claims_proprietary_data']);
    }
  }
  const examples = [
    'a client', 'we tested', 'the month I', 'make payroll', 'retainers',
    'when I started', 'cost-per-booked-job', '50% of our', 'in my first', 'after reviewing',
  ];
  assert.equal(FABRICATION_PATTERNS.length, examples.length);
  FABRICATION_PATTERNS.forEach((pattern, i) => {
    assert.deepEqual(check(examples[i]), [`fab-pattern:${pattern.source}`], examples[i]);
  });
  const bannedSeat = { banPatterns: [{ label: 'claim', re: /claim/ }] };
  const body = 'claim TODO Jane leverage. The real question is our own data. We tested.';
  assert.deepEqual(preflight(body, bannedSeat, config), [
    `len:${body.length}`, 'seat-ban:claim', 'banned:TODO', 'banned-name:Jane',
    'slop:leverage', 'ai-structure:authority-trope', 'false-attribution:claims_proprietary_data',
    `fab-pattern:${FABRICATION_PATTERNS[1].source}`,
  ]);
});
