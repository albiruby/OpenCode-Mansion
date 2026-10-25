import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 400)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
});

await page.goto('http://localhost:5180/', { waitUntil: 'networkidle' });
await page.waitForTimeout(6000);
await page.screenshot({ path: 'ui-animals-overview.png' });

for (const preset of ['pool', 'lounge', 'office', 'soccer']) {
  await page.locator(`[data-cam="${preset}"]`).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `ui-animals-${preset}.png` });
}

await page.locator('[data-cam="overview"]').click();
await page.waitForTimeout(22000);
await page.screenshot({ path: 'ui-animals-overview-later.png' });

const info = await page.evaluate(() => ({
  summary: document.getElementById('sessionSummary')?.textContent,
  cards: document.querySelectorAll('#sessionGrid button').length,
  mode: document.getElementById('modeLabel')?.textContent,
}));

console.log(JSON.stringify({ info, errors }, null, 2));
await browser.close();
