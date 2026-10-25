import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (err) => errors.push(String(err).slice(0, 300)));

// Simulate a slow JS boot so the pre-boot state is observable.
await page.route('**/src/main.ts*', async (route) => {
  await new Promise((r) => setTimeout(r, 2500));
  await route.continue();
});

// Saved dark theme must be applied before first paint.
await page.addInitScript(() => localStorage.setItem('hq-theme', 'dark'));

await page.goto('http://localhost:5180/', { waitUntil: 'commit' });
await page.waitForSelector('#app', { state: 'attached', timeout: 5000 });
await page.waitForTimeout(250);

const early = await page.evaluate(() => {
  const app = document.getElementById('app');
  const splash = document.getElementById('bootSplash');
  return {
    appHidden: getComputedStyle(app).visibility === 'hidden',
    splashVisible: !!splash && getComputedStyle(splash).backgroundColor === 'rgb(9, 9, 11)',
    darkPrePaint: document.documentElement.classList.contains('dark'),
    staticHeaderIcons: document.querySelectorAll('header svg').length,
    rawTextHidden: getComputedStyle(document.getElementById('sessionNameTag')).visibility === 'hidden',
  };
});
await page.screenshot({ path: 'ui-boot-splash.png' });

await page.waitForFunction(() => document.documentElement.classList.contains('app-ready'), null, { timeout: 15_000 });
// Splash removal can be delayed while the first live session sync builds every
// character rig; wait for it instead of a fixed sleep, bounded to 5 s.
await page.waitForFunction(() => !document.getElementById('bootSplash'), null, { timeout: 5_000 });
await page.waitForTimeout(300);

const after = await page.evaluate(() => ({
  appVisible: getComputedStyle(document.getElementById('app')).visibility === 'visible',
  splashRemoved: !document.getElementById('bootSplash'),
  canvas: !!document.querySelector('#threeContainer canvas'),
}));

await page.screenshot({ path: 'ui-boot-after.png' });

console.log(JSON.stringify({ early, after, errors }, null, 2));
await browser.close();
