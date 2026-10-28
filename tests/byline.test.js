'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  fetchSourcePage, bylineSystem, bylineGates, BYLINE_GRADER, bylineGatePassed,
  validateBylineGrade, draftByline, plainText, countWords,
} = require('../src/byline');
const { parseDraft, extractJsonObject } = require('../src/llm');
const { structureFailures } = require('../src/preflight');

const seat = {
  key: 'example_founder', displayName: 'Jane Example', brand: 'Example Co',
  persona: 'An operator who writes checklists.', bans: 'No medical credentials.',
  claims: 'Jane Example founded Example Co and writes practical guides for property owners.',
  byline: {
    title: 'Founder', homepage: 'https://example.com/', topic: 'Practical checklists for property owners.',
    sources: ['https://example.com/guide'],
  },
};
const config = {
  bannedBodyTokens: ['Jane'], models: { drafter: 'draft-model', grader: 'grade-model' },
  bylineGate: { overall: 8, lie_risk: 9, sourcing: 8, fabrication_risk: 8, ai_likelihood: 7, guideline_fit: 8, maxDraftAttempts: 3 },
};
const sources = [{ url: seat.byline.sources[0], text: 'Evidence from the source page.', links: [{ href: 'https://example.org/study', text: 'Study' }] }];
const sentence = 'The checklist stays beside the door for each scheduled visit. ';
function cleanDraft() {
  return {
    headline: 'How a written checklist helps owners prepare each property',
    subheading: 'Keep the instructions close to the work.',
    article_html: `<h2>Start with the entry</h2><p>${sentence.repeat(65)}</p><h2>Check the instructions</h2><p>Read the <a href="https://example.org/study">study</a> for more detail.</p>`,
    bio_html: '<p>Jane Example is the founder of <a href="https://example.com/">Example Co</a> and writes practical guides for property owners. Her work covers written checklists and clear instructions for routine tasks. She explains how owners can keep useful records and prepare a property for each scheduled visit.</p>',
    sources_used: [],
  };
}
function goodGrade(overrides = {}) {
  return { accuracy: 9, sourcing: 9, usefulness: 9, guideline_fit: 9, lie_risk: 9,
    ai_likelihood: 9, fabrication_risk: 9, overall: 9, notes: 'Ready to review.', ...overrides };
}
const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<p>Evidence from the source page.</p><a href="https://example.org/study">Study</a>' });
function fakeLlm(replies) {
  const calls = [];
  return {
    calls, parseDraft, extractJsonObject,
    async callClaude(args) {
      calls.push(args);
      assert.ok(replies.length, 'Unexpected model call');
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    },
  };
}

test('fetchSourcePage parses text and unique absolute links using a timed desktop GET', async () => {
  let signal;
  const page = await fetchSourcePage('https://example.com/guide', { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://example.com/guide');
    assert.equal(options.method, 'GET');
    assert.match(options.headers['User-Agent'], /Mozilla\/5\.0/);
    signal = options.signal;
    assert.ok(signal instanceof AbortSignal);
    return { ok: true, status: 200, text: async () => '<style>hidden css</style><script>hidden script</script><p>Owners&nbsp;&amp; hosts&#39; notes &rsquo; &quot;yes&quot; &lt;ok&gt;</p><a href="https://example.org/study"><strong>Study</strong> details</a><a href="https://example.org/study">Duplicate</a><a href="/relative">Local</a><a href="#here">Section</a>' };
  } });
  assert.equal(signal.aborted, false);
  assert.equal(page.text, 'Owners & hosts\' notes \' "yes" <ok> Study details Duplicate Local Section');
  assert.deepEqual(page.links, [{ href: 'https://example.org/study', text: 'Study details' }]);
});

test('fetchSourcePage caps source text and the link menu', async () => {
  const html = 'x'.repeat(9100) + Array.from({ length: 65 }, (_, i) => `<a href="https://example.org/${i}">${'a'.repeat(95)}</a>`).join('');
  const page = await fetchSourcePage('https://example.com/guide', { fetchImpl: async () => ({ ok: true, text: async () => html }) });
  assert.equal(page.text.length, 9000);
  assert.equal(page.links.length, 60);
  assert.equal(page.links[0].text.length, 90);
});

test('fetchSourcePage throws with the URL and status on 404', async () => {
  await assert.rejects(fetchSourcePage('https://example.com/missing', {
    fetchImpl: async () => ({ ok: false, status: 404 }),
  }), /https:\/\/example\.com\/missing.*404/);
});

