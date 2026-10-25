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
await page.screenshot({ path: 'ui-mega-overview.png' });

const info = await page.evaluate(() => ({
  summary: document.getElementById('sessionSummary')?.textContent,
  cards: document.querySelectorAll('#sessionGrid button').length,
  tabs: document.querySelectorAll('#sessionTabs button').length,
  mode: document.getElementById('modeLabel')?.textContent,
  cardsText: document.querySelector('#sessionGrid button')?.innerText.slice(0, 200),
}));

for (const preset of ['office', 'pool', 'soccer', 'basketball', 'gym', 'cinema']) {
  const btn = page.locator(`[data-cam="${preset}"]`);
  if ((await btn.count()) === 0) continue;
  await btn.click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `ui-mega-${preset}.png` });
}

await page.locator('[data-cam="overview"]').click();
await page.waitForTimeout(25000);
await page.screenshot({ path: 'ui-mega-overview-later.png' });

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

console.log(JSON.stringify({ info, overflow, errors }, null, 2));
await browser.close();
