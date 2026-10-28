'use strict';

const fs = require('fs');
const path = require('path');
const { AGENT_HOME, CONFIG_FILE, readJson } = require('./paths');

const DEFAULTS = {
  baseUrl: 'https://www.connectively.us',
  models: { classifier: 'sonnet', drafter: 'sonnet', grader: 'sonnet' },
  gate: { overall: 8, lie_risk: 9, fabrication_risk: 8, ai_likelihood: 7, thesis_match: 0, maxDraftAttempts: 3 },
  bylineGate: { overall: 8, lie_risk: 9, sourcing: 8, fabrication_risk: 8, ai_likelihood: 7, guideline_fit: 8, maxDraftAttempts: 3 },
  pitch: { minChars: 500, maxChars: 2200 },
  filters: { minDa: 0, maxDa: 100, includeStretch: false, maxPicksPerSeatPerRun: 10 },
  bannedWords: [],
  linkYieldByDa: { '<20': 0.9, '20-39': 0.57, '40-59': 0.24, '60+': 0.3 },
};

class ConfigError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isStringArray = (value) => Array.isArray(value) && value.every(isText);

function deepMerge(base, override) {
  const result = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
    // Define own properties so JSON keys cannot alter an object's prototype.
    const value = Object.hasOwn(override, key) ? override[key] : base[key];
    Object.defineProperty(result, key, {
      value: isObject(value) ? deepMerge(isObject(base[key]) ? base[key] : {}, value)
        : Array.isArray(value) ? value.slice() : value,
      enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeByline(raw, seat, problems, label) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) {
    problems.push(`${label} must be an object or null`);
    return null;
  }
  for (const field of ['title', 'topic']) {
    if (!isText(raw[field])) problems.push(`${label}.${field} must be a non-empty string`);
  }
  if (!isHttpsUrl(raw.homepage)) problems.push(`${label}.homepage must be an https URL`);
  if (!Array.isArray(raw.sources) || raw.sources.length < 1 || raw.sources.length > 5) {
    problems.push(`${label}.sources must be an array of 1..5 https URLs`);
  }
  if (Array.isArray(raw.sources)) {
    raw.sources.forEach((url, index) => {
      if (!isHttpsUrl(url)) problems.push(`${label}.sources[${index}] must be an https URL`);
    });
  }
  if (raw.authorOption !== undefined && !isText(raw.authorOption)) {
    problems.push(`${label}.authorOption must be a non-empty string`);
  }
  const trim = (value) => typeof value === 'string' ? value.trim() : value;
  return {
    title: trim(raw.title), homepage: raw.homepage,
    authorOption: raw.authorOption === undefined
      ? `${trim(seat.displayName)} ${trim(raw.title)}, ${trim(seat.brand)}` : trim(raw.authorOption),
    topic: trim(raw.topic), sources: Array.isArray(raw.sources) ? raw.sources.slice() : [],
  };
}

function loadConfig(file = CONFIG_FILE, { home = AGENT_HOME } = {}) {
  let input;
  try {
    input = readJson(file);
  } catch (e) {
    throw new ConfigError([e.message]);
  }
  const problems = [];
  if (!isObject(input)) {
    problems.push('Config must be an object');
    input = {};
  }
  const config = deepMerge(DEFAULTS, input);
  if (!isHttpsUrl(config.baseUrl)) problems.push('baseUrl must be an https:// URL');
  for (const block of ['models', 'gate', 'bylineGate', 'filters', 'pitch', 'linkYieldByDa']) {
    if (!isObject(config[block])) {
      problems.push(`${block} must be an object`);
      config[block] = { ...DEFAULTS[block] };
    }
  }
  for (const [key, value] of Object.entries(config.models)) {
    if (!isText(value)) problems.push(`models.${key} must be a non-empty string`);
  }
  for (const block of ['gate', 'bylineGate']) {
    for (const [key, value] of Object.entries(config[block])) {
      const min = key === 'maxDraftAttempts' ? 1 : 0;
      const max = key === 'maxDraftAttempts' ? 5 : 10;
      if (!Number.isInteger(value) || value < min || value > max) {
        problems.push(`${block}.${key} must be an integer ${min}..${max}`);
      }
    }
  }
  function checkDa(minDa, maxDa, label) {
    for (const [key, value] of Object.entries({ minDa, maxDa })) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        problems.push(`${label}.${key} must be a number 0..100`);
      }
    }
    if (typeof minDa === 'number' && typeof maxDa === 'number' && minDa > maxDa) {
      problems.push(`${label}.minDa must be <= maxDa`);
    }
  }
  function checkPicks(value, label) {
    if (!Number.isInteger(value) || value < 1) problems.push(`${label} must be a positive integer`);
  }
  checkDa(config.filters.minDa, config.filters.maxDa, 'filters');
  checkPicks(config.filters.maxPicksPerSeatPerRun, 'filters.maxPicksPerSeatPerRun');
  if (typeof config.filters.includeStretch !== 'boolean') problems.push('filters.includeStretch must be a boolean');
  if (!isStringArray(config.bannedWords)) {
    problems.push('bannedWords must be a string array');
    config.bannedWords = [];
  }
  if (!Array.isArray(config.seats) || config.seats.length === 0) {
    problems.push('seats must be a non-empty array');
  }
  const rawSeats = Array.isArray(config.seats) ? config.seats : [];
  const keys = new Set();
  const profiles = new Set();
  const tokens = new Set(config.bannedWords);
  const seats = [];
  rawSeats.forEach((raw, index) => {
    const label = `seats[${index}]`;
    if (!isObject(raw)) {
      problems.push(`${label} must be an object`);
      return;
    }
    if (typeof raw.key !== 'string' || !/^[a-z0-9_]{2,40}$/.test(raw.key)) {
      problems.push(`${label}.key must match /^[a-z0-9_]{2,40}$/`);
    }
    if (keys.has(raw.key)) problems.push(`${label}.key is duplicated: ${raw.key}`);
    keys.add(raw.key);
    if (typeof raw.profileId !== 'string' || !/^\d+$/.test(raw.profileId)) {
      problems.push(`${label}.profileId must be a string of digits`);
    }
    if (profiles.has(raw.profileId)) problems.push(`${label}.profileId is duplicated: ${raw.profileId}`);
    profiles.add(raw.profileId);
    for (const field of ['displayName', 'brand', 'persona']) {
      if (!isText(raw[field])) problems.push(`${label}.${field} must be a non-empty string`);
    }
    if (typeof raw.displayName === 'string') {
      raw.displayName.split(/\s+/).filter((part) => part.length >= 3).forEach((part) => tokens.add(part));
    }
    if (!isStringArray(raw.topics) || raw.topics.length === 0) {
      problems.push(`${label}.topics must be a non-empty string array`);
    }
    const notTopics = raw.notTopics === undefined ? [] : raw.notTopics;
    if (!isStringArray(notTopics)) problems.push(`${label}.notTopics must be a string array`);
    const bans = raw.bans === undefined ? '' : raw.bans;
    if (typeof bans !== 'string') problems.push(`${label}.bans must be a string`);
    for (const field of ['enabled', 'autoSubmit']) {
      if (raw[field] !== undefined && typeof raw[field] !== 'boolean') problems.push(`${label}.${field} must be a boolean`);
    }
    let claimsFile = '';
    let claims = '';
    if (!isText(raw.claimsFile)) {
      problems.push(`${label}.claimsFile must name an existing claims file`);
    } else {
      claimsFile = path.resolve(home, raw.claimsFile);
      try {
        claims = fs.readFileSync(claimsFile, 'utf8');
        if (claims.replace(/\s/g, '').length < 50) problems.push(`${label}.claimsFile must contain at least 50 non-whitespace characters`);
      } catch (e) {
        problems.push(`${label}.claimsFile cannot be read: ${claimsFile} (${e.code || e.message})`);
      }
    }
    const banPatterns = [];
    const patterns = raw.banPatterns === undefined ? [] : raw.banPatterns;
    if (!Array.isArray(patterns)) {
      problems.push(`${label}.banPatterns must be an array`);
    } else {
      patterns.forEach((pattern, patternIndex) => {
        const patternLabel = `${label}.banPatterns[${patternIndex}]`;
        if (!isObject(pattern) || !isText(pattern.label) || typeof pattern.regex !== 'string'
          || (pattern.flags !== undefined && typeof pattern.flags !== 'string')) {
          problems.push(`${patternLabel} must have a label, regex string, and optional flags string`);
          return;
        }
        try {
          banPatterns.push({ label: pattern.label, re: new RegExp(pattern.regex, pattern.flags) });
        } catch (e) {
          problems.push(`${patternLabel} has an invalid regex: ${e.message}`);
        }
      });
    }
    const statsUrl = raw.statsUrl === undefined ? null : raw.statsUrl;
    if (statsUrl !== null && !isHttpsUrl(statsUrl)) problems.push(`${label}.statsUrl must be null or an https URL`);
    const byline = normalizeByline(raw.byline, raw, problems, `${label}.byline`);
    const minDa = raw.minDa ?? config.filters.minDa;
    const maxDa = raw.maxDa ?? config.filters.maxDa;
    const maxPicksPerRun = raw.maxPicksPerRun ?? config.filters.maxPicksPerSeatPerRun;
    checkDa(minDa, maxDa, label);
    checkPicks(maxPicksPerRun, `${label}.maxPicksPerRun`);
    if (raw.enabled !== false) {
      seats.push({
        key: raw.key, profileId: raw.profileId, displayName: raw.displayName, brand: raw.brand,
        persona: raw.persona, topics: raw.topics, notTopics, bans, banPatterns, claimsFile, claims,
        statsUrl, byline, minDa, maxDa, maxPicksPerRun, autoSubmit: raw.autoSubmit ?? false, enabled: true,
      });
    }
  });
  if (seats.length === 0) problems.push('At least one seat must be enabled');
  if (problems.length) throw new ConfigError(problems);
  config.seats = seats;
  config.seatsByKey = Object.fromEntries(seats.map((seat) => [seat.key, seat]));
  config.bannedBodyTokens = [...tokens];
  return config;
}

function printConfigSummary(config) {
  for (const seat of config.seats) {
    console.log(`${seat.key} | ${seat.brand} | profile ${seat.profileId} | DA ${seat.minDa}-${seat.maxDa} | max picks ${seat.maxPicksPerRun} | auto-submit ${seat.autoSubmit ? 'ON' : 'OFF'} | byline ${seat.byline ? 'ON' : 'OFF'}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== '--check' || args.length > 2) throw new Error('Usage: node src/config.js --check [file]');
  const file = args[1] || CONFIG_FILE;
  if (!fs.existsSync(file)) throw new ConfigError(['No config yet. Run: npm run onboard']);
  printConfigSummary(loadConfig(file));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { DEFAULTS, ConfigError, loadConfig, printConfigSummary, normalizeByline };
