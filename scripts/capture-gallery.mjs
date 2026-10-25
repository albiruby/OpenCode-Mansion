/**
 * Captures the README gallery into docs/gallery/. Uses the live dev server on
 * http://localhost:5180 and drives the real UI (camera presets, inspect,
 * agent-click dossier, views, modal, night mode). Real session data is shown —
 * these images are deliberately temporary showcase material.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('docs/gallery', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:5180/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.classList.contains('app-ready'), null, {
  timeout: 30000,
});
await page.waitForTimeout(8500);

const container = page.locator('#threeContainer');
const cam = async (preset) => {
  await page.locator(`[data-cam="${preset}"]`).click();
  await page.waitForTimeout(1700);
};

// 1. Hero: full dashboard, campus + jungle in daylight.
await page.locator('[data-cam="overview"]').click();
await page.waitForTimeout(1700);
await page.screenshot({ path: 'docs/gallery/01-hero-light.png' });

// 2. Command Center live screen with the inspector card open.
await cam('command');
const canvasBox = await container.boundingBox();
if (canvasBox) {
  await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await page.waitForTimeout(700);
}
await container.screenshot({ path: 'docs/gallery/02-inspect-command.png' });

// 3. Live session board.
await cam('board');
await container.screenshot({ path: 'docs/gallery/03-session-board.png' });

// 4. Office floor: agents at desks, CC0 rigs, physics world.
await cam('office');
await container.screenshot({ path: 'docs/gallery/04-office-agents.png' });

// 5. Agent dossier: click a visible speech-bubble avatar.
let dossierShot = false;
const speech = await page.evaluate(() => {
  const el = [...document.querySelectorAll('[id^="speech-"]')].find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return getComputedStyle(candidate).opacity !== '0' && rect.width > 0 && rect.y > 80;
  });
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height + 26 };
});
if (speech) {
  await page.mouse.click(speech.x, speech.y);
  await page.waitForTimeout(1200);
  await container.screenshot({ path: 'docs/gallery/05-agent-dossier.png' });
  dossierShot = true;
}

// 6-9. Feature areas with realistic props.
await cam('lounge');
await container.screenshot({ path: 'docs/gallery/06-lounge-cc0.png' });
await cam('coffee');
await container.screenshot({ path: 'docs/gallery/07-coffee-cart.png' });
await cam('village');
await container.screenshot({ path: 'docs/gallery/08-animal-village.png' });
await cam('pool');
await container.screenshot({ path: 'docs/gallery/09-pool-sports.png' });

// 10. Top-down campus layout.
await cam('top');
await container.screenshot({ path: 'docs/gallery/10-topdown.png' });

// 11. Night mode hero (full dashboard).
await page.locator('[data-cam="overview"]').click();
await page.waitForTimeout(800);
await page.locator('#themeBtn').click();
await page.waitForTimeout(4200);
await page.screenshot({ path: 'docs/gallery/11-hero-night.png' });

// 12. Live event stream (terminal view).
await page.locator('[data-view="terminal"]').click();
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/gallery/12-event-stream.png' });

// 13. Activity / session reasoning view.
await page.locator('[data-view="activity"]').click();
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/gallery/13-activity.png' });

// 14. Bridge connect modal.
await page.locator('[data-view="office"]').click();
await page.waitForTimeout(600);
await page.locator('#bridgeBtn').click();
await page.waitForTimeout(700);
await page.screenshot({ path: 'docs/gallery/14-connect-modal.png' });
await page.keyboard.press('Escape');
await page.locator('#modalCloseBtn').click({ timeout: 3000 }).catch(() => undefined);
await page.waitForTimeout(400);

// 15. Mobile layout.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/gallery/15-mobile.png' });

// Restore light office theme for the next local run.
await page.setViewportSize({ width: 1600, height: 1000 });
await page.locator('#themeBtn').click();
await page.waitForTimeout(1500);

console.log(
  JSON.stringify({
    dossier: dossierShot,
    out: 'docs/gallery/',
    files: 15 - (dossierShot ? 0 : 1),
  }),
);
await browser.close();
