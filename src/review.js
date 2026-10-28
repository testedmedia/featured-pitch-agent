'use strict';

const fs = require('fs');
const path = require('path');

const SCORE_KEYS = ['fit', 'thesis_match', 'authenticity', 'specificity', 'lie_risk', 'ai_likelihood', 'fabrication_risk', 'overall'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function localTime(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function shellQuote(value) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_./,:=-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function questionLink(url) {
  try {
    const parsed = new URL(url);
    if (['http:', 'https:'].includes(parsed.protocol)) {
      return `<a href="${escapeHtml(parsed.href)}" target="_blank" rel="noopener noreferrer">Open question</a>`;
    }
  } catch (_) { /* Untrusted records may contain invalid URLs. */ }
  return '<span>Question link unavailable</span>';
}

function renderReview({ report, records }) {
  const groups = ['passed', 'held', 'declined'];
  const rows = records || groups.flatMap((status) => (report[status] || []).map((record) => ({ ...record, status })));
  const ordered = rows.map((record, index) => ({ record, index })).sort((a, b) => {
    const rank = (status) => groups.includes(status) ? groups.indexOf(status) : groups.length;
    return rank(a.record.status) - rank(b.record.status) || a.index - b.index;
  });
  const floors = report.flags?.gate || report.flags?.floors || report.gate || report.floors;
  const floorText = floors ? Object.entries(floors).filter(([key]) => SCORE_KEYS.includes(key))
    .map(([key, value]) => `${key}: ${value}`).join(', ') : 'Not recorded';
  const counts = groups.map((status) => `${status}: ${report.counts?.[status] ?? (report[status] || rows.filter((record) => record.status === status)).length}`);
  counts.push(`submitted: ${report.counts?.submitted ?? (report.submitted || []).filter((outcome) => ['submitted', 'submitted_inferred'].includes(outcome.status)).length}`);
  const passedIds = (report.passed || rows.filter((record) => record.status === 'passed')).map((record) => record.id).join(',');
  const command = `npm run submit -- --run ${shellQuote(report.runDir)} --ids ${shellQuote(passedIds)} --live`;
  const cards = ordered.map(({ record }, index) => {
    const body = String(record.pitch_body ?? '');
    const score = record.score || record.score_last_failed || {};
    const scoreRows = SCORE_KEYS.map((key) => {
      const floor = floors?.[key];
      const underFloor = typeof score[key] === 'number' && typeof floor === 'number' && score[key] < floor;
      return `<tr${underFloor ? ' class="under-floor"' : ''}><th scope="row">${escapeHtml(key)}</th><td>${escapeHtml(score[key] ?? 'Not scored')}</td><td>${escapeHtml(floor ?? 'None recorded')}</td><td>${underFloor ? 'Below floor' : ''}</td></tr>`;
    }).join('');
    const failures = record.gate_failures?.length ? record.gate_failures : record.why;
    const reason = Array.isArray(failures) ? failures.join('; ') : failures;
    return `<article class="card">
      <span class="status">${escapeHtml(record.status)}</span>
      <h2>${escapeHtml(record.displayName)} <span>${escapeHtml(record.brand)}</span></h2>
      <p>${escapeHtml(record.publication)} | DA ${escapeHtml(record.da)} | Deadline: ${escapeHtml(record.deadline)}</p>
      ${questionLink(record.url)}
      <h3>Question</h3><p class="question">${escapeHtml(String(record.question ?? '').slice(0, 700))}</p>
      ${body ? `<div class="pitch-heading"><h3>Pitch</h3><button type="button" data-copy="pitch-${index}">Copy</button></div>
      <pre id="pitch-${index}">${escapeHtml(body)}</pre>
      <p class="muted">${escapeHtml(body.length.toLocaleString())} characters</p>` : '<p class="muted">No pitch body.</p>'}
      ${Object.keys(score).length ? `<div class="table-wrap"><table><thead><tr><th>Axis</th><th>Score</th><th>Floor</th><th>Result</th></tr></thead><tbody>${scoreRows}</tbody></table></div>` : '<p class="muted">Not graded.</p>'}
      <p>Attempts: ${escapeHtml(record.attempts ?? 0)}</p>
      ${reason ? `<p class="reason">${escapeHtml(reason)}</p>` : ''}
      <p class="muted">Record id: ${escapeHtml(record.id)}</p>
    </article>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pitch review</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#19222d;font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1000px;margin:auto;padding:24px}header,.card,footer{background:#fff;border:1px solid #dce2e8;border-radius:6px;padding:24px;margin-bottom:20px;overflow-wrap:anywhere}h1,h2,h3,p{margin:0 0 12px}h2{font-size:22px}h2 span{display:block;color:#536170;font-size:16px;font-weight:400}h3{font-size:17px;margin-top:16px}a{color:#165caa}.status{display:inline-block;border:1px solid #c5d1df;border-radius:6px;padding:2px 10px;margin-bottom:12px;font-weight:600}.question,pre{white-space:pre-wrap;overflow-wrap:anywhere}pre{font:inherit;background:#f6f8fa;border:1px solid #e0e5ea;border-radius:6px;padding:18px}.pitch-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.pitch-heading h3{margin:12px 0}button{font:inherit;background:#165caa;color:white;border:0;border-radius:6px;padding:8px 16px;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #b25b00;outline-offset:3px}.muted{color:#536170;font-size:14px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px;border-bottom:1px solid #dce2e8}.under-floor{color:#a31313;background:#fff1f1}.reason{border-left:3px solid #a31313;padding-left:12px}code{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){main{padding:12px}header,.card,footer{padding:16px}h1{font-size:26px}th,td{padding:6px}}
</style></head><body><main>
<header><h1>Pitch review</h1><p>Run folder: ${escapeHtml(report.runDir)}</p>
<p>Started: ${escapeHtml(localTime(report.startedAt))}<br>Finished: ${escapeHtml(localTime(report.finishedAt))}</p>
<p>${escapeHtml(counts.join(' | '))}</p><p>Floors used: ${escapeHtml(floorText)}</p></header>
${cards || '<p>No records in this run.</p>'}
<footer><h2>Submit passed pitches</h2>${passedIds ? '' : '<p>No passed pitches are available to submit.</p>'}<code>${escapeHtml(command)}</code></footer>
</main><script>
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-copy]');
  if (!button) return;
  try {
    await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent);
    button.textContent = 'Copied';
  } catch (_) { button.textContent = 'Copy failed: select the pitch text'; }
});
</script></body></html>`;
}

function writeReview(runDir, data) {
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, 'review.html');
  fs.writeFileSync(file, renderReview({ ...data, report: { ...data.report, runDir } }), 'utf8');
  return file;
}

module.exports = { renderReview, writeReview };
