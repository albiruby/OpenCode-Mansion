import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});

await page.goto('http://localhost:5180/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.locator('[data-cam="iso"]').click();
await page.waitForTimeout(1300);
await page.screenshot({ path: 'ui-shot-iso.png' });

for (const preset of ['lounge', 'coffee', 'dev', 'server', 'top']) {
  await page.locator(`[data-cam="${preset}"]`).click();
  await page.waitForTimeout(1300);
  await page.screenshot({ path: `ui-shot-${preset}.png` });
}

console.log(JSON.stringify({ errors }, null, 2));
await browser.close();
