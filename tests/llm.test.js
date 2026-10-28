'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildClaudeArgs, callClaude, isCapacityError, extractJsonObject,
  extractJsonArray, parseDraft } = require('../src/llm');

const fixture = path.join(__dirname, 'fixtures', 'fake-claude.js');

function setup(t, mode = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-llm-'));
  const env = { CLAUDE_BIN: fixture, FAKE_CLAUDE_MODE: mode,
    FAKE_CLAUDE_COUNTER: path.join(dir, 'counter'), FEATURED_LLM_RETRY_MS: '10' };
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { system: 'Return the requested text.', prompt: 'A journalist question.\nWith a second line.',
    retries: 1, usageLedger: path.join(dir, 'usage.jsonl') };
}

test('Claude arguments match the contract exactly and disable tools', () => {
  const args = buildClaudeArgs({ system: 'System text', model: 'sonnet' });
  assert.deepEqual(args, ['-p', '--system-prompt', 'System text', '--model', 'sonnet',
    '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config',
    '{"mcpServers":{}}', '--setting-sources', '']);
  assert.equal(args.some((arg) => /dangerously/.test(arg)), false);
});

test('call-time executable receives the complete prompt through stdin', async (t) => {
  const options = setup(t);
  options.prompt = 'A long question.\n'.repeat(20000);
  assert.equal(await callClaude(options), `ECHO:${options.prompt}`);
  assert.deepEqual(fs.readdirSync(path.join(os.tmpdir(), 'featured-agent-llm-cwd')), []);
});

test('successful calls append usage ledger rows', async (t) => {
  const options = { ...setup(t), stage: 'drafter', model: 'sonnet' };
  await callClaude(options);
  await callClaude(options);
  const lines = fs.readFileSync(options.usageLedger, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const row = JSON.parse(line);
    assert.equal(Number.isNaN(Date.parse(row.at)), false);
    assert.deepEqual(row, { at: row.at, stage: 'drafter', model: 'sonnet',
      cost_usd: 0.001, input_tokens: 5, output_tokens: 7 });
  }
});

test('ledger write failure does not fail a successful call', async (t) => {
  const options = setup(t);
  options.usageLedger = path.dirname(options.usageLedger);
  assert.equal(await callClaude(options), `ECHO:${options.prompt}`);
});

test('is_error envelope rejects with subtype and exit code without the prompt', async (t) => {
  const options = setup(t, 'error');
  await assert.rejects(callClaude(options), (err) => {
    assert.match(err.message, /claude cli: error_during_execution \(exit 0\)/);
    assert.equal(err.message.includes(options.prompt), false);
    return true;
  });
  assert.equal(fs.existsSync(options.usageLedger), false);
});

test('timeout terminates the child and rejects promptly', async (t) => {
  const options = setup(t, 'sleep');
  const start = Date.now();
  await assert.rejects(callClaude({ ...options, timeoutMs: 500 }), /timed out after 500 ms.*SIGTERM/);
  assert.ok(Date.now() - start < 5000);
  assert.equal(fs.existsSync(options.usageLedger), false);
});

test('capacity failure succeeds on retry and records only the successful call', async (t) => {
  const options = setup(t, 'flaky');
  assert.equal(await callClaude({ ...options, retries: 2 }), `ECHO:${options.prompt}`);
  assert.equal(fs.readFileSync(process.env.FAKE_CLAUDE_COUNTER, 'utf8'), '2');
  assert.equal(fs.readFileSync(options.usageLedger, 'utf8').trim().split('\n').length, 1);
});

test('retries is the total attempt count and errors include exit code and stderr', async (t) => {
  const options = setup(t, 'flaky');
  await assert.rejects(callClaude(options), /claude cli failed \(exit 1\): overloaded/);
  assert.equal(fs.readFileSync(process.env.FAKE_CLAUDE_COUNTER, 'utf8'), '1');
});

test('missing executable rejects without echoing the prompt', async (t) => {
  const options = setup(t);
  process.env.CLAUDE_BIN = path.join(path.dirname(options.usageLedger), 'missing');
  await assert.rejects(callClaude(options), /spawn failed \(ENOENT\).*exit/);
});

test('fake CLI rejects missing tool restrictions', () => {
  const result = spawnSync(fixture, ['--system-prompt', 'System text'], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.equal(result.stderr, 'bad args');
  assert.equal(fs.statSync(fixture).mode & 0o777, 0o755);
});

test('capacity detection covers capacity signals without treating all errors as capacity', () => {
  for (const text of ['overloaded', 'rate-limit', 'rate limit', 'CAPACITY', '429', '529', 'usage limit', 'too many requests']) {
    assert.equal(isCapacityError(new Error(text)), true, text);
  }
  assert.equal(isCapacityError(new Error('invalid JSON')), false);
  assert.equal(isCapacityError(null), false);
});

test('JSON extraction accepts surrounding prose and nested JSON', () => {
  assert.deepEqual(extractJsonObject('Before {"nested":{"values":[1,2]}} after'), { nested: { values: [1, 2] } });
  assert.deepEqual(extractJsonArray('Before [{"values":[1]},2] after'), [{ values: [1] }, 2]);
  assert.deepEqual(extractJsonObject('An empty {} object'), {});
  assert.deepEqual(extractJsonArray('An empty [] array'), []);
  assert.throws(() => extractJsonObject('No object'), /No JSON object/);
  assert.throws(() => extractJsonArray('No array'), /No JSON array/);
  assert.throws(() => extractJsonObject('{invalid}'), SyntaxError);
  assert.throws(() => extractJsonArray('[invalid]'), SyntaxError);
});

test('draft parsing preserves objects and distinguishes declines from chat artifacts', () => {
  assert.deepEqual(parseDraft('Intro {"pitch_body":"A quote.","thesis":"A point."} end'),
    { pitch_body: 'A quote.', thesis: 'A point.' });
  assert.deepEqual(parseDraft('  This question is outside the persona.  '),
    { __decline: 'This question is outside the persona.' });
  assert.deepEqual(parseDraft('{"decline_reason":"  Outside my expertise.  "}'),
    { __decline: 'Outside my expertise.' });
  assert.deepEqual(parseDraft('{"decline_reason":"  ","pitch_body":"A quote."}'),
    { decline_reason: '  ', pitch_body: 'A quote.' });
  assert.equal(parseDraft('x'.repeat(400)).__decline.length, 300);
  assert.equal(parseDraft(JSON.stringify({ decline_reason: 'x'.repeat(400) })).__decline.length, 300);
  for (const text of ["Here's the draft, on your clipboard", 'Cmd+V to paste', 'Done',
    "I've written a draft", 'Drafted as requested', '```plain prose```']) {
    assert.throws(() => parseDraft(text), /chat register, not JSON/);
  }
  assert.throws(() => parseDraft(' '), /empty draft/);
  assert.throws(() => parseDraft('{invalid}'), SyntaxError);
});
