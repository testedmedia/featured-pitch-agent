'use strict';

function mergeBatch(results, batchStart, batchLength, arr, seatKeys) {
  const merged = results.slice();
  const allowed = new Set(seatKeys);
  for (const row of arr || []) {
    if (!row || !Number.isInteger(row.i) || row.i < 0 || row.i >= batchLength) continue;
    const index = batchStart + row.i;
    if (index < 0 || index >= merged.length) continue;
    merged[index] = {
      fits: (Array.isArray(row.fits) ? row.fits : [])
        .filter((fit) => fit && allowed.has(fit.seat))
        .map((fit) => ({
          seat: fit.seat,
          strength: fit.strength === 'strong' ? 'strong' : 'stretch',
          angle: fit.angle,
        })),
      skip_reason: row.skip_reason || row.skip || null,
    };
  }
  return merged;
}

async function classifyQuestions(items, {
  config, batchSize = 20, concurrency = 3, llm = require('./llm'),
  retryBaseMs = 8000, maxAttempts = 5,
}) {
  for (const [name, value] of Object.entries({ batchSize, concurrency, maxAttempts })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (!Number.isFinite(retryBaseMs) || retryBaseMs < 0) throw new Error('retryBaseMs must be nonnegative');
  const prompts = require('./prompts');
  const rows = items.filter((item) => item && item.url && item.text);
  let results = new Array(rows.length).fill(null);
  let nextBatch = 0;
  const batchCount = Math.ceil(rows.length / batchSize);
  async function worker() {
    while (nextBatch < batchCount) {
      const start = nextBatch++ * batchSize;
      const batch = rows.slice(start, start + batchSize);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const response = await llm.callClaude({
            system: prompts.classifierSystem(config.seats),
            prompt: prompts.classifierUser(batch),
            model: config.models.classifier,
            stage: 'classify', timeoutMs: 240000, retries: 1,
          });
          const arr = llm.extractJsonArray(response);
          if (!Array.isArray(arr)) throw new Error('Classifier response is not an array');
          results = mergeBatch(results, start, batch.length, arr, Object.keys(config.seatsByKey));
          break;
        } catch (error) {
          if (attempt + 1 < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, retryBaseMs * 2 ** attempt));
          }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batchCount) }, worker));
  const classified = rows.map((row, index) => ({
    url: row.url, da: parseInt(row.da, 10) || 0,
    deadline: row.deadline, publication: row.publication, text: String(row.text),
    fits: results[index] ? results[index].fits : [],
    skip_reason: results[index] ? results[index].skip_reason : 'CLASSIFY_FAILED',
  }));
  const counts = { anyFit: 0, noFit: 0, failed: 0 };
  for (const row of classified) {
    if (row.skip_reason === 'CLASSIFY_FAILED') counts.failed++;
    else if (row.fits.length) counts.anyFit++;
    else counts.noFit++;
  }
  return { classifiedAt: new Date().toISOString(), total: classified.length, ...counts, items: classified };
}

module.exports = { classifyQuestions, mergeBatch };
