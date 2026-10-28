'use strict';

function parseDa(value) {
  return parseInt(String(value == null ? '' : value).replace(/\D/g, ''), 10) || 0;
}

async function extractCurrent(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const row of document.querySelectorAll('tr, [role="row"]')) {
      const cells = row.querySelectorAll('td, [role="cell"], [role="gridcell"]');
      if (cells.length < 3) continue;
      const first = (cells[0].innerText || '').trim();
      const start = first.length < 5 || cells[0].querySelector('input[type="checkbox"]') ? 1 : 0;
      const question = cells[start];
      if (!question) continue;
      const text = (question.innerText || '').trim();
      if (text.length < 20 || text.toLowerCase() === 'question') continue;
      const link = question.querySelector('a[href*="/experts/questions/"]') ||
        row.querySelector('a[href*="/experts/questions/"]');
      const url = link ? link.href : '';
      if (seen.has(url || text)) continue;
      seen.add(url || text);
      const cellText = (index) => cells[index] ? (cells[index].innerText || '').trim() : '';
      out.push({
        text: text.substring(0, 1000), url,
        publication: cellText(start + 1), deadline: cellText(start + 2), da: cellText(start + 3),
      });
    }
    return out;
  });
}

async function clickNextPage(page) {
  return page.evaluate(() => {
    // Current pager: icon buttons whose only name is hidden text, e.g. <span class="sr-only">Go to next page</span>.
    const hidden = Array.from(document.querySelectorAll('button')).find((button) =>
      /^\s*Go to next page\s*$/i.test(((button.querySelector('.sr-only') || {}).textContent) || ''));
    if (hidden) {
      if (hidden.disabled || hidden.getAttribute('aria-disabled') === 'true') return false;
      hidden.click();
      return true;
    }
    const selectors = [
      'button[aria-label="Go to next page"]', 'button[aria-label*="next page" i]',
      'button[aria-label*="Next" i]', 'a[aria-label*="next" i]',
    ];
    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (button) {
        if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
        button.click();
        return true;
      }
    }
    // No positional guessing: clicking "some small button near the bottom" is how scans silently
    // stopped after a few pages. An unknown pager stops the scan and the caller reports it incomplete.
    return false;
  });
}

async function getPageInfo(page) {
  return page.evaluate(() => {
    const match = document.body.innerText.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
    return match ? { current: parseInt(match[1], 10), total: parseInt(match[2], 10) } : null;
  });
}

async function scanQuestions({ config, browser = null }) {
  const { launchBrowser, newContext, isLoginUrl, SessionExpiredError } = require('./browser');
  const ownBrowser = !browser;
  let context;
  try {
    if (!browser) browser = await launchBrowser();
    context = await newContext(browser);
    const page = await context.newPage();
    await page.goto(`${config.baseUrl}/experts/questions`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(5000);
    if (isLoginUrl(page.url())) throw new SessionExpiredError();
    try {
      const nativeMax = await page.evaluate(() => {
        for (const select of document.querySelectorAll('select')) {
          const values = Array.from(select.options).map((option) => option.value);
          if (values.includes('10') || values.includes('100')) {
            const max = values.map(Number).filter((n) => !isNaN(n)).sort((a, b) => b - a)[0];
            if (max && max > 10) {
              select.value = String(max);
              select.dispatchEvent(new Event('change', { bubbles: true }));
              return max;
            }
          }
        }
        return null;
      });
      // Current page: a custom listbox labeled "Rows per page" (10, 20, 50, 100) instead of a <select>.
      const combo = page.locator('[aria-label="Rows per page"]').first();
      if (!nativeMax && await combo.count()) {
        await combo.click();
        await page.waitForTimeout(800);
        const sizes = (await page.locator('[role="option"]').allInnerTexts()).map((t) => parseInt(t, 10)).filter(Number.isFinite);
        if (sizes.length) {
          const max = Math.max(...sizes);
          await page.locator('[role="option"]', { hasText: new RegExp(`^\\s*${max}\\s*$`) }).first().click();
        } else {
          await page.keyboard.press('Escape');
        }
      }
    } catch {
      // The boost is optional; normal pagination still collects all rows.
    }
    await page.waitForTimeout(3000);
    const info = await getPageInfo(page);
    const maxPages = Math.min(info ? info.total : 100, 100);
    const unique = new Map();
    let emptyPages = 0;
    let lastPage = 0;
    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      if (isLoginUrl(page.url())) throw new SessionExpiredError();
      const before = unique.size;
      for (const item of await extractCurrent(page)) {
        const key = item.url || item.text.substring(0, 100);
        if (!unique.has(key)) unique.set(key, { ...item, da: parseDa(item.da) });
      }
      emptyPages = unique.size === before ? emptyPages + 1 : 0;
      lastPage = pageNum;
      if (emptyPages >= 3 || pageNum === maxPages) break;
      if (!await clickNextPage(page)) break;
      await page.waitForTimeout(2500);
    }
    const items = Array.from(unique.values());
    if (!items.length) throw new Error('question scan returned zero rows');
    // A scan that stopped before the last page must say so; a short feed otherwise looks like a quiet day.
    const complete = !info || !info.total || lastPage >= info.total;
    return { scannedAt: new Date().toISOString(), count: items.length, complete, pagesRead: lastPage, pagesTotal: info ? info.total : null, items };
  } finally {
    try {
      if (context) await context.close();
    } finally {
      if (ownBrowser && browser) await browser.close();
    }
  }
}

async function main() {
  const path = require('path');
  const { newRunDir, writeJsonAtomic } = require('./paths');
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : null;
  if (outIndex >= 0 && (!out || out.startsWith('--'))) throw new Error('--out requires a file');
  const result = await scanQuestions({ config: require('./config').loadConfig() });
  writeJsonAtomic(out || path.join(newRunDir(), 'feed.json'), result);
  console.log(`Scanned ${result.count.toLocaleString('en-US')} questions.`);
}

module.exports = { scanQuestions, parseDa };

if (require.main === module) {
  main().catch((e) => {
    if (e.code === 'SESSION_EXPIRED') {
      console.error('Session expired. Run: npm run login');
      process.exit(2);
    }
    console.error(e.message);
    process.exit(1);
  });
}
