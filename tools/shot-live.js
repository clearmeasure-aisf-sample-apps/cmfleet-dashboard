// A picture of a deployed site as a reader's browser shows it: node tools/shot-live.js <url> <png> [dark]
import { chromium } from 'playwright';

const [url, png, scheme] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: Number(process.env.WIDTH || 1920), height: 1080 }, colorScheme: scheme === 'dark' ? 'dark' : 'light' });
const complaints = [];
page.on('pageerror', (error) => complaints.push(error.message));
page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) complaints.push(message.text()); });
await page.goto(url);
await page.waitForSelector('body[data-ready="true"]');
await page.waitForTimeout(1500);
await page.screenshot({ path: png, fullPage: true });
console.log(JSON.stringify({ title: await page.title(), tiles: await page.locator('article.tile').count(), asOf: await page.locator('#as-of').textContent(), complaints }));
await browser.close();
