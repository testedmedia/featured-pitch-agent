'use strict';

const fs = require('fs');
const path = require('path');

const AGENT_HOME = path.resolve(process.env.FEATURED_AGENT_HOME || path.join(__dirname, '..'));
const CONFIG_FILE = process.env.FEATURED_CONFIG || path.join(AGENT_HOME, 'config', 'seats.json');
const DATA_DIR = process.env.FEATURED_DATA_DIR || path.join(AGENT_HOME, 'data');
const STATE_FILE = path.join(DATA_DIR, 'browser-state.json');
const LOCK_FILE = path.join(DATA_DIR, 'pipeline.lock');
const USAGE_LEDGER = path.join(DATA_DIR, 'llm-usage.jsonl');
const SUBMITTED_LEDGER = path.join(DATA_DIR, 'submitted.jsonl');
const RUNS_DIR = path.join(DATA_DIR, 'runs');

// Reads AGENT_HOME/.env (KEY=VALUE lines). Never overrides a variable already set in the shell.
function loadEnvFile(home = AGENT_HOME) {
  const file = path.join(home, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function newRunDir(now = new Date(), runsDir = RUNS_DIR) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  fs.mkdirSync(runsDir, { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    const dir = path.resolve(runsDir, stamp + (attempt === 1 ? '' : `-${attempt}`));
    try {
      fs.mkdirSync(dir);
      return dir;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (arguments.length > 1) return fallback;
      throw new Error(`JSON file not found: ${file}`);
    }
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${e.message}`);
  }
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // An interrupted append must not hide earlier complete ledger entries.
    }
  }
  return rows;
}

module.exports = {
  loadEnvFile,
  AGENT_HOME, CONFIG_FILE, DATA_DIR, STATE_FILE, LOCK_FILE, USAGE_LEDGER,
  SUBMITTED_LEDGER, RUNS_DIR, newRunDir, writeJsonAtomic, readJson, appendJsonl, readJsonl,
};
