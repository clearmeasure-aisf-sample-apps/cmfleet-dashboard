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
  // The tests reach nothing outside this machine: the health addresses the systems named are real ones.
  for (const system of data.systems) system.health = '';
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

test('a system that is behind the standard is yellow and says why on its face; what is broken stays amber', async () => {
  const data = await dataWith((fleet) => {
    Object.assign(fleet.systems[0], {
      state: 'behind',
      findings: [{ key: `policy/${fleet.systems[0].slug}/code-metrics`, title: `${fleet.systems[0].slug}: no code metrics for web`, class: 'gap', observed: false, scope: 'system' }],
      behind: ['Kit templates: 7 file(s) behind the kit since 2026-10-08 01:24 UTC, within the 24 hours a system has to follow', 'Code metrics: no code metrics for web'],
      standards: [
        { standard: 'registry', label: 'Registry', status: 'met', text: 'system.json agrees' },
        { standard: 'templates', label: 'Kit templates', status: 'behind', text: '7 file(s) behind the kit since 2026-10-08 01:24 UTC' },
        { standard: 'code metrics', label: 'Code metrics', status: 'gap', text: 'no code metrics for web' },
        { standard: 'identity', label: 'GitHub identity', status: 'unchecked', text: 'not checked yet' },
      ],
    });
    Object.assign(fleet.systems[1], {
      state: 'attention', behind: [], standards: [],
      findings: [{ key: `promotion/${fleet.systems[1].slug}/web`, title: `${fleet.systems[1].slug}: web: uat and prod behind tdd`, class: 'broken', observed: false, scope: 'system' }],
    });
    return fleet;
  });
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  await withPage(data, SOON_AFTER, async (page) => {
    const yellow = tile(page, fleet.systems[0].slug);
    assert.equal(await yellow.getAttribute('data-state'), 'behind');
    assert.equal(await yellow.locator('.pill').textContent(), 'Behind the standard');
    assert.deepEqual(await yellow.locator('ul.behind li').allTextContents(), fleet.systems[0].behind);
    assert.equal(await yellow.locator('ul.behind li').first().isVisible(), true);
    assert.equal(await yellow.locator('.standing').textContent(), 'Standards: 1 gap · 1 behind · 1 not checked · 1 met');
    assert.equal(await yellow.locator('.asks li').count(), 0);
    assert.equal(await page.locator(`#landscape g.entity[data-qualified-name$=".${fleet.systems[0].slug}"]`).getAttribute('data-state'), 'behind');
    assert.equal(await yellow.locator('table.standards').isVisible(), false);
    await yellow.locator('summary').click();
    assert.deepEqual(await yellow.locator('table.standards tr[data-status]').evaluateAll((rows) => rows.map((row) => [...row.cells].slice(0, 2).map((cell) => cell.textContent))), [
      ['Registry', 'met'], ['Kit templates', 'behind'], ['Code metrics', 'gap'], ['GitHub identity', 'not checked'],
    ]);
    const amber = tile(page, fleet.systems[1].slug);
    assert.equal(await amber.getAttribute('data-state'), 'attention');
    assert.deepEqual(await amber.locator('.asks li').allTextContents(), ['web: uat and prod behind tdd']);
    assert.equal(await amber.locator('ul.behind').count(), 0);
    assert.equal(await page.locator('#facts .fact.behind b').textContent(), String(fleet.systems.filter((system) => system.state === 'behind').length));
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

test('the name of a system opens its runtime view, its dashboard when it names none, and nothing when it has neither', async () => {
  const data = await dataWith((fleet) => {
    Object.assign(fleet.systems[0], { dashboard: 'https://one.example/', runtimeView: 'https://one.example/#runtime/prod' });
    Object.assign(fleet.systems[1], { dashboard: 'https://two.example/', runtimeView: '' });
    Object.assign(fleet.systems[2], { dashboard: '', runtimeView: '' });
    return fleet;
  });
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  await withPage(data, SOON_AFTER, async (page) => {
    const [first, second, third] = fleet.systems.map((system) => tile(page, system.slug));
    assert.equal(await first.locator('h3 a').getAttribute('href'), 'https://one.example/#runtime/prod');
    assert.deepEqual(await first.locator('.links a').evaluateAll((all) => all.slice(0, 2).map((a) => a.textContent)), ['Runtime view', 'Its dashboard']);
    assert.equal(await second.locator('h3 a').getAttribute('href'), 'https://two.example/');
    assert.equal(await third.locator('h3 a').count(), 0);
  });
});

test('a limit that is used up says so, and only a limit that is passed gets colour', async () => {
  const data = await dataWith((fleet) => {
    fleet.shared.limits = [
      { limit: 'Static Web Apps on the Free plan', where: 'centralus', used: '10', of: '10' },
      { limit: 'Container Apps environments', where: 'southcentralus', used: '2', of: '1' },
      { limit: 'vCPUs', where: 'southcentralus', used: '0', of: '65' },
    ];
    return fleet;
  });
  await withPage(data, SOON_AFTER, async (page) => {
    const full = page.locator('.limit[data-limit="Static Web Apps on the Free plan"]');
    assert.equal(await full.locator('.where').textContent(), 'centralus · full: the next one cannot be made');
    assert.equal(await full.locator('.bar.over').count(), 0);
    const over = page.locator('.limit[data-limit="Container Apps environments"]');
    assert.equal(await over.locator('.where').textContent(), 'southcentralus · over the limit');
    assert.equal(await over.locator('.bar.over').count(), 1);
    assert.equal(await page.locator('.limit').count(), 2);
    assert.equal(await page.locator('#unused').textContent(), '1 other limit with nothing used.');
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
