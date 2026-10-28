'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { classifyAnswerPage, buildAnswerUrl } = require('../src/dedupe');
const { parseDa } = require('../src/scan');
const { extractQuestionText } = require('../src/details');

test('answer classification waits for a rendered page', () => {
  assert.equal(classifyAnswerPage('Loading question...'), null);
  assert.equal(classifyAnswerPage('Characters: 0 / 2500'), null);
  assert.equal(classifyAnswerPage('Characters: 412 / 2500'), null);
  assert.equal(classifyAnswerPage('Jane Example has answered this question\nEdit Profile'), null);
});

test('an empty composer with a profile strip is fresh', () => {
  assert.equal(classifyAnswerPage('Characters: 0 / 2500\nAdd New Profile'), 'fresh');
  assert.equal(classifyAnswerPage('Characters: 0 / 2500\nEdit Profile'), 'fresh');
});

test('a stored answer is already answered even without a banner', () => {
  assert.equal(classifyAnswerPage('Characters: 412 / 2500\nEdit Profile'), 'already_answered');
});

test('another profile banner does not override an open composer', () => {
  assert.equal(classifyAnswerPage('Jane Example has answered this question\nCharacters: 0 / 2500\nEdit Profile'), 'fresh');
});

test('closed clues are sufficient and stored answers take precedence', () => {
  assert.equal(classifyAnswerPage('This question is no longer accepting answers'), 'closed');
  assert.equal(classifyAnswerPage('The deadline has passed'), 'closed');
  assert.equal(classifyAnswerPage('deadline has passed\nCharacters: 412 / 2500'), 'already_answered');
  assert.equal(classifyAnswerPage("deadline has passed\nyou've already answered"), 'already_answered');
});

test('answer URLs add and replace profileId while preserving other parameters', () => {
  const base = 'https://www.connectively.us/experts/questions/example';
  assert.equal(buildAnswerUrl(base, '10001'), `${base}?profileId=10001`);
  assert.equal(buildAnswerUrl(`${base}?profileId=10001`, '10001'), `${base}?profileId=10001`);
  const replaced = new URL(buildAnswerUrl(`${base}?status=open&profileId=old&sort=recent#answer`, '10001'));
  assert.equal(replaced.searchParams.get('profileId'), '10001');
  assert.equal(replaced.searchParams.get('status'), 'open');
  assert.equal(replaced.searchParams.get('sort'), 'recent');
  assert.equal(replaced.hash, '#answer');
  const first = new URL(buildAnswerUrl(`${base}?profileId=old&status=open`, '10001'));
  assert.equal(first.searchParams.get('status'), 'open');
  assert.deepEqual(first.searchParams.getAll('profileId'), ['10001']);
  const duplicate = new URL(buildAnswerUrl(`${base}?profileId=old&profileId=old`, '10001'));
  assert.deepEqual(duplicate.searchParams.getAll('profileId'), ['10001']);
  assert.equal(buildAnswerUrl(`${base}?profileId=10001`, null), base);
});

test('DA parsing strips non-digits and defaults to zero', () => {
  assert.equal(parseDa('DA: 57'), 57);
  assert.equal(parseDa(' 100 '), 100);
  assert.equal(parseDa(42), 42);
  assert.equal(parseDa(''), 0);
  assert.equal(parseDa('N/A'), 0);
  assert.equal(parseDa(null), 0);
  assert.equal(parseDa(undefined), 0);
});

test('question extraction matches the heading and cuts at Answer', () => {
  assert.equal(extractQuestionText('Navigation\nQuestion\nWhat helped?'), 'What helped?');
  assert.equal(extractQuestionText('Question\nWhat helped?\nGive an example.\nAnswer\nComposer'), 'What helped?\nGive an example.');
  assert.equal(extractQuestionText('No question heading'), '');
  assert.equal(extractQuestionText(''), '');
  assert.equal(extractQuestionText(`Question\n${'x'.repeat(1900)}`).length, 1800);
});

for (const name of ['login', 'scan', 'dedupe', 'details']) {
  test(`requiring ${name} does not load playwright`, () => {
    const script = `
      const assert = require('node:assert/strict');
      const Module = require('node:module');
      const original = Module._load;
      let attempts = 0;
      Module._load = function (request, ...args) {
        if (/playwright/i.test(request)) {
          attempts += 1;
          throw new Error('Playwright must remain lazy');
        }
        return original.call(this, request, ...args);
      };
      require(${JSON.stringify(require.resolve(`../src/${name}`))});
      assert.equal(attempts, 0);
      assert.equal(Object.keys(require.cache).some((file) => /playwright/i.test(file)), false);
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
