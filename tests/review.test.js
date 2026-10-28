'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderReview, writeReview } = require('../src/review');

const record = {
  id: 'pitch-1', status: 'passed', seatKey: 'example_founder', profileId: '10001',
  displayName: 'Jane Example', brand: 'Example Co', publication: 'Example publication', da: 40,
  deadline: 'Soon', url: 'https://www.connectively.us/questions/example', question: 'What is useful?',
  pitch_body: 'A clear answer.', score: { overall: 7, lie_risk: 9 }, attempts: 2,
};
const report = {
  runDir: 'data/runs/example', startedAt: '2026-01-01T12:00:00Z', finishedAt: '2026-01-01T12:05:00Z',
  flags: { gate: { overall: 8, lie_risk: 9 } }, passed: [record], held: [], declined: [], submitted: [],
};

test('question script markup is escaped and cannot add a script', () => {
  const html = renderReview({ report, records: [{ ...record, question: '<script>alert("bad")</script> & quote' }] });
  assert.ok(html.includes('&lt;script&gt;alert(&quot;bad&quot;)&lt;/script&gt; &amp; quote'));
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.ok(!html.includes('<script>alert'));
});

test('all dynamic fields are escaped and unsafe question URLs are excluded', () => {
  const unsafe = '<img src=x onerror="alert(1)">';
  const html = renderReview({
    report: { ...report, runDir: unsafe, startedAt: unsafe, flags: { gate: { overall: unsafe } } },
    records: [{ ...record, id: unsafe, displayName: unsafe, brand: unsafe, publication: unsafe,
      da: unsafe, deadline: unsafe, status: unsafe, question: unsafe, pitch_body: unsafe,
      attempts: unsafe, why: unsafe, score: { overall: unsafe }, url: 'javascript:alert(1)' }],
  });
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(!/<(?:link|iframe|img)\b|<script\s+src=/i.test(html));
});

test('submit command contains only passed ids in report order', () => {
  const second = { ...record, id: 'pitch-2' };
  const html = renderReview({ report: { ...report, passed: [record, second] }, records: [record, second] });
  assert.ok(html.includes('npm run submit -- --run data/runs/example --ids pitch-1,pitch-2 --live'));
});

test('submit command shell-quotes paths containing spaces and quotes', () => {
  const html = renderReview({ report: { ...report, runDir: "data/run's folder" }, records: [record] });
  assert.ok(html.includes('data/run&#39;\\&#39;&#39;s folder'));
});

test('under-floor axes are labeled and styled red', () => {
  const html = renderReview({ report, records: [record] });
  assert.ok(html.includes('<tr class="under-floor"><th scope="row">overall</th><td>7</td><td>8</td><td>Below floor</td>'));
  assert.ok(html.includes('.under-floor{color:#a31313;'));
  assert.ok(html.includes('<tr><th scope="row">lie_risk</th><td>9</td><td>9</td>'));
  assert.ok(html.includes('Floors used: overall: 8, lie_risk: 9'));
});

test('cards sort passed, held, declined and include excerpt, body, failures, and attempts', () => {
  const held = { ...record, id: 'held-id', status: 'held', gate_failures: ['overall 7 < 8'] };
  const declined = { ...record, id: 'declined-id', status: 'declined', why: 'No fit' };
  const passed = { ...record, question: 'x'.repeat(700) + 'TRUNCATED' };
  const html = renderReview({ report, records: [declined, held, passed] });
  assert.ok(html.indexOf('Record id: pitch-1') < html.indexOf('Record id: held-id'));
  assert.ok(html.indexOf('Record id: held-id') < html.indexOf('Record id: declined-id'));
  assert.ok(!html.includes('TRUNCATED'));
  assert.ok(html.includes('<pre id="pitch-0">A clear answer.</pre>'));
  assert.ok(html.includes('15 characters'));
  assert.ok(html.includes('Attempts: 2'));
  assert.ok(html.includes('overall 7 &lt; 8'));
  assert.ok(html.includes('No fit'));
});

test('zero records render a complete document with zero counts', () => {
  const html = renderReview({ report: { runDir: 'data/runs/empty' }, records: [] });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.endsWith('</html>'));
  assert.ok(html.includes('No records in this run.'));
  assert.ok(html.includes('passed: 0 | held: 0 | declined: 0 | submitted: 0'));
  assert.ok(html.includes('Floors used: Not recorded'));
});

test('report records can render without a separate records array', () => {
  const html = renderReview({ report });
  assert.ok(html.includes('Record id: pitch-1'));
  assert.ok(html.includes('Jane Example'));
});

test('writeReview writes review.html and shows the actual run folder', (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-review-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const file = writeReview(runDir, { report, records: [record] });
  assert.equal(file, path.join(runDir, 'review.html'));
  assert.equal(fs.readFileSync(file, 'utf8'), renderReview({ report: { ...report, runDir }, records: [record] }));
});
