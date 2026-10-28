'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { newRunDir, writeJsonAtomic, readJson, appendJsonl, readJsonl } = require('../src/paths');

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitch-paths-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('path constants honor the home, config, and data environment overrides', (t) => {
  const home = sandbox(t);
  const modulePath = require.resolve('../src/paths');
  const env = { ...process.env, FEATURED_AGENT_HOME: home };
  delete env.FEATURED_CONFIG;
  delete env.FEATURED_DATA_DIR;
  const read = () => JSON.parse(execFileSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(modulePath)})))`], { env, encoding: 'utf8' }));
  let values = read();
  assert.equal(values.AGENT_HOME, home);
  assert.equal(values.CONFIG_FILE, path.join(home, 'config', 'seats.json'));
  assert.equal(values.DATA_DIR, path.join(home, 'data'));
  env.FEATURED_CONFIG = path.join(home, 'custom.json');
  env.FEATURED_DATA_DIR = path.join(home, 'custom-data');
  values = read();
  assert.equal(values.CONFIG_FILE, env.FEATURED_CONFIG);
  assert.equal(values.DATA_DIR, env.FEATURED_DATA_DIR);
  for (const [key, filename] of Object.entries({ STATE_FILE: 'browser-state.json', LOCK_FILE: 'pipeline.lock', USAGE_LEDGER: 'llm-usage.jsonl', SUBMITTED_LEDGER: 'submitted.jsonl', RUNS_DIR: 'runs' })) {
    assert.equal(values[key], path.join(env.FEATURED_DATA_DIR, filename));
  }
  delete env.FEATURED_AGENT_HOME;
  delete env.FEATURED_CONFIG;
  delete env.FEATURED_DATA_DIR;
  assert.equal(read().AGENT_HOME, path.resolve(__dirname, '..'));
  assert.deepEqual(fs.readdirSync(home), []);
});

test('run directories use local calendar fields and collision suffixes', (t) => {
  const dir = path.join(sandbox(t), 'runs');
  const now = new Date(2001, 1, 3, 4, 5, 6);
  const first = newRunDir(now, dir);
  const second = newRunDir(now, dir);
  const third = newRunDir(now, dir);
  assert.equal(path.basename(first), '2001-02-03_040506');
  assert.equal(second, first + '-2');
  assert.equal(third, first + '-3');
  for (const file of [first, second, third]) {
    assert.equal(path.isAbsolute(file), true);
    assert.equal(fs.statSync(file).isDirectory(), true);
  }
});

test('atomic JSON writes replace content and clean temporary files on failure', (t) => {
  const file = path.join(sandbox(t), 'nested', 'config.json');
  writeJsonAtomic(file, { seats: [] });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "seats": []\n}\n');
  writeJsonAtomic(file, { enabled: true });
  assert.deepEqual(readJson(file), { enabled: true });
  const circular = {};
  circular.self = circular;
  assert.throws(() => writeJsonAtomic(file, circular), /circular/i);
  assert.deepEqual(readJson(file), { enabled: true });
  assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
  const directory = path.join(path.dirname(file), 'directory');
  fs.mkdirSync(directory);
  assert.throws(() => writeJsonAtomic(directory, {}));
  assert.equal(fs.existsSync(`${directory}.${process.pid}.tmp`), false);
});

test('JSON readers distinguish missing files from malformed or unreadable files', (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, 'missing.json');
  assert.equal(readJson(file, null), null);
  assert.equal(readJson(file, undefined), undefined);
  assert.deepEqual(readJson(file, []), []);
  assert.throws(() => readJson(file), (e) => e.message.includes(file));
  fs.writeFileSync(file, '{');
  assert.throws(() => readJson(file, null), (e) => e.message.includes(file));
  assert.throws(() => readJson(dir, null));
});

test('JSONL helpers preserve complete rows and skip blank or corrupt lines', (t) => {
  const file = path.join(sandbox(t), 'nested', 'ledger.jsonl');
  assert.deepEqual(readJsonl(file), []);
  appendJsonl(file, { id: 1 });
  fs.appendFileSync(file, '\nnot json\r\n{"unfinished":\n');
  appendJsonl(file, { id: 2 });
  appendJsonl(file, null);
  assert.deepEqual(readJsonl(file), [{ id: 1 }, { id: 2 }, null]);
  assert.equal(fs.readFileSync(file, 'utf8').endsWith('\n'), true);
  assert.throws(() => readJsonl(path.dirname(file)));
});

test('loadEnvFile reads .env without overriding variables already set', () => {
  const os = require('os');
  const fsx = require('fs');
  const pathx = require('path');
  const { loadEnvFile } = require('../src/paths');
  const home = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'fpa-env-'));
  fsx.writeFileSync(pathx.join(home, '.env'), '# comment\nFPA_TEST_A="quoted value"\nFPA_TEST_B=from-file\n\n');
  process.env.FPA_TEST_B = 'from-shell';
  delete process.env.FPA_TEST_A;
  loadEnvFile(home);
  assert.equal(process.env.FPA_TEST_A, 'quoted value');
  assert.equal(process.env.FPA_TEST_B, 'from-shell');
  loadEnvFile(pathx.join(home, 'missing'));
  delete process.env.FPA_TEST_A;
  delete process.env.FPA_TEST_B;
});
