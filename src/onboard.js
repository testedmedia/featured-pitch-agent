'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { AGENT_HOME, CONFIG_FILE, readJson, writeJsonAtomic } = require('./paths');
const { DEFAULTS, loadConfig, printConfigSummary } = require('./config');

const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const slug = (brand) => brand.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/g, '');

function uniqueKey(base, used) {
  let key = base;
  for (let suffix = 2; used.has(key); suffix += 1) {
    const ending = `_${suffix}`;
    key = base.slice(0, 40 - ending.length) + ending;
  }
  used.add(key);
  return key;
}

function buildConfigFromAnswers(answers) {
  const problems = [];
  if (!isObject(answers)) throw new Error('Answers must be an object');
  if (answers.global !== undefined && !isObject(answers.global)) problems.push('global must be an object');
  const global = isObject(answers.global) ? answers.global : {};
  const filters = { ...DEFAULTS.filters, ...global };
  function checkRange(minDa, maxDa, label) {
    for (const [field, value] of Object.entries({ minDa, maxDa })) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        problems.push(`${label}.${field} must be a number 0..100`);
      }
    }
    if (typeof minDa === 'number' && typeof maxDa === 'number' && minDa > maxDa) {
      problems.push(`${label}.minDa must be <= maxDa`);
    }
  }
  function checkPicks(value, label) {
    if (!Number.isInteger(value) || value < 1) problems.push(`${label} must be a positive integer`);
  }
  checkRange(filters.minDa, filters.maxDa, 'global');
  checkPicks(filters.maxPicksPerSeatPerRun, 'global.maxPicksPerSeatPerRun');
  if (typeof filters.includeStretch !== 'boolean') problems.push('global.includeStretch must be a boolean');
  if (!Array.isArray(answers.seats) || answers.seats.length === 0) problems.push('seats must be a non-empty array');
  const rawSeats = Array.isArray(answers.seats) ? answers.seats : [];
  const profiles = new Set();
  rawSeats.forEach((seat, index) => {
    const label = `seats[${index}]`;
    if (!isObject(seat)) {
      problems.push(`${label} must be an object`);
      return;
    }
    for (const field of ['brand', 'displayName']) {
      if (!isText(seat[field])) problems.push(`${label}.${field} must be a non-empty string`);
    }
    if (isText(seat.brand) && slug(seat.brand).length < 2) problems.push(`${label}.brand must produce a key of at least two characters`);
    if (typeof seat.profileId !== 'string' || !/^\d+$/.test(seat.profileId)) problems.push(`${label}.profileId must be a string of digits`);
    if (profiles.has(seat.profileId)) problems.push(`${label}.profileId is duplicated: ${seat.profileId}`);
    profiles.add(seat.profileId);
    if (seat.niche !== undefined && typeof seat.niche !== 'string') problems.push(`${label}.niche must be a string`);
    for (const field of ['topics', 'approvedFacts', 'notTopics', 'credentialsNotHeld', 'bannedClaims']) {
      const required = field === 'topics' || field === 'approvedFacts';
      const values = seat[field] === undefined && !required ? [] : seat[field];
      if (!Array.isArray(values) || !values.every(isText) || (required && values.length === 0)) {
        problems.push(`${label}.${field} must be a ${required ? 'non-empty ' : ''}string array`);
      }
    }
    if (seat.autoSubmit !== undefined && typeof seat.autoSubmit !== 'boolean') problems.push(`${label}.autoSubmit must be a boolean`);
    if (seat.statsUrl != null) {
      let valid = false;
      try {
        valid = typeof seat.statsUrl === 'string' && seat.statsUrl.startsWith('https://') && new URL(seat.statsUrl).protocol === 'https:';
      } catch {
        // Report URL errors alongside all other answer problems.
      }
      if (!valid) problems.push(`${label}.statsUrl must be null or an https URL`);
    }
    checkRange(seat.minDa ?? filters.minDa, seat.maxDa ?? filters.maxDa, label);
    checkPicks(seat.maxPicksPerRun ?? filters.maxPicksPerSeatPerRun, `${label}.maxPicksPerRun`);
  });
  if (problems.length) throw new Error(problems.join('\n'));

  const used = new Set();
  const claimsFiles = {};
  const seats = rawSeats.map((answer) => {
    const brand = answer.brand.trim();
    const displayName = answer.displayName.trim();
    const key = uniqueKey(slug(brand), used);
    const credentials = (answer.credentialsNotHeld || []).map((value) => value.trim());
    const claimsFile = `config/claims/${key}.md`;
    claimsFiles[claimsFile] = [
      `# Approved facts for ${brand}`,
      'ONLY facts in this file may be stated as fact in a pitch. Everything else must be framed as opinion.',
      ...answer.approvedFacts.map((fact) => `- ${fact.trim()}`),
      '',
    ].join('\n');
    const seat = {
      key, profileId: answer.profileId, displayName, brand,
      persona: `${displayName} at ${brand}: ${(answer.niche || '').trim()}.` + (credentials.length ? ` Not: ${credentials.join(', ')}.` : ''),
      topics: answer.topics.map((value) => value.trim()),
      notTopics: (answer.notTopics || []).map((value) => value.trim()),
      bans: credentials.length ? `Never claim to be, or speak with the authority of: ${credentials.join(', ')}. Decline any question that needs one.` : '',
      banPatterns: (answer.bannedClaims || []).map((value) => {
        const word = value.trim();
        return { label: `banned:${word}`, regex: `\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, flags: 'i' };
      }),
      claimsFile, statsUrl: answer.statsUrl ?? null, autoSubmit: answer.autoSubmit ?? false, enabled: true,
    };
    for (const field of ['minDa', 'maxDa', 'maxPicksPerRun']) {
      if (answer[field] != null) seat[field] = answer[field];
    }
    return seat;
  });
  return { config: { filters, seats }, claimsFiles };
}

async function interactiveAnswers() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  async function ask(question, help, fallback = '') {
    process.stdout.write(`${help}\n${question}${fallback !== '' ? ` [${fallback}]` : ''}: `);
    const line = await lines.next();
    if (line.done) throw new Error('Input ended before onboarding was complete');
    return line.value.trim() || fallback;
  }
  const list = (value) => value.split(',').map((part) => part.trim()).filter(Boolean);
  async function number(question, help, fallback) {
    const value = await ask(question, help, fallback);
    return value === '' ? null : Number(value);
  }
  async function yesNo(question, help) {
    while (true) {
      const value = (await ask(question, help, 'N')).toLowerCase();
      if (['n', 'no'].includes(value)) return false;
      if (['y', 'yes'].includes(value)) return true;
      process.stdout.write('Please answer y or n.\n');
    }
  }
  try {
    const global = {
      minDa: await number('Minimum DA', 'lower-DA sites link back more often; 0 keeps everything', '0'),
      maxDa: await number('Maximum DA', 'Use a number from 0 to 100.', '100'),
      includeStretch: await yesNo('Include stretch fits? (y/N)', 'Stretch fits are related questions outside your core expertise.'),
      maxPicksPerSeatPerRun: await number('Max pitches per seat per run', 'Limit how many pitches each seat drafts in one run.', '10'),
    };
    const seats = [];
    do {
      const seat = {};
      seat.brand = await ask('Brand or company name', 'Use the brand this expert represents.');
      seat.displayName = await ask('Featured profile name', 'Enter the name exactly as shown on the Featured profile.');
      seat.profileId = await ask('Featured profile ID', 'open any question, switch the answering profile, copy the number after profileId= in the URL');
      seat.niche = await ask('Niche', 'In one or two sentences, describe what you do and who you serve.');
      seat.topics = list(await ask('Topics you can speak on', 'Separate topics with commas.'));
      seat.notTopics = list(await ask('Topics never routed to you', 'Separate excluded topics with commas, or leave blank.'));
      seat.credentialsNotHeld = list(await ask('Credentials you do NOT hold', 'List credentials you must never claim, separated by commas.'));
      seat.bannedClaims = list(await ask('Banned words or claims', 'Separate literal words or claims with commas, or leave blank.'));
      seat.approvedFacts = [];
      while (true) {
        const fact = await ask('Approved fact', 'One fact per line: years in business, team size, pricing, or proven results. Blank finishes.');
        if (!fact) break;
        seat.approvedFacts.push(fact);
      }
      seat.statsUrl = await ask('Statistics page URL', 'Optional: enter an https URL or leave blank.') || null;
      seat.minDa = await number('Minimum DA for this seat', 'Press Enter to use the global minimum.', '');
      seat.maxDa = await number('Maximum DA for this seat', 'Press Enter to use the global maximum.', '');
      seat.maxPicksPerRun = await number('Max pitches per run for this seat', 'Press Enter to use the global limit.', '');
      seat.autoSubmit = await yesNo('Auto-submit passed pitches without asking? (y/N)', 'NO means every pitch waits on the review page for your approval.');
      seats.push(seat);
    } while (await yesNo('Add another seat? (y/N)', 'Add another expert profile, or finish onboarding.'));
    return { global, seats };
  } finally {
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let from;
  let force = false;
  let add = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--from' && args[index + 1] && !args[index + 1].startsWith('--')) {
      from = args[++index];
    } else if (args[index] === '--force') {
      force = true;
    } else if (args[index] === '--add') {
      add = true;
    } else {
      throw new Error('Usage: node src/onboard.js [--from answers.json] [--force] [--add]');
    }
  }
  const exists = fs.existsSync(CONFIG_FILE);
  if (exists && !force && !add) throw new Error('Config already exists. Use --force to overwrite or --add to append seats.');
  let existing;
  if (exists && add) {
    loadConfig();
    existing = readJson(CONFIG_FILE);
  }
  const answers = from ? readJson(from) : await interactiveAnswers();
  // Appended seats inherit the saved global filters, just like existing seats.
  const built = buildConfigFromAnswers(existing ? { ...answers, global: { ...DEFAULTS.filters, ...existing.filters } } : answers);
  if (existing) {
    const used = new Set(existing.seats.map((seat) => seat.key));
    const profiles = new Set(existing.seats.map((seat) => seat.profileId));
    const duplicates = built.config.seats.filter((seat) => profiles.has(seat.profileId));
    if (duplicates.length) throw new Error(duplicates.map((seat) => `profileId is duplicated: ${seat.profileId}`).join('\n'));
    const claimsFiles = {};
    for (const seat of built.config.seats) {
      const text = built.claimsFiles[seat.claimsFile];
      seat.key = uniqueKey(slug(seat.brand), used);
      seat.claimsFile = `config/claims/${seat.key}.md`;
      claimsFiles[seat.claimsFile] = text;
    }
    built.claimsFiles = claimsFiles;
    built.config = { ...existing, seats: [...existing.seats, ...built.config.seats] };
  }
  for (const [relativePath, text] of Object.entries(built.claimsFiles)) {
    const file = path.resolve(AGENT_HOME, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  writeJsonAtomic(CONFIG_FILE, built.config);
  printConfigSummary(loadConfig());
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { buildConfigFromAnswers };
