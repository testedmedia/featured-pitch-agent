'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeArticleHtml, renderBylineReview, writeBylineReview } = require('../src/byline-review');

function record(overrides = {}) {
  return {
    seat: 'example_founder', author: 'Jane Example', brand: 'Example Co',
    byline: { title: 'Founder', homepage: 'https://example.com/' },
    status: 'passed', why: null, attempt: 1, words: 720, fails: [],
    grade: { accuracy: 9, sourcing: 9, usefulness: 9, guideline_fit: 9, lie_risk: 9,
      ai_likelihood: 9, fabrication_risk: 9, overall: 9, notes: 'Ready to review.' },
    draft: {
      headline: 'How a checklist helps owners prepare each property', subheading: 'Keep instructions close.',
      article_html: '<h2>Check the entry</h2><p>Read the <a href="https://example.org/study">public study</a>.</p>',
      bio_html: '<p>Jane Example is the founder of <a href="https://example.com/">Example Co</a>.</p>', sources_used: [],
    },
    ...overrides,
  };
}

function staged(overrides = {}) {
  return { marks: { fix: 2, advice: 3, fixText: ['Revise the claim.'], adviceText: ['Shorten the opening.'],
    submitButtons: [{ text: 'Submit', disabled: true }], ...overrides } };
}

test('sanitizeArticleHtml neutralizes scripts, javascript links and disallowed elements', () => {
  const html = sanitizeArticleHtml('<script>alert("x")</script><a href="javascript:alert(1)">click</a><img src=x onerror=alert(1)><iframe src="https://example.org/"></iframe>');
  assert.ok(!/<script\b|<img\b|<iframe\b|<a\s/i.test(html));
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;a href=&quot;javascript:alert\(1\)&quot;&gt;/);
});

test('sanitizeArticleHtml preserves allowed formatting and strips all other attributes', () => {
  assert.equal(sanitizeArticleHtml('<p class="intro" onclick="bad()">A &amp; B <strong style="color:red">bold</strong> <em>emphasis</em></p><h2 id="entry">Entry</h2><a href="https://example.org/?a=1&amp;b=2" target="_blank" onclick="bad()">Read</a>'),
    '<p>A &amp; B <strong>bold</strong> <em>emphasis</em></p><h2>Entry</h2><a href="https://example.org/?a=1&amp;b=2">Read</a>');
  assert.equal(sanitizeArticleHtml("<A HREF='http://example.org/' title='Read'>Link</A>"), '<a href="http://example.org/">Link</a>');
  assert.equal(sanitizeArticleHtml('&lt;script&gt;bad()&lt;/script&gt;'), '&lt;script&gt;bad()&lt;/script&gt;');
});

test('sanitizeArticleHtml cannot turn malformed or encoded URLs into active content', () => {
  for (const html of [
    '<a href="&#106;avascript:alert(1)">bad</a>', '<a href="java&#10;script:alert(1)">bad</a>',
    '<a href="data:text/html,hello">bad</a>', '<a href="//example.org/">bad</a>',
    '<a title="href=\'https://example.org/\'" href="javascript:bad()">bad</a>',
    '<svg><a href="javascript:bad()">bad</a></svg>', '<a href="https://">bad</a>',
  ]) assert.ok(!sanitizeArticleHtml(html).includes('<a href='), html);
  const quote = sanitizeArticleHtml('<a href="https://example.org/?q=&quot; onclick=&quot;bad()">Link</a>');
  assert.ok(!quote.includes('<a href='));
});

test('review renders staged check counts, advice and whether Submit is enabled', () => {
  const html = renderBylineReview({ records: [record()], shotsBySeat: { example_founder: staged() } });
  assert.match(html, /2 fixes, 3 advice\. Submit enabled: No/);
  assert.match(html, /Revise the claim\./);
  assert.match(html, /Shorten the opening\./);
  const enabled = renderBylineReview({ records: [record()], shotsBySeat: {
    example_founder: staged({ fix: 0, submitButtons: [{ text: 'Submit', disabled: false }] }),
  } });
  assert.match(enabled, /0 fixes, 3 advice\. Submit enabled: Yes/);
});

