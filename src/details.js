'use strict';

function extractQuestionText(fullText) {
  const match = (fullText || '').match(/Question\n([\s\S]{0,1800})/);
  return match ? match[1].split('\nAnswer\n')[0] : '';
}

async function fetchDetails(urls, { config, concurrency = 4, browser = null }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  const startedAt = new Date().toISOString();
  const unique = [...new Set(urls)];
  const details = {};
  if (!unique.length) return { startedAt, complete: true, details };
  const { launchBrowser, newContext, isLoginUrl, SessionExpiredError } = require('./browser');
  const ownBrowser = !browser;
  let context;
  let next = 0;
  try {
    if (!browser) browser = await launchBrowser();
    context = await newContext(browser);
    async function worker() {
      let page;
      try {
        while (next < unique.length) {
          const url = unique[next++];
          try {
            if (!page) page = await context.newPage();
            await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
            await page.waitForTimeout(1200);
            if (isLoginUrl(page.url())) throw new SessionExpiredError();
            const text = await page.evaluate(() => document.body.innerText);
            if (!text || !text.trim()) throw new Error('question details returned empty text');
            details[url] = { full_text: text.substring(0, 5000) };
          } catch (e) {
            details[url] = { error: e.code === 'SESSION_EXPIRED' ? 'session_expired' : e.message };
          }
        }
      } finally {
        if (page) await page.close();
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
    return { startedAt, complete: unique.every((url) => Boolean(details[url] && details[url].full_text)), details };
  } finally {
    try {
      if (context) await context.close();
    } finally {
      if (ownBrowser && browser) await browser.close();
    }
  }
}

module.exports = { fetchDetails, extractQuestionText };
