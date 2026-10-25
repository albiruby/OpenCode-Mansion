import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 500)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 400));
});

await page.goto('http://localhost:5180/', { waitUntil: 'networkidle' });
await page.waitForTimeout(4500);

const canvas = page.locator('#threeContainer canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('3D canvas has no bounding box');
const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

// Decorative meshes must stay silent: hovering the overview lawn shows nothing.
await page.mouse.move(center.x, center.y);
await page.waitForTimeout(350);
const hoverDecorative = await page.evaluate(() => {
  const el = document.getElementById('hoverTooltip');
  return { visible: !!el && !el.classList.contains('hidden'), text: el?.textContent ?? '' };
});

// Board preset: the board screen is centered, so clicking must inspect it.
await page.locator('[data-cam="board"]').click();
await page.waitForTimeout(1600);
await page.mouse.move(center.x, center.y);
await page.waitForTimeout(300);
const boardHover = await page.evaluate(() => {
  const el = document.getElementById('hoverTooltip');
  return { visible: !!el && !el.classList.contains('hidden'), text: el?.textContent ?? '' };
});
await page.mouse.click(center.x, center.y);
await page.waitForTimeout(450);
const boardInspect = await page.evaluate(() => ({
  visible: !document.getElementById('inspectCard')?.classList.contains('hidden'),
  kind: document.getElementById('inspectKind')?.textContent ?? '',
  title: document.getElementById('inspectTitle')?.textContent ?? '',
  detail: document.getElementById('inspectDetail')?.textContent ?? '',
  presetVisible: !document.getElementById('inspectPreset')?.classList.contains('hidden'),
}));
await page.screenshot({ path: 'ui-interaction-board.png' });

// Focus button should keep the inspector usable, then close cleanly.
await page.locator('#inspectFocus').click();
await page.waitForTimeout(950);
await page.locator('#inspectClose').click();
const inspectorClosed = !(await page.locator('#inspectCard').isVisible());

// Decorative object: click the Animal Village lawn in the overview. After the
// interaction trim this must open NOTHING (previously it fell back to a
// generic "Ground Surface" inspector card).
await page.locator('[data-cam="overview"]').click();
await page.waitForTimeout(1400);
const genericPoint = {
  x: box.x + box.width * 0.7,
  y: box.y + box.height * 0.7,
};
await page.mouse.move(genericPoint.x, genericPoint.y);
await page.waitForTimeout(300);
const decorTooltip = await page.evaluate(() => {
  const el = document.getElementById('hoverTooltip');
  return { visible: !!el && !el.classList.contains('hidden'), text: el?.textContent ?? '' };
});
await page.mouse.click(genericPoint.x, genericPoint.y);
await page.waitForTimeout(450);
const decorInspect = await page.evaluate(() => ({
  visible: !document.getElementById('inspectCard')?.classList.contains('hidden'),
  kind: document.getElementById('inspectKind')?.textContent ?? '',
}));
await page.screenshot({ path: 'ui-interaction-decorative.png' });

// Clicking an agent must still select its real session instead of opening the inspector.
await page.locator('[data-cam="office"]').click();
await page.waitForTimeout(1500);
const speech = await page.evaluate(() => {
  const el = [...document.querySelectorAll('[id^="speech-"]')].find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return getComputedStyle(candidate).opacity !== '0' && rect.width > 0 && rect.height > 0;
  });
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, id: el.id };
});
let agentClick = null;
if (speech) {
  await page.mouse.click(speech.x + speech.width / 2, speech.y + speech.height + 22);
  await page.waitForTimeout(600);
  agentClick = {
    speech: speech.id,
    dossier: (await page.locator('#dossierName').textContent())?.trim() ?? '',
    inspectorVisible: await page.locator('#inspectCard').isVisible(),
  };
}

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);

console.log(
  JSON.stringify(
    { hoverDecorative, boardHover, boardInspect, inspectorClosed, decorTooltip, decorInspect, agentClick, overflow, errors },
    null,
    2,
  ),
);
await browser.close();
