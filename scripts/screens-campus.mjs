import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 500)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 400));
});

await page.goto('http://localhost:5180/', { waitUntil: 'networkidle' });
await page.waitForTimeout(6500);
await page.screenshot({ path: 'ui-campus-overview.png' });

const info = await page.evaluate(() => ({
  summary: document.getElementById('sessionSummary')?.textContent,
  cards: document.querySelectorAll('#sessionGrid button').length,
  tabs: document.querySelectorAll('#sessionTabs button').length,
  mode: document.getElementById('modeLabel')?.textContent,
  canvas: !!document.querySelector('#threeContainer canvas'),
  commandButtons: document.querySelectorAll('[data-cam="command"]').length,
}));

for (const preset of ['office', 'command', 'board', 'village', 'pool']) {
  const btn = page.locator(`[data-cam="${preset}"]`);
  if ((await btn.count()) === 0) {
    errors.push(`missing camera preset: ${preset}`);
    continue;
  }
  await btn.click();
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `ui-campus-${preset}.png` });
}

await page.locator('[data-cam="overview"]').click();
await page.waitForTimeout(2000);
await page.screenshot({ path: 'ui-campus-overview-final.png' });

// The dashboard must stay dark while the 3D estate relights.
await page.locator('#themeBtn').click();
await page.waitForTimeout(1500);
await page.screenshot({ path: 'ui-campus-dark.png' });
const dashboardStayedDark = await page.evaluate(() =>
  document.documentElement.classList.contains('dark'),
);
await page.locator('#themeBtn').click();
await page.waitForTimeout(1200);

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);

console.log(JSON.stringify({ info, overflow, dashboardStayedDark, errors }, null, 2));
await browser.close();
