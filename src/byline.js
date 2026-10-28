'use strict';

const path = require('path');
const { FABRICATION_PATTERNS, structureFailures } = require('./preflight');

async function fetchSourcePage(url, { fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchImpl(url, {
      method: 'GET', signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
    });
    if (!response.ok) throw new Error(`Source fetch failed: ${url} (status ${response.status})`);
    const html = await response.text();
    const links = [];
    const re = /<a\s[^>]*href="(https?:\/\/[^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = re.exec(html)) && links.length < 60) {
      const href = match[1];
      const text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text && !links.some((link) => link.href === href)) links.push({ href, text: text.slice(0, 90) });
    }
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();
    return { url, text: text.slice(0, 9000), links };
  } finally {
    clearTimeout(timer);
  }
}

function bylineSystem(seat, config, sources) {
  const news = { ...seat.byline, author: seat.displayName, company: seat.brand };
  const claims = seat.claims;
  const HUMANIZER = require('./prompts').hardRules(config).split('\n')
    .filter((line) => /HUMANIZER PATTERNS|MIRRORED PAIRS|engineered takeaway|NO AI-slop tokens|NO FABRICATED EVENTS|NO em-dashes/.test(line)).join('\n');
  const sourceBlock = sources.map((s) => `--- SOURCE PAGE ${s.url}\n${s.text}\n--- EXTERNAL LINKS ON THAT PAGE (anchor -> url)\n${s.links.filter((l) => !l.href.includes(new URL(news.homepage).hostname)).map((l) => `${l.text} -> ${l.href}`).join('\n')}`).join('\n\n');
  return `You write a bylined article for Featured News under this author: ${news.author}, ${news.title}, ${news.company}. Persona: ${seat.persona} ${seat.bans}

TOPIC AREA: ${news.topic}
Pick one specific, useful angle inside that area. A reader should finish with something they can check or do this week.

FEATURED NEWS RULES (an editor rejects the piece if any is broken):
- 700 to 1,300 words of plain prose in the author's own voice. Plain language for a general audience; define jargon and spell out acronyms on first use.
- Every factual claim is backed by evidence. Every statistic names its source AND year inside the same sentence ("a 2025 Example Co survey found..."). Use ONLY numbers that appear in the SOURCE PAGES below, with the source and year given there. If a number has no source or year in the source text, do not use it. Never invent a study, survey, figure, quote, or person.
- Present a complete picture: include at least one real limitation, risk, or case where the advice does not apply.
- Name ${news.company} at most ONCE in the body, as context, never as a pitch. No calls to action, no "contact us", no "book a call", no pricing, no promotion.
- Links: link a statistic to its original source URL from the EXTERNAL LINKS lists when one is listed for it. At most ONE link to ${new URL(news.homepage).hostname}, and only to a statistics or guide page as further reading, never the homepage, a pricing, contact, quote, booking or signup page. Never link a URL not shown below.
- Do not put the author's name, title or company line in the body; Featured adds it.
- Headline: 6 to 14 words, sentence case, states what happened or what you learned, no clickbait.
- Subheading: one or two sentences on what readers get.
- Use 2 to 4 <h2> section headings.
- Author bio: 40 to 60 words, third person, starts with "${news.author} is the ${news.title.toLowerCase()} of ${news.company}", may link the company name to ${news.homepage}, states only facts from APPROVED CLAIMS.

VOICE: a working operator explaining what they see in their field. Present tense patterns are fine ("the mistake I see over and over is..."). The DATED SPECIFIC stays banned: no named person, no single incident with a result, no month, no dollar outcome, no private test.
${HUMANIZER}
- Never "client" or "customer" after a/the/our/my/one; say homeowners, hosts, owners, buyers, people.

GROUNDING: APPROVED CLAIMS is the only source of facts about ${news.company} and the author.
=== APPROVED CLAIMS ===
${claims}
=== SOURCE PAGES ===
${sourceBlock}
=== END ===

Return ONLY raw JSON: {"headline":"...","subheading":"...","article_html":"<p>, <h2>, <strong>, <em>, <a href=\\"...\\"> only","bio_html":"<p> with at most one <a href>","sources_used":["each statistic with its source and year"]}`;
}

