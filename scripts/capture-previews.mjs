/**
 * Generates sanitized README previews into docs/preview/.
 * Live-data screens and DOM labels are hidden during capture so no real
 * session titles ever appear in the public images. Run with the dev server up.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('docs/preview', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:5180/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.classList.contains('app-ready'), null, {
  timeout: 25000,
});
await page.waitForTimeout(8000);

// Hide any DOM overlay that shows text while screenshotting the scene.
await page.addStyleTag({
  content:
    '.speech-bubble-3d, #hoverTooltip, #inspectCard, #quickDossier, p.absolute { display: none !important; }',
});

const shots = [
  { preset: 'overview', file: 'campus-overview.png', dark: false },
  { preset: 'office', file: 'campus-office.png', dark: false },
  { preset: 'pool', file: 'campus-pool.png', dark: false },
  { preset: 'village', file: 'campus-village.png', dark: false },
];

for (const shot of shots) {
  await page.locator(`[data-cam="${shot.preset}"]`).click();
  await page.waitForTimeout(1700);
  await page.evaluate(() => {
    const debug = window.__hqPhysics;
    if (debug?.hideLiveScreens) debug.hideLiveScreens(true);
  });
  await page.locator('#threeContainer').screenshot({ path: `docs/preview/${shot.file}` });
  await page.evaluate(() => {
    const debug = window.__hqPhysics;
    if (debug?.hideLiveScreens) debug.hideLiveScreens(false);
  });
}

// One night-mode hero shot.
await page.locator('#themeBtn').click();
await page.waitForTimeout(4000);
await page.locator('[data-cam="overview"]').click();
await page.waitForTimeout(1700);
await page.evaluate(() => {
  const debug = window.__hqPhysics;
  if (debug?.hideLiveScreens) debug.hideLiveScreens(true);
});
await page.locator('#threeContainer').screenshot({ path: 'docs/preview/campus-dark.png' });
await page.evaluate(() => {
  const debug = window.__hqPhysics;
  if (debug?.hideLiveScreens) debug.hideLiveScreens(false);
});

console.log('previews written to docs/preview/');
await browser.close();
