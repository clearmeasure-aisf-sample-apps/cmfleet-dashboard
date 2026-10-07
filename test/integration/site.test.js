// The built site in a browser, with data the test chose: what a reader sees for fresh data, old data, a failure in
// production and data that cannot be read.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { serve } from '../../tools/serve.js';

const site = resolve(process.env.SITE || 'dist');
const fixtures = resolve('test/fixtures');
const READ_AT = '2026-10-07T04:48:18Z';
const SOON_AFTER = '2026-10-07T05:10:00Z';

let browser;
const made = [];

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
  await Promise.all(made.map((directory) => rm(directory, { recursive: true, force: true })));
});

// A copy of the fixture data, changed by the test, in a directory of its own.
async function dataWith(change) {
  const directory = await mkdtemp(join(tmpdir(), 'cmfleet-data-'));
  made.push(directory);
  await cp(fixtures, directory, { recursive: true });
  const data = JSON.parse(await readFile(join(fixtures, 'fleet.json'), 'utf8'));
  data.generated = READ_AT;
  const changed = change ? change(data) : data;
  if (changed !== null) await writeFile(join(directory, 'fleet.json'), JSON.stringify(changed ?? data));
  else await rm(join(directory, 'fleet.json'));
  return directory;
}

// The tests reach nothing outside this machine: the page's web fonts are answered with an empty stylesheet.
async function newPage(viewport) {
  const page = await browser.newPage({ viewport });
  await page.route(/^https:\/\/fonts\./, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  return page;
}

// Opens the page at a chosen time and hands it to the test with what the browser complained about.
async function withPage(data, now, check) {
  const server = await serve({ site, data });
  const page = await newPage({ width: 1600, height: 1000 });
  const complaints = [];
  page.on('pageerror', (error) => complaints.push(error.message));
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) complaints.push(message.text()); });
  try {
    await page.clock.setFixedTime(new Date(now));
    await page.goto(server.url);
    await page.waitForSelector('body[data-ready="true"]');
    await check(page, complaints);
  } finally {
    await page.close();
    await server.close();
  }
}

const tile = (page, slug) => page.locator(`article.tile[data-system="${slug}"]`);

test('fresh data: every system has a tile, the landscape carries the states, and nothing is complained about', async () => {
  const data = await dataWith();
  const expected = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  await withPage(data, SOON_AFTER, async (page, complaints) => {
    assert.equal(await page.locator('#fleet-name').textContent(), expected.fleet.name);
    assert.match(await page.locator('#as-of').textContent(), /^Read 22 min ago/);
    assert.equal(await page.locator('article.tile').count(), expected.systems.length);
    for (const system of expected.systems) {
      const wanted = system.state === 'unknown' ? 'not-read' : system.state;
      assert.equal(await tile(page, system.slug).getAttribute('data-state'), wanted, system.slug);
      assert.equal(await page.locator(`#landscape g.entity[data-qualified-name$=".${system.slug}"]`).getAttribute('data-state'), wanted, `${system.slug} in the landscape`);
    }
    assert.equal(await page.locator('#services .service').count(), expected.shared.services.length);
    assert.equal(await page.locator('#landscape g.entity[data-qualified-name="octopus"]').getAttribute('data-state'), 'ok');
    assert.equal(await page.locator('#problem').isHidden(), true);
    assert.deepEqual(complaints, []);
  });
});

test('a gap is counted and does not colour the tile; what is broken is on its face', async () => {
  const data = await dataWith((fleet) => {
    const system = fleet.systems[0];
    system.state = 'ok';
    system.findings = [{ key: `policy/${system.slug}/code-metrics`, title: `${system.slug}: no code metrics for web`, class: 'gap', observed: false, scope: 'system' }];
    fleet.systems[1].state = 'attention';
    fleet.systems[1].findings = [{ key: `promotion/${fleet.systems[1].slug}/web`, title: `${fleet.systems[1].slug}: web: uat and prod behind tdd`, class: 'broken', observed: false, scope: 'system' }];
    return fleet;
  });
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  await withPage(data, SOON_AFTER, async (page) => {
    const quiet = tile(page, fleet.systems[0].slug);
    assert.equal(await quiet.getAttribute('data-state'), 'ok');
    assert.equal(await quiet.locator('.asks li').count(), 0);
    assert.match(await quiet.locator('summary').textContent(), /^1 gap/);
    const loud = tile(page, fleet.systems[1].slug);
    assert.equal(await loud.getAttribute('data-state'), 'attention');
    assert.deepEqual(await loud.locator('.asks li').allTextContents(), ['web: uat and prod behind tdd']);
  });
});