const countWords = (html) => html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
const plainText = (html) => html.replace(/<\/(p|h2)>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();

function bylineGates(draft, seat, sources) {
  const news = { ...seat.byline, author: seat.displayName, company: seat.brand };
  const fails = [];
  const body = String(draft.article_html || '');
  const headline = String(draft.headline || '').trim();
  const bio = String(draft.bio_html || '');
  const n = countWords(body);
  if (n < 650 || n > 1450) fails.push(`body_words:${n}`);
  const hw = headline.split(/\s+/).filter(Boolean).length;
  if (hw < 6 || hw > 14) fails.push(`headline_words:${hw}`);
  const rest = headline.split(/\s+/).slice(1).filter((w) => /^[A-Za-z]{4,}/.test(w));
  if (rest.length >= 3 && rest.filter((w) => /^[A-Z][a-z]/.test(w)).length / rest.length > 0.5) fails.push('headline_title_case');
  const bw = countWords(bio);
  if (bw < 40 || bw > 60) fails.push(`bio_words:${bw}`);
  const all = `${headline}\n${draft.subheading || ''}\n${body}\n${bio}`;
  if (/[\u2014\u2013]| -- /.test(all)) fails.push('dash');
  const companyHits = (plainText(body).match(new RegExp(news.company.replace(/\s+/g, '\\s+'), 'gi')) || []).length;
  if (companyHits > 1) fails.push(`company_named_${companyHits}x`);
  if (/\b(contact us|book a call|schedule a|sign up|free quote|get a quote|call us|download (the|our) app)\b/i.test(plainText(body))) fails.push('cta');
  if (body.includes(news.author)) fails.push('author_name_in_body');
  const allowed = new Set(sources.flatMap((s) => s.links.map((l) => l.href)).concat(news.sources));
  const host = new URL(news.homepage).hostname;
  const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const own = hrefs.filter((h) => h.includes(host));
  if (own.length > 1) fails.push(`own_domain_links:${own.length}`);
  for (const h of hrefs) {
    if (!allowed.has(h)) fails.push(`link_off_menu:${h}`);
    if (h.includes(host) && /\/(pricing|contact|quote|book|signup|demo|get-started)|^https?:\/\/[^/]+\/?$/.test(h)) fails.push(`lead_capture_link:${h}`);
  }
  const bioHrefs = [...bio.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  if (bioHrefs.length > 1 || bioHrefs.some((h) => !h.includes(host))) fails.push('bio_links');
  if (/<(?!\/?(p|h2|strong|em|a)\b)[^>]+>/i.test(body)) fails.push('disallowed_tag');
  const fab = FABRICATION_PATTERNS.find((re) => re.test(plainText(body)));
  if (fab) fails.push(`fabrication_pattern:${fab}`);
  fails.push(...structureFailures(plainText(body)).map((failure) => `structure:${failure}`));
  return fails;
}

const BYLINE_GRADER = 'Grade this bylined article for Featured News 1-10 per axis, 10 = best: accuracy (claims are correct and match the source text), sourcing (every statistic names source and year in the sentence and appears in the source text; 1-3 = a number not in the source text), usefulness (a reader can act on it), guideline_fit (plain prose, company named at most once, no promotion or CTA, includes a limitation or counterpoint, headline 6-14 words sentence case), lie_risk (10 = no false credential), ai_likelihood (10 = reads like a person wrote it; dock hard for "not X, it\'s Y", mirrored sentence pairs, rule-of-three lists, tidy aphorism endings, uniform paragraph rhythm), fabrication_risk (10 = no invented event, person, study, quote or number). Approved brand facts listed in the claims are true; do not dock them. One-sentence notes naming the worst problem.' + '\n\nReturn ONLY a raw JSON object with exactly these keys: accuracy, sourcing, usefulness, guideline_fit, lie_risk, ai_likelihood, fabrication_risk, overall, notes.';

const SCORE_KEYS = ['accuracy', 'sourcing', 'usefulness', 'guideline_fit', 'lie_risk', 'ai_likelihood', 'fabrication_risk', 'overall'];
const FLOOR_KEYS = ['overall', 'lie_risk', 'sourcing', 'fabrication_risk', 'ai_likelihood', 'guideline_fit'];

function validateBylineGrade(obj) {
  const grade = {};
  const badKeys = [];
  const input = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  for (const key of SCORE_KEYS) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 10) {
      badKeys.push(key);
    } else {
      grade[key] = Math.round(value);
    }
  }
  if (typeof input.notes !== 'string') badKeys.push('notes');
  grade.notes = input.notes;
  if (badKeys.length) throw new Error(`Invalid byline grade keys: ${badKeys.join(', ')}`);
  return grade;
}

function bylineGatePassed(grade, gate) {
  return Boolean(grade) && FLOOR_KEYS.every((key) => grade[key] >= gate[key]);
}

