import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (err) => errors.push(String(err).slice(0, 300)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`.slice(0, 300));
});

await page.goto('http://localhost:5180/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);

const state = {
  canvasInContainer: (await page.locator('#threeContainer canvas').count()) > 0,
  headerIcons: await page.locator('header svg').count(),
  mode: (await page.locator('#modeLabel').textContent())?.trim(),
  sessionCards: await page.locator('#sessionGrid button').count(),
  sessionTabs: await page.locator('#sessionTabs button').count(),
  tokens: (await page.locator('#tokenCounter').textContent())?.trim(),
  terminalLines: await page.locator('#terminalStreamBox > div').count(),
  sessionsVisible: await page.locator('#sessionGrid').isVisible(),
};

// Bridge modal
await page.locator('#bridgeBtn').click();
const modalVisible = await page.locator('#cliModal').isVisible();
await page.keyboard.press('Escape');
const modalClosed = !(await page.locator('#cliModal').isVisible());

// Office lighting must not change the dashboard theme
const officeBefore = await page.evaluate(() => localStorage.getItem('hq-office-theme'));
await page.locator('#themeBtn').click();
await page.waitForTimeout(700);
const officeAfter = await page.evaluate(() => localStorage.getItem('hq-office-theme'));
const dashboardStayedDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
await page.locator('#themeBtn').click();

// Click a session card and check the dossier reflects real data
const cards = page.locator('#sessionGrid button');
let dossier = null;
if ((await cards.count()) > 0) {
  await cards.first().click();
  await page.waitForTimeout(700);
  dossier = {
    name: (await page.locator('#dossierName').textContent())?.trim(),
    state: (await page.locator('#dossierState').textContent())?.trim(),
    model: (await page.locator('#dossierTool').textContent())?.trim(),
    tokens: (await page.locator('#dossierLoad').textContent())?.trim(),
  };
}

await page.screenshot({ path: 'ui-verify-live.png' });

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

console.log(
  JSON.stringify(
    {
      state,
      modalVisible,
      modalClosed,
      officeThemeToggled: officeBefore !== officeAfter,
      dashboardStayedDark,
      dossier,
      mobileHorizontalOverflow: overflow,
      consoleErrors: errors,
    },
    null,
    2,
  ),
);

await browser.close();