test('bylineSystem keeps the source rules, seat grounding, humanizer and JSON shape', () => {
  const system = bylineSystem(seat, config, sources);
  for (const text of [seat.displayName, seat.brand, seat.persona, seat.bans, seat.claims, seat.byline.topic,
    'FEATURED NEWS RULES', '700 to 1,300 words', '40 to 60 words', '2 to 4 <h2>', 'MIRRORED PAIRS',
    'NO FABRICATED EVENTS', 'HUMANIZER PATTERNS', 'Study -> https://example.org/study', '"sources_used"']) {
    assert.ok(system.includes(text), text);
  }
  assert.ok(!system.includes('800-1500 characters'));
  assert.match(BYLINE_GRADER, /exactly these keys: accuracy, sourcing, usefulness, guideline_fit, lie_risk, ai_likelihood, fabrication_risk, overall, notes\.$/);
});

test('bylineGates accepts a clean fixture', () => {
  assert.deepEqual(bylineGates(cleanDraft(), seat, sources), []);
  assert.equal(plainText('<p>A &amp; B</p><h2>Details</h2>'), 'A & B\n\nDetails');
  assert.equal(countWords('<p>Two words</p>'), 2);
});

const failures = [
  ['body words', (draft) => { draft.article_html = '<p>Too short.</p>'; }, 'body_words:2'],
  ['headline words', (draft) => { draft.headline = 'Too short'; }, 'headline_words:2'],
  ['title case', (draft) => { draft.headline = 'How Written Checklists Help Owners Prepare Their Property'; }, 'headline_title_case'],
  ['bio words', (draft) => { draft.bio_html = '<p>Short bio.</p>'; }, 'bio_words:2'],
  ['dash', (draft) => { draft.subheading += ' \u2014 details'; }, 'dash'],
  ['company twice', (draft) => { draft.article_html += '<p>Example Co. Example Co.</p>'; }, 'company_named_2x'],
  ['CTA', (draft) => { draft.article_html += '<p>Contact us for help.</p>'; }, 'cta'],
  ['author in body', (draft) => { draft.article_html += '<p>Jane Example writes guides.</p>'; }, 'author_name_in_body'],
  ['off-menu link', (draft) => { draft.article_html += '<a href="https://example.net/unknown">Unknown</a>'; }, 'link_off_menu:https://example.net/unknown'],
  ['own-domain links', (draft) => { draft.article_html += '<a href="https://example.com/guide">Guide</a>'.repeat(2); }, 'own_domain_links:2'],
  ['lead capture', (draft) => { draft.article_html += '<a href="https://example.com/contact">Contact</a>'; }, 'lead_capture_link:https://example.com/contact'],
  ['bio links', (draft) => { draft.bio_html += '<a href="https://example.org/study">Study</a>'; }, 'bio_links'],
  ['disallowed tag', (draft) => { draft.article_html += '<ul><li>List</li></ul>'; }, 'disallowed_tag'],
  ['fabrication', (draft) => { draft.article_html += '<p>We tested a checklist.</p>'; }, /^fabrication_pattern:/],
  ['structure', (draft) => { draft.article_html += '<p>The real question is how long this takes.</p>'; }, 'structure:ai-structure:authority-trope'],
];
for (const [label, mutate, expected] of failures) {
  test(`bylineGates rejects ${label}`, () => {
    const draft = cleanDraft();
    mutate(draft);
    const fails = bylineGates(draft, seat, sources);
    assert.ok(fails.some((failure) => expected instanceof RegExp ? expected.test(failure) : failure === expected), fails.join('; '));
  });
}

test('bylineGates word boundaries are inclusive and structure checks include all shared rules', () => {
  for (const words of [649, 650, 1450, 1451]) {
    const draft = { ...cleanDraft(), article_html: `<p>${'task '.repeat(words)}</p>` };
    assert.equal(bylineGates(draft, seat, sources).includes(`body_words:${words}`), words < 650 || words > 1450);
  }
  for (const words of [39, 40, 60, 61]) {
    const draft = { ...cleanDraft(), bio_html: `<p>${'task '.repeat(words)}</p>` };
    assert.equal(bylineGates(draft, seat, sources).includes(`bio_words:${words}`), words < 40 || words > 60);
  }
  const text = 'Leverage our own data. Remember to check the steps.';
  const draft = cleanDraft();
  draft.article_html += `<p>${text}</p>`;
  for (const failure of structureFailures(text)) assert.ok(bylineGates(draft, seat, sources).includes(`structure:${failure}`));
});