async function draftByline(seat, { config, llm = require('./llm'), fetchImpl } = {}) {
  const record = {
    seat: seat.key, author: seat.displayName, brand: seat.brand, byline: { ...seat.byline },
    status: 'held', why: null, attempt: 0, words: 0, fails: null, grade: null, draft: null,
  };
  let sources;
  try {
    sources = [];
    for (const url of seat.byline.sources) sources.push(await fetchSourcePage(url, { fetchImpl }));
  } catch (error) {
    return { ...record, status: 'error', why: error.message };
  }
  const system = bylineSystem(seat, config, sources);
  const sourceText = sources.map((source) => source.text).join('\n');
  let feedback = '';
  for (let attempt = 1; attempt <= config.bylineGate.maxDraftAttempts; attempt++) {
    record.attempt = attempt;
    record.draft = null;
    record.grade = null;
    record.fails = null;
    record.words = 0;
    record.why = null;
    let draft;
    try {
      draft = llm.parseDraft(await llm.callClaude({
        system, prompt: `Write the article.${feedback}`, model: config.models.drafter,
        stage: 'byline_draft', timeoutMs: 420000,
      }));
      if (draft && draft.__decline) return { ...record, status: 'declined', why: draft.__decline };
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Invalid byline draft');
    } catch (error) {
      return { ...record, status: 'error', why: error.message };
    }
    record.draft = draft;
    record.words = countWords(String(draft.article_html || ''));
    record.fails = bylineGates(draft, seat, sources);
    if (record.fails.length) {
      feedback = `\n\nYOUR PREVIOUS DRAFT FAILED THESE CHECKS, fix every one: ${record.fails.join('; ')}`;
      continue;
    }
    try {
      record.grade = validateBylineGrade(llm.extractJsonObject(await llm.callClaude({
        system: BYLINE_GRADER,
        prompt: `SOURCE TEXT (the only allowed numbers):\n${sourceText.slice(0, 12000)}\n\nAPPROVED CLAIMS:\n${seat.claims.slice(0, 4000)}\n\nHEADLINE: ${draft.headline}\nSUBHEADING: ${draft.subheading}\n\nARTICLE:\n${plainText(draft.article_html)}\n\nBIO:\n${plainText(draft.bio_html)}`,
        model: config.models.grader, stage: 'byline_grade',
      })));
    } catch (error) {
      return { ...record, why: `Byline grader failed: ${error.message}` };
    }
    if (bylineGatePassed(record.grade, config.bylineGate)) return { ...record, status: 'passed' };
    record.why = `Below byline grade floors: ${record.grade.notes}`;
    feedback = `\n\nYOUR PREVIOUS DRAFT SCORED BELOW THE BAR (${JSON.stringify(record.grade)}). Rewrite to fix: ${record.grade.notes}`;
  }
  return record;
}

async function main(args = process.argv.slice(2)) {
  require('./paths').loadEnvFile();
  const { loadConfig } = require('./config');
  const { DATA_DIR, writeJsonAtomic } = require('./paths');
  const { writeBylineReview } = require('./byline-review');
  const [command, ...keys] = args;
  if (command !== 'draft') throw new Error('Usage: node src/byline.js draft [seatKey ...]');
  const config = loadConfig();
  const invalid = keys.filter((key) => !config.seatsByKey[key]?.byline);
  if (invalid.length) throw new Error(`Seats missing or without a byline block: ${invalid.join(', ')}`);
  const seats = keys.length ? [...new Set(keys)].map((key) => config.seatsByKey[key])
    : config.seats.filter((seat) => seat.byline);
  if (!seats.length) throw new Error('No byline profiles configured. Add one with npm run onboard -- --add');
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const dir = path.join(DATA_DIR, 'bylines', day);
  const records = [];
  for (const seat of seats) {
    const record = await draftByline(seat, { config });
    const file = path.join(dir, `${seat.key}.json`);
    writeJsonAtomic(file, record);
    records.push(record);
    console.log(`${record.seat}: ${record.status} (${record.words} words)${record.why ? ` ${record.why}` : ''}${record.fails?.length ? ` ${record.fails.join(', ')}` : ''}`);
    if (record.status === 'passed') console.log(`npm run byline-stage -- ${shellQuote(file)}`);
  }
  writeBylineReview(dir, records, { gate: config.bylineGate });
  return 0;
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchSourcePage, bylineSystem, bylineGates, BYLINE_GRADER, bylineGatePassed, validateBylineGrade,
  draftByline, plainText, countWords,
};
