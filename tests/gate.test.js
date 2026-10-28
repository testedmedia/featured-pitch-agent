'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SCORE_KEYS, validateScore, gatePassed, gateFailures } = require('../src/gate');

const gate = { overall: 8, lie_risk: 9, fabrication_risk: 8, ai_likelihood: 7, thesis_match: 8 };
const score = { fit: 9, thesis_match: 8, authenticity: 9, specificity: 9, lie_risk: 9, ai_likelihood: 7, fabrication_risk: 8, overall: 8, verdict: 'approve', notes: '' };

test('exact floors pass and every floor fails independently', () => {
  assert.deepEqual(SCORE_KEYS, ['fit', 'thesis_match', 'authenticity', 'specificity', 'lie_risk', 'ai_likelihood', 'fabrication_risk', 'overall']);
  assert.equal(gatePassed(validateScore(score), gate), true);
  assert.deepEqual(gateFailures(score, gate), []);
  for (const key of Object.keys(gate)) {
    const failed = { ...score, [key]: gate[key] - 1 };
    assert.equal(gatePassed(failed, gate), false, key);
    assert.deepEqual(gateFailures(failed, gate), [`${key} ${failed[key]} < ${gate[key]}`]);
  }
  assert.equal(gatePassed(null, gate), false);
  assert.equal(gatePassed({ ...score, thesis_match: 1 }, { ...gate, thesis_match: 0 }), true);
});

test('validation rejects missing, nonnumeric, nonfinite, and out-of-range axes', () => {
  for (const key of SCORE_KEYS) {
    const missing = { ...score };
    delete missing[key];
    assert.throws(() => validateScore(missing), new RegExp(key));
    for (const value of [0, 11, 0.9, 10.1, 'junk', '9', null, NaN, Infinity]) {
      assert.throws(() => validateScore({ ...score, [key]: value }), new RegExp(key));
    }
  }
  for (const invalid of [null, undefined, [], 'junk']) assert.throws(() => validateScore(invalid), /fit.*overall/);
});

test('validation rounds valid scores, defaults metadata, and rejects malformed metadata', () => {
  const input = Object.fromEntries(SCORE_KEYS.map((key) => [key, 8.6]));
  const normalized = validateScore(input);
  assert.deepEqual(normalized, { ...Object.fromEntries(SCORE_KEYS.map((key) => [key, 9])), verdict: 'fix', notes: '' });
  assert.equal(input.fit, 8.6);
  for (const verdict of ['approve', 'fix', 'drop']) assert.equal(validateScore({ ...input, verdict }).verdict, verdict);
  for (const verdict of ['yes', '', null, 1]) assert.throws(() => validateScore({ ...input, verdict }), /verdict/);
  for (const notes of [null, 1, []]) assert.throws(() => validateScore({ ...input, notes }), /notes/);
  assert.equal(validateScore({ ...input, notes: 'Needs detail.' }).notes, 'Needs detail.');
});

test('failure diagnostics list all failed floors and reject junk values', () => {
  const failed = { ...score, overall: 7, ai_likelihood: 6, thesis_match: 7 };
  assert.deepEqual(gateFailures(failed, gate), ['overall 7 < 8', 'ai_likelihood 6 < 7', 'thesis_match 7 < 8']);
  for (const value of [undefined, NaN, Infinity, '9']) assert.equal(gatePassed({ ...score, lie_risk: value }, gate), false);
  assert.equal(gateFailures(null, gate).length, 5);
});
