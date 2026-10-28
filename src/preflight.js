'use strict';

const SENTINELS = ['\u2014', '\u2013', ' -- ', 'SKIP', 'TODO', 'FIXME', 'PLACEHOLDER'];
const SLOP_WORDS = ['delve', 'leverage', 'elevate', 'harness', 'navigate the', 'realm', 'tapestry', 'ever-evolving', 'myriad', 'plethora', 'underscore', 'synergy', 'paradigm', 'transformative', 'supercharge', 'cutting-edge', 'state-of-the-art', 'game-changer', 'revolutionize', 'world-class', 'seamless'];

const FABRICATION_PATTERNS = [
    /\b(our|my|one|a|the)\s+(client|customer)s?\b/i,
    /\bwe\s+(ran|tested|booked|lost|had|tried|launched|saw|helped|built|hired|fired)\b/i,
    /\bthe month i\b/i, /\bmake payroll\b/i, /\bretainers?\b/i,
    /\bwhen (i|we) (started|first|had)\b/i,
    /\bcost[- ]per[- ]booked[- ]job\b/i,
    /\b\d+%\s+of\s+(our|my|the)\b/i,
    /\bin (my|our) (first|early)\b/i,
    /\bafter (looking|reviewing|seeing|handling|working)\b/i,
];

function preflight(body, seat, config) {
  const fails = [];
  if (body.length < config.pitch.minChars || body.length > config.pitch.maxChars) fails.push(`len:${body.length}`);
  // Claim bans need a mechanical gate even when they also appear in the prompt.
  if (seat && Array.isArray(seat.banPatterns)) {
    for (const ban of seat.banPatterns) {
      if (new RegExp(ban.re.source, ban.re.flags).test(body)) fails.push(`seat-ban:${ban.label}`);
    }
  }
  for (const token of SENTINELS) if (body.includes(token)) fails.push(`banned:${token}`);
  for (const token of config.bannedBodyTokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(body)) fails.push(`banned-name:${token}`);
  }
  for (const token of SLOP_WORDS) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(body)) fails.push(`slop:${token}`);
  }
  // Sentence architecture is rejected mechanically as well as by the grader.
  const structurePatterns = [
    // "Teams don't automate a task. They automate a title." / "aren't chasing X. They're chasing Y."
    { label: 'neg-parallel-split', test: /\b(?:do|does|did|is|are|was|were|ai|it|they|he|she)n['’]?t\s+[^.!?]{3,60}[.!?]\s+(?:they|it|he|she|we|you)['’]?(?:s|re)?\s+\w+/i },
    // "isn't one job, it's twenty small tasks" / "not about X, it's Y"
    { label: 'neg-parallel-comma', test: /\b(?:isn['’]?t|aren['’]?t|wasn['’]?t|not just|not merely|not about|it['’]?s not)\b[^.!?]{3,80},\s*(?:it['’]?s|they['’]?re|that['’]?s)\b/i },
    // "It can't carry the parts..." straight after "AI can carry the repeatable half..."
    { label: 'neg-parallel-cant', test: /\bcan\s+\w[^.!?]{3,60}[.!?]\s+(?:it|they|he|she)\s+can['’]?t\b/i },
    // Tailing negation fragment: a sentence that IS the negation. "Not just more listings to gamble on."
    { label: 'tailing-negation', test: /(?:^|[.!?]\s)\s*Not (?:just|merely|only)\b[^.!?]{3,90}[.!?]\s*$/im },
    { label: 'authority-trope', test: /\bthe (?:real|actual) (?:question|driver|issue|problem|reason)\b|\bat its core\b|\bwhat really matters\b|\bthe heart of (?:it|the matter)\b/i },
    // Engineered closer. Only fires on the LAST sentence, where the aphorism skeleton lives.
    { label: 'engineered-closer', test: null, lastSentence: /^(?:one rule[^.]*|the rule[^.]*|remember[^.]*|scope [^.]*before[^.]*|if [^,]{3,60}, it becomes [^.]*|[^.]{3,60} is the [a-z]+ of [^.]*)\.$/i },
    { label: 'aphorism-formula', test: /\bbecomes? (?:a trap|tomorrow['’]s)\b|\bthe (?:language|currency|architecture) of\b/i },
  ];
  const sentences = body.split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter(Boolean);
  const lastSentence = sentences.length ? sentences[sentences.length - 1] : '';
  for (const pattern of structurePatterns) {
    if (pattern.test && pattern.test.test(body)) fails.push(`ai-structure:${pattern.label}`);
    if (pattern.lastSentence && pattern.lastSentence.test(lastSentence)) fails.push(`ai-structure:${pattern.label}`);
  }
  // A public statistic must never be presented as proprietary data.
  if (/\b(?:my own|our own|our internal|my internal)\s+(?:numbers|data|figures|stats)\b/i.test(body)) {
    fails.push('false-attribution:claims_proprietary_data');
  }
  for (const pattern of FABRICATION_PATTERNS) if (pattern.test(body)) fails.push(`fab-pattern:${pattern.source}`);
  return fails;
}

module.exports = { preflight, FABRICATION_PATTERNS, SLOP_WORDS, SENTINELS };
