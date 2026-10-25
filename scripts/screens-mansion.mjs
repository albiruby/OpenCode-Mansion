import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
});

await page.goto('http://localhost:5180/', { waitUntil: 'networkidle' });
await page.waitForTimeout(5000);
await page.screenshot({ path: 'ui-mansion-overview.png' });

for (const preset of ['office', 'pool', 'padel', 'soccer', 'basketball', 'gym', 'lounge', 'coffee']) {
  await page.locator(`[data-cam="${preset}"]`).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `ui-mansion-${preset}.png` });
}

// Let idle squads roam to the sports wing.
await page.locator('[data-cam="pool"]').click();
await page.waitForTimeout(35_000);
await page.screenshot({ path: 'ui-mansion-pool-later.png' });
await page.locator('[data-cam="soccer"]').click();
await page.waitForTimeout(4000);
await page.screenshot({ path: 'ui-mansion-soccer-later.png' });

const info = await page.evaluate(() => ({
  summary: document.getElementById('sessionSummary')?.textContent,
  cards: document.querySelectorAll('#sessionGrid button').length,
  tabs: document.querySelectorAll('#sessionTabs button').length,
  mode: document.getElementById('modeLabel')?.textContent,
}));

console.log(JSON.stringify({ info, errors }, null, 2));
await browser.close();
