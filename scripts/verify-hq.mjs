import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (err) => errors.push(String(err).slice(0, 300)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`.slice(0, 300));
});

await page.goto('http://localhost:5180/', { waitUntil: 'networkidle' });
await page.waitForTimeout(5000);

const sessions = await page.locator('#sessionGrid button').count();
const tabs = await page.locator('#sessionTabs button').count();
const bubbles = await page.locator('#speechTagsContainer > div').count();
const canvas = (await page.locator('#threeContainer canvas').count()) > 0;
await page.screenshot({ path: 'ui-hq-iso.png' });

await page.locator('[data-cam="lounge"]').click();
await page.waitForTimeout(1400);
await page.screenshot({ path: 'ui-hq-lounge.png' });

await page.locator('[data-cam="coffee"]').click();
await page.waitForTimeout(1400);
await page.screenshot({ path: 'ui-hq-coffee.png' });

await page.locator('[data-view="activity"]').click();
await page.waitForTimeout(3000);
const activity = {
  reasoningCards: await page.locator('#thoughtStreamList > div').count(),
  diffPills: await page.locator('#filePillContainer button').count(),
};

await page.locator('[data-view="terminal"]').click();
await page.waitForTimeout(1500);
const terminalRows = await page.locator('#terminalStreamBox > div').count();

console.log(
  JSON.stringify(
    {
      sessions,
      tabs,
      bubbles,
      canvas,
      activity,
      terminalRows,
      errors,
    },
    null,
    2,
  ),
);

await browser.close();