test('validateBylineGrade rounds all numeric axes and rejects every invalid field', () => {
  const grade = goodGrade();
  for (const key of Object.keys(grade).filter((key) => key !== 'notes')) {
    assert.equal(validateBylineGrade({ ...grade, [key]: 8.6 })[key], 9);
    for (const value of [undefined, null, '9', NaN, Infinity, 0, 10.1]) {
      assert.throws(() => validateBylineGrade({ ...grade, [key]: value }), new RegExp(key));
    }
  }
  for (const notes of [undefined, null, 9]) assert.throws(() => validateBylineGrade({ ...grade, notes }), /notes/);
  for (const input of [null, [], 'junk']) assert.throws(() => validateBylineGrade(input), /Invalid byline grade/);
});

test('bylineGatePassed uses every configured floor without inverting the safety axes', () => {
  assert.equal(bylineGatePassed(goodGrade(), config.bylineGate), true);
  assert.equal(bylineGatePassed(null, config.bylineGate), false);
  for (const key of Object.keys(config.bylineGate).filter((key) => key !== 'maxDraftAttempts')) {
    assert.equal(bylineGatePassed(goodGrade({ [key]: config.bylineGate[key] - 1 }), config.bylineGate), false, key);
  }
  assert.equal(bylineGatePassed(goodGrade(), { ...config.bylineGate, overall: 10 }), false);
});

test('draftByline passes first try with separate model calls and the contract record', async () => {
  const llm = fakeLlm([cleanDraft(), goodGrade()]);
  const record = await draftByline(seat, { config, llm, fetchImpl });
  assert.equal(record.status, 'passed');
  assert.equal(record.attempt, 1);
  assert.equal(record.words, countWords(cleanDraft().article_html));
  assert.deepEqual(Object.keys(record).sort(), ['seat', 'author', 'brand', 'byline', 'status', 'why', 'attempt', 'words', 'fails', 'grade', 'draft'].sort());
  assert.deepEqual(record.fails, []);
  assert.equal(record.author, seat.displayName);
  assert.deepEqual(record.byline, seat.byline);
  assert.deepEqual(llm.calls.map((call) => call.stage), ['byline_draft', 'byline_grade']);
  assert.equal(llm.calls[0].model, config.models.drafter);
  assert.equal(llm.calls[0].timeoutMs, 420000);
  assert.equal(llm.calls[0].prompt, 'Write the article.');
  assert.equal(llm.calls[1].model, config.models.grader);
  assert.equal(llm.calls[1].system, BYLINE_GRADER);
  assert.ok(llm.calls[1].prompt.includes(seat.claims));
  assert.ok(llm.calls[1].prompt.includes(plainText(cleanDraft().article_html)));
  assert.ok(!llm.calls[1].prompt.includes('<p>'));
});

test('draftByline retries gate failures with feedback and then passes', async () => {
  const llm = fakeLlm([{ ...cleanDraft(), headline: 'Short' }, cleanDraft(), goodGrade()]);
  const record = await draftByline(seat, { config, llm, fetchImpl });
  assert.equal(record.status, 'passed');
  assert.equal(record.attempt, 2);
  assert.match(llm.calls[1].prompt, /YOUR PREVIOUS DRAFT FAILED THESE CHECKS, fix every one: headline_words:1/);
  assert.deepEqual(llm.calls.map((call) => call.stage), ['byline_draft', 'byline_draft', 'byline_grade']);
});

test('draftByline holds after three below-floor grades and carries feedback', async () => {
  const grade = goodGrade({ sourcing: 7, notes: 'Cite the year.' });
  const llm = fakeLlm([cleanDraft(), grade, cleanDraft(), grade, cleanDraft(), grade]);
  const record = await draftByline(seat, { config, llm, fetchImpl });
  assert.equal(record.status, 'held');
  assert.equal(record.attempt, 3);
  assert.equal(record.grade.sourcing, 7);
  assert.equal(llm.calls.length, 6);
  assert.ok(llm.calls[2].prompt.includes(`YOUR PREVIOUS DRAFT SCORED BELOW THE BAR (${JSON.stringify(grade)}). Rewrite to fix: Cite the year.`));
});

test('draftByline returns a decline without grading', async () => {
  const llm = fakeLlm([{ decline_reason: 'Needs a medical credential.' }]);
  const record = await draftByline(seat, { config, llm, fetchImpl });
  assert.equal(record.status, 'declined');
  assert.equal(record.why, 'Needs a medical credential.');
  assert.equal(record.draft, null);
  assert.equal(llm.calls.length, 1);
});

test('draftByline holds immediately on junk grades or grader errors', async () => {
  for (const reply of ['junk', { overall: 9 }, goodGrade({ lie_risk: '9' }), new Error('Grader unavailable')]) {
    const llm = fakeLlm([cleanDraft(), reply]);
    const record = await draftByline(seat, { config, llm, fetchImpl });
    assert.equal(record.status, 'held');
    assert.equal(record.attempt, 1);
    assert.equal(record.grade, null);
    assert.match(record.why, /Byline grader failed:/);
    assert.equal(llm.calls.length, 2);
  }
});

