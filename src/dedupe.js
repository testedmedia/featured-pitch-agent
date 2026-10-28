'use strict';

const READY_COUNTER = /Characters:\s*\d+\s*\/\s*2500/;
const READY_PROFILE_STRIP = /Add New Profile|Edit Profile/i;
const CLOSED_CLUE = /no longer accepting|deadline has passed/i;

function buildAnswerUrl(rawUrl, profileId) {
  const url = new URL(rawUrl);
  url.searchParams.delete('profileId');
  if (profileId) url.searchParams.set('profileId', profileId);
  return url.toString();
}

function classifyAnswerPage(bodyText) {
  const body = bodyText || '';
  if (!CLOSED_CLUE.test(body) && !(READY_COUNTER.test(body) && READY_PROFILE_STRIP.test(body))) {
    return null;
  }
  const composerOpen = /Characters:\s*0\s*\/\s*2500/.test(body);
  const composerCounter = /Characters:\s*(\d+)\s*\/\s*2500/.exec(body);
  const composerHasStoredAnswer = Boolean(composerCounter) && parseInt(composerCounter[1], 10) > 0;
  const answeredBanner = /has answered this question|you('|')ve already answered|already submitted|already pitched|you have answered/i.test(body);
  if (composerHasStoredAnswer || (answeredBanner && !composerOpen)) return 'already_answered';
  return CLOSED_CLUE.test(body) ? 'closed' : 'fresh';
}

async function readBodyWhenRendered(page, renderTimeoutMs, stopped) {
  const { isLoginUrl, SessionExpiredError } = require('./browser');
  const deadline = Date.now() + renderTimeoutMs;
  let body = '';
  let previous = null;
  while (Date.now() < deadline) {
    if (stopped() || isLoginUrl(page.url())) throw new SessionExpiredError();
    body = await page.evaluate(() => document.body.innerText || '');
    const rendered = classifyAnswerPage(body) !== null;
    // Both the composer and profile strip must finish painting and settle.
    if (rendered && previous === body) return { body, rendered: true };
    previous = rendered ? body : null;
    await page.waitForTimeout(500);
  }
  return { body, rendered: false };
}

async function checkOne(context, pair, renderTimeoutMs, stopped, markExpired) {
  const { isLoginUrl, SessionExpiredError } = require('./browser');
  let page;
  try {
    if (stopped()) throw new SessionExpiredError();
    const url = buildAnswerUrl(pair.url, pair.profileId);
    page = await context.newPage();
    if (stopped()) throw new SessionExpiredError();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (isLoginUrl(page.url())) throw new SessionExpiredError();
    let result = await readBodyWhenRendered(page, renderTimeoutMs, stopped);
    if (!result.rendered) {
      if (stopped()) throw new SessionExpiredError();
      // A single reload recovers failed client-side paints without guessing freshness.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      result = await readBodyWhenRendered(page, renderTimeoutMs, stopped);
    }
    if (stopped() || isLoginUrl(page.url())) throw new SessionExpiredError();
    const prefilter = result.rendered ? classifyAnswerPage(result.body) : 'error:render_timeout';
    return { ...pair, prefilter, drop: prefilter !== 'fresh' };
  } catch (e) {
    const expired = stopped() || e.code === 'SESSION_EXPIRED' || (page && isLoginUrl(page.url()));
    if (expired) markExpired();
    return {
      ...pair,
      prefilter: expired ? 'session_expired' : `error:${e.message.slice(0, 80)}`,
      drop: true,
    };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function checkPairs(pairs, {
  config, concurrency = 6, renderTimeoutMs = 20000, browser = null,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  if (!Number.isFinite(renderTimeoutMs) || renderTimeoutMs <= 0) throw new Error('renderTimeoutMs must be positive');
  const seen = new Set();
  const unique = pairs.filter((pair) => {
    const key = `${pair.url}__${pair.profileId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.length) return [];
  const { launchBrowser, newContext } = require('./browser');
  const ownBrowser = !browser;
  let context;
  const rows = new Array(unique.length);
  let expired = false;

  async function run(indices, limit, timeout) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, indices.length) }, async () => {
      while (!expired && next < indices.length) {
        const index = indices[next++];
        const row = await checkOne(context, unique[index], timeout, () => expired, () => { expired = true; });
        rows[index] = row;
        if (row.prefilter === 'session_expired') expired = true;
      }
    }));
    if (expired) {
      for (const index of indices.slice(next)) {
        rows[index] = { ...unique[index], prefilter: 'session_expired', drop: true };
      }
    }
  }

  try {
    if (!browser) browser = await launchBrowser();
    context = await newContext(browser);
    await run(unique.map((_, index) => index), concurrency, renderTimeoutMs);
    if (!expired) {
      const retries = rows.flatMap((row, index) => row.prefilter === 'error:render_timeout' ? [index] : []);
      await run(retries, 2, 45000);
    }
    return rows;
  } catch (e) {
    // Setup failures must fail closed for every pair as well.
    const prefilter = e.code === 'SESSION_EXPIRED' ? 'session_expired' : `error:${e.message.slice(0, 80)}`;
    return unique.map((pair, index) => rows[index] || { ...pair, prefilter, drop: true });
  } finally {
    try {
      if (context) await context.close();
    } finally {
      if (ownBrowser && browser) await browser.close();
    }
  }
}

module.exports = { checkPairs, buildAnswerUrl, classifyAnswerPage };
