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
    const buttons = Array.from(document.querySelectorAll('button')).filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.bottom > window.innerHeight - 150 && rect.width < 60;
    });
    if (buttons.length >= 2) {
      const next = buttons[buttons.length - 2];
      if (!next.disabled && next.getAttribute('aria-disabled') !== 'true') {
        next.click();
        return true;
      }
    }
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
      await page.evaluate(() => {
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
    } catch {
      // The boost is optional; normal pagination still collects all rows.
    }
    await page.waitForTimeout(3000);
    const info = await getPageInfo(page);
    const maxPages = Math.min(info ? info.total : 100, 100);
    const unique = new Map();
    let emptyPages = 0;
    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      if (isLoginUrl(page.url())) throw new SessionExpiredError();
      const before = unique.size;
      for (const item of await extractCurrent(page)) {
        const key = item.url || item.text.substring(0, 100);
        if (!unique.has(key)) unique.set(key, { ...item, da: parseDa(item.da) });
      }
      emptyPages = unique.size === before ? emptyPages + 1 : 0;
      if (emptyPages >= 3 || pageNum === maxPages || !await clickNextPage(page)) break;
      await page.waitForTimeout(2500);
    }
    const items = Array.from(unique.values());
    if (!items.length) throw new Error('question scan returned zero rows');
    return { scannedAt: new Date().toISOString(), count: items.length, items };
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