test('a failure in production is red on the tile, in the landscape and in the count', async () => {
  const data = await dataWith((fleet) => {
    const system = fleet.systems.find((one) => one.slug === 'jpcom');
    system.state = 'critical';
    system.findings.push({ key: 'deployment/jpcom/jpcom-web/prod', title: 'jpcom: jpcom-web 1.0.29 in prod: Failed', class: 'critical', observed: false, scope: 'system' });
    return fleet;
  });
  await withPage(data, SOON_AFTER, async (page) => {
    assert.equal(await tile(page, 'jpcom').getAttribute('data-state'), 'critical');
    assert.equal(await tile(page, 'jpcom').locator('.pill').textContent(), 'Production affected');
    assert.equal(await tile(page, 'jpcom').locator('.asks li.critical').textContent(), 'jpcom-web 1.0.29 in prod: Failed');
    assert.equal(await page.locator('#landscape g.entity[data-qualified-name$=".jpcom"]').getAttribute('data-state'), 'critical');
    assert.equal(await page.locator('#facts .fact.crit b').textContent(), '1');
  });
});

test('a system switched off on purpose is asleep, not healthy', async () => {
  const data = await dataWith((fleet) => {
    const system = fleet.systems.find((one) => one.slug === 'cmdemo3');
    system.state = 'ok';
    system.asleep = true;
    return fleet;
  });
  await withPage(data, SOON_AFTER, async (page) => {
    assert.equal(await tile(page, 'cmdemo3').getAttribute('data-state'), 'asleep');
    assert.equal(await tile(page, 'cmdemo3').locator('.pill').textContent(), 'Asleep');
  });
});

test('data older than two refreshes: every system and service is not read, and the page says so', async () => {
  const data = await dataWith();
  await withPage(data, '2026-10-07T17:00:00Z', async (page) => {
    assert.match(await page.locator('#as-of').textContent(), /12 h old, older than two of its six-hourly readings/);
    const states = await page.locator('article.tile').evaluateAll((tiles) => tiles.map((one) => one.dataset.state));
    assert.deepEqual([...new Set(states)], ['not-read']);
    const services = await page.locator('#services .service').evaluateAll((all) => all.map((one) => one.dataset.state));
    assert.deepEqual([...new Set(services)], ['not-read']);
  });
});

test('data that cannot be read: the page says so and claims nothing', async () => {
  const data = await dataWith(() => null);
  await withPage(data, SOON_AFTER, async (page) => {
    assert.equal(await page.locator('#problem').isVisible(), true);
    assert.match(await page.locator('#problem').textContent(), /could not be read .*Nothing is known until it can\./);
    assert.equal(await page.locator('article.tile').count(), 0);
  });
});

test('a missing landscape does not take the systems with it', async () => {
  const data = await dataWith();
  await rm(join(data, 'landscape.svg'));
  await withPage(data, SOON_AFTER, async (page) => {
    assert.match(await page.locator('#problem').textContent(), /The landscape could not be read/);
    assert.ok(await page.locator('article.tile').count() > 0);
  });
});

test('a system that names a health address is probed from the page', async () => {
  const data = await dataWith((fleet) => {
    fleet.systems[0].health = '/data/fleet.json';
    fleet.systems[1].health = '/data/absent';
    return fleet;
  });
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  await withPage(data, SOON_AFTER, async (page) => {
    await page.waitForFunction(() => [...document.querySelectorAll('[data-health]')].every((line) => line.dataset.word));
    assert.match(await tile(page, fleet.systems[0].slug).locator('.health').textContent(), /^health: healthy/);
    assert.match(await tile(page, fleet.systems[1].slug).locator('.health').textContent(), /^health: answers 404/);
  });
});

test('the page fits a phone: nothing scrolls sideways', async () => {
  const data = await dataWith();
  const server = await serve({ site, data });
  const page = await newPage({ width: 400, height: 800 });
  try {
    await page.goto(server.url);
    await page.waitForSelector('body[data-ready="true"]');
    const wider = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(wider, 0);
  } finally {
    await page.close();
    await server.close();
  }
});
