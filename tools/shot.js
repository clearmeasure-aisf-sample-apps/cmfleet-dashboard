// A picture of the page with the tests' data, for a person to look at: node tools/shot.js <site> <data> <png> [dark]
import { chromium } from 'playwright';
import { serve } from './serve.js';

const [site, data, png, scheme] = process.argv.slice(2);
const server = await serve({ site, data });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: Number(process.env.WIDTH || 1920), height: 1080 }, colorScheme: scheme === 'dark' ? 'dark' : 'light' });
await page.clock.setFixedTime(new Date(process.env.NOW || Date.now()));
await page.goto(server.url);
await page.waitForSelector('body[data-ready="true"]');
await page.waitForTimeout(800);
await page.screenshot({ path: png, fullPage: true });
await browser.close();
await server.close();
