'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULTS } = require('./config');

const SCORE_KEYS = ['accuracy', 'sourcing', 'usefulness', 'guideline_fit', 'lie_risk', 'ai_likelihood', 'fabrication_risk', 'overall'];
const DEFAULT_GATE = DEFAULTS.bylineGate || {
  overall: 8, lie_risk: 9, sourcing: 8, fabrication_risk: 8, ai_likelihood: 7, guideline_fit: 8,
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'" };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|rsquo);/gi, (entity, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()];
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

function hrefAttribute(tag) {
  const attributes = tag.replace(/^<a\b/i, '').replace(/>$/, '');
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of attributes.matchAll(pattern)) {
    if (match[1].toLowerCase() === 'href') return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return null;
}

function safeHref(href) {
  if (!/^https?:\/\//i.test(href || '') || /[\u0000-\u0020\u007f]/.test(href)) return false;
  try { return ['http:', 'https:'].includes(new URL(href).protocol); } catch (_) { return false; }
}

function sanitizeArticleHtml(html) {
  return String(html ?? '').split(/(<[^>]*>)/g).map((token) => {
    if (!token.startsWith('<')) return escapeHtml(decodeEntities(token));
    const closing = token.match(/^<\/\s*(p|h2|strong|em|a)\s*>$/i);
    if (closing) return `</${closing[1].toLowerCase()}>`;
    const opening = token.match(/^<(p|h2|strong|em|a)(?:\s[^<>]*)?\s*>$/i);
    if (opening) {
      const tag = opening[1].toLowerCase();
      if (tag !== 'a') return `<${tag}>`;
      const href = hrefAttribute(token);
      if (safeHref(href)) return `<a href="${escapeHtml(href)}">`;
    }
    return escapeHtml(token);
  }).join('');
}

function linkList(html) {
  return [...String(html ?? '').matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a\s*>/gi)].map((match) => {
    const href = hrefAttribute(match[1]);
    const text = decodeEntities(match[2].replace(/<[^>]*>/g, ''));
    const target = safeHref(href) ? `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>` : escapeHtml(href ?? 'No URL');
    return `<li>${escapeHtml(text)} &rarr; ${target}</li>`;
  }).join('');
}

function renderBylineReview({ records, shotsBySeat = {}, gate = DEFAULT_GATE }) {
  const ordered = records.slice().sort((a, b) => Number(b.status === 'passed') - Number(a.status === 'passed'));
  const cards = ordered.map((record) => {
    const draft = record.draft || {};
    const grade = record.grade || {};
    const byline = record.byline || {};
    const staged = Object.hasOwn(shotsBySeat, record.seat) ? shotsBySeat[record.seat] : null;
    const marks = staged?.marks || {};
    const submitEnabled = (marks.submitButtons || []).some((button) => button.disabled === false);
    const check = staged
      ? `<p><b>Featured AI check:</b> ${escapeHtml(marks.fix ?? 0)} fixes, ${escapeHtml(marks.advice ?? 0)} advice. Submit enabled: ${submitEnabled ? 'Yes' : 'No'}.</p>
        <ul class="flags">${[...(marks.fixText || []), ...(marks.adviceText || [])].map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`
      : '<p class="muted">Featured AI check: not run yet</p>';
    const scoreRows = SCORE_KEYS.map((key) => {
      const floor = gate[key];
      const underFloor = typeof grade[key] === 'number' && typeof floor === 'number' && grade[key] < floor;
      return `<tr${underFloor ? ' class="under-floor"' : ''}><th scope="row">${escapeHtml(key)}</th><td>${escapeHtml(grade[key] ?? 'Not scored')}</td><td>${escapeHtml(floor ?? 'None')}</td><td>${underFloor ? 'Below floor' : ''}</td></tr>`;
    }).join('');
    const links = linkList(draft.article_html) + linkList(draft.bio_html);
    return `<section class="card" data-seat="${escapeHtml(record.seat)}">
      <div class="meta">${escapeHtml(String(record.status || '').toUpperCase())} &middot; ${escapeHtml(record.words ?? 0)} words &middot; attempt ${escapeHtml(record.attempt ?? 0)}</div>
      <div class="by">By ${escapeHtml(record.author)}, ${escapeHtml(byline.title)}, ${escapeHtml(record.brand)}, via Featured News</div>
      <h2 class="headline">${escapeHtml(draft.headline || record.seat)}</h2>
      <p class="sub">${escapeHtml(draft.subheading)}</p>
      ${record.draft ? `<article>${sanitizeArticleHtml(draft.article_html)}</article>
      <div class="bio"><b>Author bio</b>${sanitizeArticleHtml(draft.bio_html)}</div>` : '<p>No draft available.</p>'}
      <div class="links"><b>Links in the article and bio</b><ul>${links || '<li>None</li>'}</ul></div>
      <div class="table-wrap"><table><thead><tr><th>Axis</th><th>Score</th><th>Floor</th><th>Result</th></tr></thead><tbody>${scoreRows}</tbody></table></div>
      <p class="muted"><b>Grader note:</b> ${escapeHtml(grade.notes)}</p>
      ${record.fails?.length ? `<ul class="flags">${record.fails.map((failure) => `<li>${escapeHtml(failure)}</li>`).join('')}</ul>` : ''}
      ${record.why ? `<p class="bad">${escapeHtml(record.why)}</p>` : ''}
      ${check}
    </section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Featured News bylines for review</title>
<style>
*{box-sizing:border-box}body{font:17px/1.6 Georgia,serif;background:#f4f1ea;color:#1d1d1b;margin:0;padding:24px}main{max-width:820px;margin:0 auto}header{font:15px/1.6 system-ui;margin-bottom:24px}header h1{font-size:26px}.card{background:#fff;border:1px solid #ddd;border-radius:6px;padding:28px 34px;margin:0 0 36px;overflow-wrap:anywhere}.meta{font:13px/1.4 system-ui;color:#555}.by{font:14px/1.5 system-ui;color:#555;margin-top:10px}.headline{font-size:30px;line-height:1.2;margin:8px 0}.sub{font-size:19px;color:#444}article h2{font-size:22px;margin-top:28px}.bio,.links{font:15px/1.5 system-ui;background:#faf8f3;border-radius:6px;padding:12px 16px;margin-top:20px}.flags,.bad{color:#a31313}.muted{color:#555;font:14px/1.5 system-ui}a{color:#5135bf}.table-wrap{overflow-x:auto;margin-top:20px}table{width:100%;border-collapse:collapse;font:14px/1.5 system-ui}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}.under-floor{color:#a31313;background:#fff1f1}@media(max-width:600px){body{padding:12px}.card{padding:18px}.headline{font-size:26px}th,td{padding:6px}}
</style></head><body><main>
<header><h1>Featured News bylines</h1><p>Nothing has been submitted. Each card shows the Featured AI check result once the article has been staged.</p></header>
${cards || '<p>No byline records to review.</p>'}
</main></body></html>`;
}

function writeBylineReview(dir, records, { gate = DEFAULT_GATE } = {}) {
  const shotsDir = path.join(dir, 'shots');
  let files;
  try { files = fs.readdirSync(shotsDir); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    files = [];
  }
  const shotsBySeat = Object.create(null);
  for (const record of records) {
    const matches = files.filter((file) => file.startsWith(`${record.seat}-staged-`) && file.endsWith('.json')).sort();
    if (matches.length) shotsBySeat[record.seat] = JSON.parse(fs.readFileSync(path.join(shotsDir, matches[matches.length - 1]), 'utf8'));
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'review.html');
  fs.writeFileSync(file, renderBylineReview({ records, shotsBySeat, gate }), 'utf8');
  return file;
}

module.exports = { sanitizeArticleHtml, renderBylineReview, writeBylineReview };
