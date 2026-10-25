import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1080 } });
await page.goto('http://localhost:5180/', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
await page.locator('[data-cam="top"]').click();
await page.waitForTimeout(1800);
await page.screenshot({ path: 'ui-campus-top.png' });
console.log('ok');
await browser.close();
