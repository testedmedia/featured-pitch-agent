'use strict';

const SCORE_KEYS = ['fit', 'thesis_match', 'authenticity', 'specificity', 'lie_risk', 'ai_likelihood', 'fabrication_risk', 'overall'];
const FLOOR_KEYS = ['overall', 'lie_risk', 'fabrication_risk', 'ai_likelihood', 'thesis_match'];

function validateScore(obj) {
  const score = {};
  const badKeys = [];
  const input = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  for (const key of SCORE_KEYS) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 10) {
      badKeys.push(key);
    } else {
      score[key] = Math.round(value);
    }
  }
  score.verdict = input.verdict === undefined ? 'fix' : input.verdict;
  score.notes = input.notes === undefined ? '' : input.notes;
  if (!['approve', 'fix', 'drop'].includes(score.verdict)) badKeys.push('verdict');
  if (typeof score.notes !== 'string') badKeys.push('notes');
  if (badKeys.length) throw new Error(`Invalid score keys: ${badKeys.join(', ')}`);
  return score;
}

function gateFailures(score, gate) {
  return FLOOR_KEYS.filter((key) => {
    const value = score?.[key];
    return typeof value !== 'number' || !Number.isFinite(value) || value < gate[key];
  }).map((key) => `${key} ${score?.[key]} < ${gate[key]}`);
}

function gatePassed(score, gate) {
  return Boolean(score) && gateFailures(score, gate).length === 0;
}

module.exports = { SCORE_KEYS, validateScore, gatePassed, gateFailures };