test('draftByline does not reuse a previous grade after the final draft fails gates', async () => {
  const llm = fakeLlm([cleanDraft(), goodGrade({ sourcing: 7 }), { ...cleanDraft(), headline: 'Short' }]);
  const record = await draftByline(seat, { config: { ...config, bylineGate: { ...config.bylineGate, maxDraftAttempts: 2 } }, llm, fetchImpl });
  assert.equal(record.status, 'held');
  assert.equal(record.grade, null);
  assert.deepEqual(record.fails, ['headline_words:1']);
});

test('draftByline reports failed source fetches without calling the model', async () => {
  const urls = [];
  const llm = fakeLlm([]);
  const withTwoSources = { ...seat, byline: { ...seat.byline, sources: [seat.byline.sources[0], 'https://example.org/missing'] } };
  const record = await draftByline(withTwoSources, { config, llm, fetchImpl: async (url) => {
    urls.push(url);
    return urls.length === 1 ? fetchImpl() : { ok: false, status: 404 };
  } });
  assert.equal(record.status, 'error');
  assert.match(record.why, /https:\/\/example\.org\/missing.*404/);
  assert.deepEqual(urls, withTwoSources.byline.sources);
  assert.equal(record.attempt, 0);
  assert.equal(record.draft, null);
  assert.equal(llm.calls.length, 0);
});

function cliFixture(t, seats) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byline-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'claims.md'), seat.claims);
  fs.writeFileSync(path.join(dir, 'seats.json'), JSON.stringify({
    ...config, seats: seats.map((row, index) => ({ ...row, profileId: String(index + 1),
      topics: ['checklists'], claimsFile: 'claims.md' })),
  }));
  const log = path.join(dir, 'calls.jsonl');
  const preload = path.join(dir, 'fake-model.cjs');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const log = (stage) => fs.appendFileSync(${JSON.stringify(log)}, stage + '\\n');
    globalThis.fetch = async () => {
      log('fetch');
      return { ok: true, text: async () => '<a href="https://example.org/study">Study</a>' };
    };
    require(${JSON.stringify(require.resolve('../src/llm'))}).callClaude = async ({ stage }) => {
      log(stage);
      return JSON.stringify(stage === 'byline_draft' ? ${JSON.stringify(cleanDraft())} : ${JSON.stringify(goodGrade())});
    };
  `);
  return {
    dir, log,
    run(args) {
      return spawnSync(process.execPath, ['--require', preload, require.resolve('../src/byline'), ...args], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, FEATURED_AGENT_HOME: dir, FEATURED_CONFIG: path.join(dir, 'seats.json'), FEATURED_DATA_DIR: path.join(dir, 'data') },
      });
    },
  };
}

test('byline CLI drafts seats sequentially, writes records and review, and prints stage commands', (t) => {
  const fixture = cliFixture(t, [seat, { ...seat, key: 'example_second' }, { ...seat, key: 'example_quotes', byline: null }]);
  const result = fixture.run(['draft']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(fixture.log, 'utf8').trim().split('\n'), [
    'fetch', 'byline_draft', 'byline_grade', 'fetch', 'byline_draft', 'byline_grade',
  ]);
  const root = path.join(fixture.dir, 'data', 'bylines');
  const days = fs.readdirSync(root);
  assert.equal(days.length, 1);
  assert.match(days[0], /^\d{4}-\d{2}-\d{2}$/);
  const dir = path.join(root, days[0]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['example_founder.json', 'example_second.json', 'review.html']);
  for (const key of ['example_founder', 'example_second']) {
    const file = path.join(dir, `${key}.json`);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'passed');
    assert.ok(result.stdout.includes(`${key}: passed`));
    assert.ok(result.stdout.includes(`npm run byline-stage -- ${file}`));
  }
  assert.match(fs.readFileSync(path.join(dir, 'review.html'), 'utf8'), /Nothing has been submitted/);
});

test('byline CLI rejects missing or unconfigured keys and gives onboarding guidance when none exist', (t) => {
  const fixture = cliFixture(t, [{ ...seat, byline: null }]);
  const named = fixture.run(['draft', 'missing_seat', seat.key]);
  assert.equal(named.status, 1);
  assert.match(named.stderr, /missing_seat, example_founder/);
  const none = fixture.run(['draft']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /npm run onboard -- --add/);
  assert.equal(fs.existsSync(fixture.log), false);
});