test('review marks under-floor axes and accepts the configured floors', () => {
  const row = record();
  row.grade.sourcing = 7;
  let html = renderBylineReview({ records: [row] });
  assert.match(html, /<tr class="under-floor"><th scope="row">sourcing<\/th><td>7<\/td><td>8<\/td><td>Below floor/);
  html = renderBylineReview({ records: [record()], gate: { overall: 10 } });
  assert.match(html, /<tr class="under-floor"><th scope="row">overall<\/th><td>9<\/td><td>10<\/td>/);
});

test('review renders zero records with no external requests', () => {
  const html = renderBylineReview({ records: [] });
  assert.match(html, /Nothing has been submitted/);
  assert.match(html, /No byline records to review/);
  assert.ok(!/<script|<link|<img|<iframe/i.test(html));
  assert.match(html, /default-src 'none'/);
  assert.match(html, /border-radius:6px/);
  assert.match(html, /@media\(max-width:600px\)/);
});

test('review sorts passed first without mutating records and lists article and bio links', () => {
  const records = [record({ seat: 'held_seat', status: 'held', fails: ['headline_words:2'] }), record()];
  const html = renderBylineReview({ records });
  assert.ok(html.indexOf('data-seat="example_founder"') < html.indexOf('data-seat="held_seat"'));
  assert.equal(records[0].seat, 'held_seat');
  assert.match(html, /By Jane Example, Founder, Example Co, via Featured News/);
  assert.match(html, /720 words &middot; attempt 1/);
  assert.match(html, /<li>public study &rarr; <a href="https:\/\/example\.org\/study">/);
  assert.match(html, /<li>Example Co &rarr; <a href="https:\/\/example\.com\/">/);
  assert.match(html, /headline_words:2/);
  assert.match(html, /Featured AI check: not run yet/);
});

test('review escapes every dynamic text location, including errors and staged marks', () => {
  const attack = '"><script>alert(1)</script>';
  const row = record({ seat: attack, author: attack, brand: attack, byline: { title: attack },
    status: attack, words: attack, attempt: attack, why: attack, fails: [attack] });
  row.grade.notes = attack;
  row.draft.headline = attack;
  row.draft.subheading = attack;
  row.draft.article_html = '<p onclick="bad()">Article</p><a href="javascript:bad()">unsafe link</a>';
  row.draft.bio_html = '<script>bad()</script>';
  const html = renderBylineReview({ records: [row], shotsBySeat: { [attack]: staged({ fix: attack, advice: attack, fixText: [attack], adviceText: [attack] }) } });
  assert.ok(!/<script\b|<a href="javascript:|<p onclick=/i.test(html));
  assert.match(html, /&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<li>unsafe link &rarr; javascript:bad\(\)<\/li>/);
});

test('review renders records with no draft', () => {
  const html = renderBylineReview({ records: [record({ status: 'error', why: 'Source fetch failed', draft: null, grade: null })] });
  assert.match(html, /Source fetch failed/);
  assert.match(html, /No draft available/);
  assert.match(html, /Not scored/);
});

test('writeBylineReview reads the newest stamped summary per seat and writes review.html', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byline-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'shots'));
  for (const [file, summary] of [
    ['example_founder-staged-001.json', staged({ fix: 9 })],
    ['example_founder-staged-002.json', staged({ fix: 0, submitButtons: [{ text: 'Submit', disabled: false }] })],
    ['other_seat-staged-003.json', staged({ fix: 8 })],
  ]) fs.writeFileSync(path.join(dir, 'shots', file), JSON.stringify(summary));
  fs.writeFileSync(path.join(dir, 'shots', 'example_founder-staged-999.png'), 'not json');
  const file = writeBylineReview(dir, [record()], { gate: { overall: 10 } });
  assert.equal(file, path.join(dir, 'review.html'));
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /0 fixes, 3 advice\. Submit enabled: Yes/);
  assert.match(html, /Below floor/);
  assert.ok(!html.includes('9 fixes'));
});

test('writeBylineReview handles a missing shots directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byline-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = writeBylineReview(path.join(dir, 'run'), []);
  assert.match(fs.readFileSync(file, 'utf8'), /No byline records to review/);
});
