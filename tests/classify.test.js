'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mergeBatch, classifyQuestions } = require('../src/classify');
const helpers = fs.existsSync(path.join(__dirname, '../src/llm.js')) ? require('../src/llm') : {
  extractJsonArray(text) { return JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)); },
};
const seat = {
  key: 'example_founder', displayName: 'Jane Example', brand: 'Example Co',
  persona: 'Founder', topics: ['operations'], notTopics: ['medicine'], bans: '',
};
const config = { seats: [seat], seatsByKey: { [seat.key]: seat }, models: { classifier: 'sonnet' } };
const item = (index) => ({ url: `https://www.connectively.us/questions/${index}`, text: `Question ${index}`, da: 15 });

test('valid batches merge by local index without mutating the input', () => {
  const original = [null, null, null];
  const merged = mergeBatch(original, 1, 2, [
    { i: 1, fits: [{ seat: seat.key, strength: 'strong', angle: 'Operations' }] },
    { i: 0, fits: [], skip: 'No fit' },
  ], [seat.key]);
  assert.deepEqual(original, [null, null, null]);
  assert.equal(merged[0], null);
  assert.equal(merged[1].skip_reason, 'No fit');
  assert.deepEqual(merged[2].fits, [{ seat: seat.key, strength: 'strong', angle: 'Operations' }]);
});

test('out-of-range and non-integer indices are ignored', () => {
  const arr = [-1, 2, 1.5, '0', null, undefined].map((i) => ({ i, fits: [] }));
  assert.deepEqual(mergeBatch([null, null], 0, 2, [null, ...arr], [seat.key]), [null, null]);
});

test('unknown seats are dropped and strength is normalized', () => {
  const merged = mergeBatch([null], 0, 1, [{ i: 0, fits: [
    { seat: 'unknown', strength: 'strong' }, null,
    { seat: seat.key, strength: 'strong' }, { seat: seat.key, strength: 'weak' },
  ] }], [seat.key]);
  assert.deepEqual(merged[0].fits.map((fit) => fit.strength), ['strong', 'stretch']);
  assert.equal(merged[0].skip_reason, null);
});

test('classification filters rows, batches concurrently, and counts missing answers as failed', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const llm = {
    ...helpers,
    async callClaude(args) {
      const call = calls++;
      active++;
      peak = Math.max(active, peak);
      assert.equal(args.stage, 'classify');
      assert.equal(args.timeoutMs, 240000);
      assert.equal(args.retries, 1);
      assert.equal(args.model, 'sonnet');
      await new Promise((resolve) => setTimeout(resolve, call === 0 ? 8 : 1));
      active--;
      return JSON.stringify(call === 0 ? [
        { i: 0, fits: [{ seat: seat.key, strength: 'strong' }] }, { i: 1, fits: [], skip: 'No fit' },
      ] : []);
    },
  };
  const result = await classifyQuestions([null, {}, item(0), item(1), item(2)], {
    config, batchSize: 2, concurrency: 2, llm, retryBaseMs: 1, maxAttempts: 2,
  });
  assert.equal(peak, 2);
  assert.equal(calls, 2);
  assert.deepEqual([result.total, result.anyFit, result.noFit, result.failed], [3, 1, 1, 1]);
  assert.equal(result.items[0].url, item(0).url);
  assert.equal(result.items[2].skip_reason, 'CLASSIFY_FAILED');
});

test('an exhausted batch marks every row CLASSIFY_FAILED', async () => {
  let calls = 0;
  const llm = { ...helpers, async callClaude() { calls++; throw new Error('Unavailable'); } };
  const result = await classifyQuestions([item(0), item(1)], { config, llm, retryBaseMs: 1, maxAttempts: 2 });
  assert.equal(calls, 2);
  assert.deepEqual([result.anyFit, result.noFit, result.failed], [0, 0, 2]);
  assert.ok(result.items.every((row) => row.skip_reason === 'CLASSIFY_FAILED'));
});

test('a failed batch retries and recovers', async () => {
  let calls = 0;
  const llm = { ...helpers, async callClaude() {
    if (++calls === 1) return 'Invalid response';
    return JSON.stringify([{ i: 0, fits: [{ seat: seat.key, strength: 'stretch' }] }]);
  } };
  const result = await classifyQuestions([item(0)], { config, llm, retryBaseMs: 1, maxAttempts: 2 });
  assert.equal(result.anyFit, 1);
  assert.equal(result.failed, 0);
  assert.equal(calls, 2);
});
