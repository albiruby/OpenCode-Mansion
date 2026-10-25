import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (err) => errors.push(String(err).slice(0, 400)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`.slice(0, 300));
});

await page.goto('http://localhost:5180/', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

const state = await page.evaluate(() => ({
  mode: document.getElementById('modeLabel')?.textContent,
  sessionsChip: document.getElementById('sessionCounter')?.textContent,
  tokens: document.getElementById('tokenCounter')?.textContent,
  cost: document.getElementById('costCounter')?.textContent,
  headerSession: document.getElementById('sessionNameTag')?.textContent,
  headerModel: document.getElementById('modelTag')?.textContent,
  tabs: document.querySelectorAll('#sessionTabs button').length,
  cards: document.querySelectorAll('#sessionGrid button').length,
  selectorOptions: document.querySelectorAll('#sessionSelector option').length,
  firstCard: document.querySelector('#sessionGrid button')?.innerText.slice(0, 400),
  canvas: !!document.querySelector('#threeContainer canvas'),
}));

await page.screenshot({ path: 'ui-live-office.png' });

// Select the second session, if present
const cards = page.locator('#sessionGrid button');
if ((await cards.count()) > 1) {
  await cards.nth(1).click();
  await page.waitForTimeout(1200);
}

const dossier = await page.evaluate(() => ({
  name: document.getElementById('dossierName')?.textContent,
  state: document.getElementById('dossierState')?.textContent,
  model: document.getElementById('dossierTool')?.textContent,
  tokens: document.getElementById('dossierLoad')?.textContent,
}));

await page.locator('[data-view="activity"]').click();
await page.waitForTimeout(3000);
const activity = await page.evaluate(() => ({
  pills: document.querySelectorAll('#filePillContainer button').length,
  filename: document.getElementById('activeDiffFilename')?.textContent,
  diffText: document.getElementById('diffCodeContent')?.innerText.slice(0, 300),
  thoughts: document.querySelectorAll('#thoughtStreamList > div').length,
}));
await page.screenshot({ path: 'ui-live-activity.png' });

await page.locator('[data-view="terminal"]').click();
await page.waitForTimeout(1500);
const terminal = await page.evaluate(() => ({
  rows: document.querySelectorAll('#terminalStreamBox > div').length,
  text: document.getElementById('terminalStreamBox')?.innerText.slice(0, 400),
}));
await page.screenshot({ path: 'ui-live-terminal.png' });

console.log(JSON.stringify({ state, dossier, activity, terminal, errors }, null, 2));
await browser.close();
