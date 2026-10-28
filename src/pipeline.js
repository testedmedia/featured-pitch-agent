'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const questionKey = (url) => String(url).split('?')[0];
const daBucket = (da) => (da >= 60 ? '60+' : da >= 40 ? '40-59' : da >= 20 ? '20-39' : '<20');

function pitchId(seatKey, da, url) {
  const hash = crypto.createHash('sha1').update(questionKey(url)).digest('hex').slice(0, 8);
  return `${seatKey}-da${da}-${hash}`;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function readLock(lockFile) {
  try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const holder = { pid: process.pid, startedAt: new Date().toISOString(), argv: process.argv.slice(2) };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify(holder), { flag: 'wx' });
      return { ok: true, holder };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const existing = readLock(lockFile);
    if ((existing && processAlive(existing.pid)) || attempt === 1) return { ok: false, holder: existing };
    try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function releaseLock(lockFile) {
  const holder = readLock(lockFile);
  if (!holder || holder.pid !== process.pid) return;
  try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function buildPairs(classified, config, { wide = false, seatKey = null } = {}) {
  const pairs = [];
  for (const seat of config.seats) {
    if (seat.enabled === false || (seatKey !== null && seat.key !== seatKey)) continue;
    for (const item of classified.items || classified) {
      const fit = (item.fits || []).find((candidate) => candidate.seat === seat.key &&
        (candidate.strength === 'strong' ||
          (candidate.strength === 'stretch' && (wide || config.filters.includeStretch))));
      if (!fit || !Number.isFinite(Number(item.da)) || item.da < seat.minDa || item.da > seat.maxDa) continue;
      pairs.push({
        url: item.url, profileId: seat.profileId, seatKey: seat.key, strength: fit.strength,
        da: item.da, publication: item.publication, text: item.text, deadline: item.deadline,
      });
    }
  }
  return pairs;
}

function byExpectedLinkYield(rates) {
  return (a, b) => {
    const yieldA = rates[daBucket(Number(a.da) || 0)] || 0;
    const yieldB = rates[daBucket(Number(b.da) || 0)] || 0;
    return yieldB - yieldA || (Number(b.da) || 0) - (Number(a.da) || 0);
  };
}

function rankPicks(fresh, config) {
  const byQuestion = new Map();
  const yieldOrder = byExpectedLinkYield(config.linkYieldByDa);
  for (const candidate of fresh) {
    const key = questionKey(candidate.url);
    if (!byQuestion.has(key)) byQuestion.set(key, []);
    byQuestion.get(key).push(candidate);
  }
  const picks = [];
  for (const candidates of byQuestion.values()) {
    const [primary, ...fallbacks] = candidates.slice().sort((a, b) =>
      Number(b.strength === 'strong') - Number(a.strength === 'strong') || yieldOrder(a, b));
    picks.push({ ...primary, fallbacks });
  }
  return picks.sort(yieldOrder);
}

function applyCaps(picks, config, { max = null } = {}) {
  const kept = [];
  const capped = [];
  const counts = new Map();
  for (const pick of picks) {
    const count = counts.get(pick.seatKey) || 0;
    if ((max !== null && kept.length >= max) || count >= config.seatsByKey[pick.seatKey].maxPicksPerRun) {
      capped.push(pick);
    } else {
      kept.push(pick);
      counts.set(pick.seatKey, count + 1);
    }
  }
  return { kept, capped };
}

function baseRecord(pick, seat, question) {
  return {
    id: pitchId(pick.seatKey, pick.da, pick.url), seatKey: pick.seatKey,
    profileId: pick.profileId, displayName: seat.displayName, brand: seat.brand,
    publication: pick.publication, da: pick.da, deadline: pick.deadline, url: pick.url, question,
    pitch_body: '', thesis: null, named_asks: null, number_used: null,
    score: null, score_last_failed: null, mechanical_last_failed: null, gate_failures: [],
    attempts: 0, status: 'held', why: null,
  };
}

async function draftAndGrade(pick, { config, llm, question }) {
  const prompts = require('./prompts');
  const { preflight } = require('./preflight');
  const gate = require('./gate');
  const seat = config.seatsByKey[pick.seatKey];
  const record = baseRecord(pick, seat, question);
  let feedback = '';
  for (let attempt = 0; attempt < config.gate.maxDraftAttempts; attempt++) {
    record.attempts++;
    let response;
    try {
      response = await llm.callClaude({
        system: prompts.draftSystem(seat, config),
        prompt: prompts.draftUser({ pick, question, feedback }),
        model: config.models.drafter, stage: 'draft',
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.drafterFailure = true;
      failure.record = record;
      throw failure;
    }
    // Only the current reply may supply the body, including after an earlier failed draft.
    Object.assign(record, { pitch_body: '', thesis: null, named_asks: null, number_used: null });
    let draft;
    try { draft = llm.parseDraft(response); } catch (error) {
      record.why = `drafter_bad_shape: ${error.message}`;
      break;
    }
    if (draft && draft.__decline) {
      record.status = 'declined';
      record.why = `drafter_declined: ${draft.__decline}`;
      break;
    }
    const body = draft && typeof draft.pitch_body === 'string' ? draft.pitch_body.trim() : '';
    if (!body) {
      record.why = 'drafter_bad_shape';
      break;
    }
    Object.assign(record, {
      pitch_body: body, thesis: draft.thesis || null,
      named_asks: Array.isArray(draft.named_asks) ? draft.named_asks : null,
      number_used: draft.number_used ?? null,
    });
    const mechanical = preflight(body, seat, config);
    if (mechanical.length) {
      record.mechanical_last_failed = mechanical;
      feedback = `\n\nYOUR PREVIOUS DRAFT FAILED THESE MECHANICAL GATES: ${mechanical.join(', ')}`;
      record.why = `mechanical_failed: ${mechanical.join(', ')}`;
      continue;
    }
    record.mechanical_last_failed = null;
    let score;
    try {
      const graded = await llm.callClaude({
        system: prompts.graderSystem(),
        prompt: prompts.graderUser({ pick, question, draft, body, seat }),
        model: config.models.grader, stage: 'grade',
      });
      score = gate.validateScore(llm.extractJsonObject(graded));
    } catch (error) {
      record.why = `grader_failed: ${error.message}`;
      break;
    }
    if (gate.gatePassed(score, config.gate)) {
      record.score = score;
      break;
    }
    record.score_last_failed = score;
    record.why = 'gate_failed';
    feedback = `\n\nYOUR PREVIOUS DRAFT SCORED BELOW THE GATE (${JSON.stringify(score)}). Rewrite to fix: ${score.notes || ''}`;
  }
  const lastScore = record.score || record.score_last_failed;
  record.gate_failures = lastScore ? gate.gateFailures(lastScore, config.gate) : [];
  if (record.status !== 'declined' && record.score && gate.gatePassed(record.score, config.gate) &&
      preflight(record.pitch_body, seat, config).length === 0) {
    record.status = 'passed';
    record.why = null;
    record.score_last_failed = null;
    record.mechanical_last_failed = null;
  } else if (!record.why) {
    record.why = 'draft or score failed';
  }
  return record;
}

async function runDraftStage(picks, { config, llm, details, runDir }) {
  const { extractQuestionText } = require('./details');
  const { writeJsonAtomic } = require('./paths');
  const result = { passed: [], held: [], declined: [], errors: [], critical: null };
  const queue = picks.slice();
  const reassigned = new Set();
  const reserved = new Map();
  for (const pick of queue) reserved.set(pick.seatKey, (reserved.get(pick.seatKey) || 0) + 1);
  let consecutiveFailures = 0;
  const pages = details.details || details;
  for (let index = 0; index < queue.length; index++) {
    const pick = queue[index];
    const key = questionKey(pick.url);
    const detailKey = Object.keys(pages).find((url) => questionKey(url) === key);
    const page = detailKey ? pages[detailKey] : null;
    const question = (page && page.full_text ? extractQuestionText(page.full_text) : '') || pick.text;
    let record;
    try {
      record = await draftAndGrade(pick, { config, llm, question });
      consecutiveFailures = 0;
    } catch (error) {
      if (!error.drafterFailure) throw error;
      // A successful draft earlier in this pick breaks an outage streak.
      consecutiveFailures = error.record && error.record.attempts > 1 ? 1 : consecutiveFailures + 1;
      result.errors.push(`draft ${pick.url}: ${error.message}`);
      record = error.record || baseRecord(pick, config.seatsByKey[pick.seatKey], question);
      record.why = `drafter_failed: ${error.message}`;
    }
    result[record.status].push(record);
    writeJsonAtomic(path.join(runDir, 'pitches', `${record.id}.json`), record);
    if (record.status === 'declined' && !reassigned.has(key)) {
      const fallback = (pick.fallbacks || []).find((item) => item.seatKey !== pick.seatKey);
      if (fallback && (reserved.get(fallback.seatKey) || 0) < config.seatsByKey[fallback.seatKey].maxPicksPerRun) {
        reassigned.add(key);
        reserved.set(fallback.seatKey, (reserved.get(fallback.seatKey) || 0) + 1);
        queue.splice(index + 1, 0, { ...fallback, fallbacks: [] });
      }
    }
    if (consecutiveFailures >= 5) {
      result.critical = `Drafting aborted: 5 consecutive drafter failures; ${queue.length - index - 1} picks left undrafted`;
      result.errors.push(result.critical);
      break;
    }
  }
  return result;
}

function parseFlags(argv) {
  const flags = { max: null, wide: false, seat: null, fromScan: null, autoSubmit: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--wide') flags.wide = true;
    else if (arg === '--auto-submit') flags.autoSubmit = true;
    else if (arg === '--help') flags.help = true;
    else if (['--max', '--seat', '--from-scan'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--max') {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--max must be a nonnegative integer');
        flags.max = Number(value);
      } else if (arg === '--seat') flags.seat = value;
      else flags.fromScan = value;
    } else throw new Error(`Unknown flag: ${arg}`);
  }
  return flags;
}

function validateOutcomes(items, outcomes) {
  if (!Array.isArray(outcomes)) throw new Error('Submit outcomes must be an array');
  const expected = new Set(items.map((item) => item.id));
  if (expected.size !== items.length) throw new Error('Duplicate submitted item IDs');
  const seen = new Set();
  for (const row of outcomes) {
    if (!row || !expected.has(row.id)) throw new Error(`Unknown outcome ID: ${row && row.id}`);
    if (seen.has(row.id)) throw new Error(`Duplicate outcome ID: ${row.id}`);
    seen.add(row.id);
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`Missing outcome IDs: ${missing.join(', ')}`);
}

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const flags = parseFlags(argv);
  if (flags.help) {
    console.log('Usage: node src/pipeline.js [--max N] [--wide] [--seat key] [--from-scan feed.json] [--auto-submit] [--help]');
    return 0;
  }
  const paths = dependencies.paths || require('./paths');
  if (paths.loadEnvFile) paths.loadEnvFile();
  const configModule = dependencies.config || require('./config');
  const log = (message) => console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
  log('step 1/8 loading config and acquiring lock');
  let config;
  try { config = configModule.loadConfig(); } catch (error) {
    if (error instanceof configModule.ConfigError) {
      console.error(error.problems.join('\n'));
      return 1;
    }
    throw error;
  }
  if (flags.seat && !Object.hasOwn(config.seatsByKey, flags.seat)) throw new Error(`Unknown or disabled seat: ${flags.seat}`);
  const lock = acquireLock(paths.LOCK_FILE);
  if (!lock.ok) {
    console.error(`Pipeline lock held: ${JSON.stringify(lock.holder)}`);
    return 1;
  }
  const onInterrupt = () => { releaseLock(paths.LOCK_FILE); process.exit(130); };
  const onTerminate = () => { releaseLock(paths.LOCK_FILE); process.exit(143); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  let report;
  let critical = false;
  let review;
  function saveReport() {
    report.finishedAt = new Date().toISOString();
    Object.assign(report.counts, {
      passed: report.passed.length, held: report.held.length, declined: report.declined.length,
      errors: report.errors.length,
      submitted: new Set(report.submitted.filter((row) => /^submitted(?:_inferred)?$/.test(row.status)).map((row) => row.id)).size,
      verified: report.submitted.filter((row) => row.verified === true).length,
    });
    paths.writeJsonAtomic(path.join(report.runDir, 'report.json'), report);
    review.writeReview(report.runDir, { report, records: [...report.passed, ...report.held, ...report.declined] });
  }
  try {
    if (!fs.existsSync(paths.STATE_FILE)) {
      console.error('No saved Featured session. Run: npm run login');
      return 1;
    }
    const runDir = paths.newRunDir();
    report = {
      startedAt: new Date().toISOString(), finishedAt: null, runDir, flags, gate: { ...config.gate },
      counts: { scanned: 0, classified: 0, anyFit: 0, noFit: 0, classifyFailed: 0, pairs: 0, fresh: 0,
        alreadyAnswered: 0, closed: 0, pageCheckErrors: 0, picks: 0, capped: 0, details: 0, drafted: 0 },
      passed: [], held: [], declined: [], errors: [], submitted: [],
    };
    review = dependencies.review || require('./review');
    const scan = dependencies.scan || require('./scan');
    const classifier = dependencies.classify || require('./classify');
    const dedupe = dependencies.dedupe || require('./dedupe');
    const detailModule = dependencies.details || require('./details');
    const llm = dependencies.llm || require('./llm');
    log('step 2/8 scanning questions');
    const feed = flags.fromScan ? paths.readJson(flags.fromScan) : await scan.scanQuestions({ config });
    paths.writeJsonAtomic(path.join(runDir, 'feed.json'), feed);
    if (!Array.isArray(feed.items)) throw new Error('Question feed has no items array');
    report.counts.scanned = feed.items.length;
    if (!flags.fromScan && (!Number.isFinite(Date.parse(feed.scannedAt)) || Date.now() - Date.parse(feed.scannedAt) > 7200000)) {
      throw new Error('Live scan is missing a fresh scannedAt timestamp (maximum age: 2 hours)');
    }
    if (!flags.fromScan && !feed.items.length) throw new Error('Live scan returned zero rows');
    log('step 3/8 classifying questions');
    const classified = await classifier.classifyQuestions(feed.items, { config, llm });
    paths.writeJsonAtomic(path.join(runDir, 'classified.json'), classified);
    Object.assign(report.counts, { classified: classified.total, anyFit: classified.anyFit,
      noFit: classified.noFit, classifyFailed: classified.failed });
    if (classified.failed > classified.total / 2) throw new Error('Classifier failed for more than half of the questions');
    log('step 4/8 building pairs and checking pages');
    const pairs = buildPairs(classified, config, { wide: flags.wide, seatKey: flags.seat });
    paths.writeJsonAtomic(path.join(runDir, 'pairs.json'), { pairs });
    report.counts.pairs = pairs.length;
    const checked = pairs.length ? await dedupe.checkPairs(pairs, { config }) : [];
    paths.writeJsonAtomic(path.join(runDir, 'dedupe.json'), checked);
    const fresh = checked.filter((row) => row.prefilter === 'fresh');
    const errors = checked.filter((row) => String(row.prefilter).startsWith('error:'));
    report.held.push(...errors.map((row) => ({ ...row, status: 'held', why: row.prefilter })));
    report.errors.push(...errors.map((row) => `Page check ${row.url}: ${row.prefilter}`));
    Object.assign(report.counts, { fresh: fresh.length, pageCheckErrors: errors.length,
      alreadyAnswered: checked.filter((row) => row.prefilter === 'already_answered').length,
      closed: checked.filter((row) => row.prefilter === 'closed').length });
    if (checked.some((row) => row.prefilter === 'session_expired')) throw new Error('Session expired. Run: npm run login');
    log('step 5/8 ranking picks and applying caps');
    const { kept, capped } = applyCaps(rankPicks(fresh, config), config, { max: flags.max });
    paths.writeJsonAtomic(path.join(runDir, 'picks.json'), { picks: kept, capped });
    report.counts.picks = kept.length;
    report.counts.capped = capped.length;
    log('step 6/8 fetching question details');
    const urls = [...new Set(kept.map((pick) => questionKey(pick.url)))];
    const details = urls.length ? await detailModule.fetchDetails(urls, { config }) : { details: {}, complete: true };
    paths.writeJsonAtomic(path.join(runDir, 'details.json'), details);
    report.counts.details = Object.values(details.details).filter((row) => row && row.full_text).length;
    log('step 7/8 drafting and grading');
    const stage = await (dependencies.runDraftStage || runDraftStage)(kept, { config, llm, details, runDir });
    for (const name of ['passed', 'held', 'declined', 'errors']) report[name].push(...stage[name]);
    report.counts.drafted = stage.passed.length + stage.held.length + stage.declined.length;
    critical = Boolean(stage.critical);
    log('step 8/8 writing report and review');
    saveReport();
    const automatic = flags.autoSubmit ? report.passed.filter((row) => config.seatsByKey[row.seatKey].autoSubmit === true) : [];
    const manual = report.passed.filter((row) => !automatic.includes(row));
    log(`${manual.length} passed pitches left for manual review`);
    if (manual.length) {
      console.log(`node src/submit.js --run ${shellQuote(runDir)} --ids ${shellQuote(manual.map((row) => row.id).join(','))} --live`);
    }
    if (automatic.length) {
      const submit = dependencies.submit || require('./submit');
      const outcomes = await submit.submitItems(automatic, { config, live: true, runDir });
      paths.writeJsonAtomic(path.join(runDir, 'submit-results.json'), outcomes);
      // Preserve returned outcomes even when accounting is invalid after a real send.
      report.submitted = Array.isArray(outcomes) ? outcomes.filter((row) => row && typeof row === 'object').map((row) => ({ ...row, verified: false })) : [];
      validateOutcomes(automatic, outcomes);
      const submittedIds = new Set(outcomes.filter((row) => ['submitted', 'submitted_inferred'].includes(row.status)).map((row) => row.id));
      const submitted = automatic.filter((row) => submittedIds.has(row.id));
      for (const outcome of outcomes) {
        if (!submittedIds.has(outcome.id) && outcome.status !== 'skip_already_answered') {
          report.errors.push(`Submit ${outcome.id}: ${outcome.status}`);
          critical = true;
        }
      }
      const verification = submitted.length ? await dedupe.checkPairs(submitted, { config }) : [];
      for (const outcome of report.submitted) {
        if (!submittedIds.has(outcome.id)) continue;
        const matching = verification.filter((row) => row.id === outcome.id);
        outcome.verified = matching.length === 1 && matching[0].prefilter === 'already_answered';
        if (!outcome.verified) report.errors.push(`Submission ${outcome.id} could not be verified server-side`);
      }
      saveReport();
    }
  } catch (error) {
    critical = true;
    console.error(error.message);
    if (report) {
      report.errors.push(error.message);
      if (review) saveReport();
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    releaseLock(paths.LOCK_FILE);
  }
  if (report) {
    log(`Counts: ${JSON.stringify(report.counts)}`);
    console.log(path.join(report.runDir, 'review.html'));
  }
  return critical ? 1 : 0;
}

module.exports = {
  pitchId, processAlive, acquireLock, releaseLock, daBucket, byExpectedLinkYield,
  buildPairs, rankPicks, applyCaps, draftAndGrade, runDraftStage, parseFlags, validateOutcomes, main,
};

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
