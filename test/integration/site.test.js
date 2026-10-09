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
  for (const system of data.systems) Object.assign(system, { health: '', deployments: '' });
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
      assert.equal(await page.locator(`#landscape .entity[data-box="${system.slug}"]`).getAttribute('data-state'), wanted, `${system.slug} in the landscape`);
    }
    assert.equal(await page.locator('#services .service').count(), expected.shared.services.length);
    assert.equal(await page.locator('#landscape .entity[data-box="octopus"]').getAttribute('data-state'), 'ok');
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
    assert.equal(await page.locator(`#landscape .entity[data-box="${fleet.systems[0].slug}"]`).getAttribute('data-state'), 'behind');
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
    assert.equal(await page.locator('#landscape .entity[data-box="jpcom"]').getAttribute('data-state'), 'critical');
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

test('the landscape is drawn from the fleet\'s data: it comes first, and the fleet\'s drawing file is not needed for it', async () => {
  const data = await dataWith();
  await rm(join(data, 'landscape.svg'));
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  await withPage(data, SOON_AFTER, async (page, complaints) => {
    assert.equal(await page.locator('#problem').isHidden(), true);
    assert.equal(await page.locator('#landscape .scape-systems .entity').count(), fleet.systems.length);
    assert.deepEqual(await page.locator('#landscape .scape-systems .entity b').allTextContents(), fleet.systems.map((system) => system.slug));
    assert.equal(await page.locator('#landscape .entity .chip').count(), fleet.systems.filter((system) => system.kitBuilt).length);
    assert.deepEqual(await page.locator('#landscape .scape-rel').allTextContents(), [
      '▶reads the wall', '▼reads every system, and changes nothing', '▼every system is released by Octopus Deploy',
      `▼${fleet.systems.filter((system) => system.kitBuilt).length} of ${fleet.systems.length} pull the delivery standard`, '▶reads, at every deployment',
    ]);
    assert.equal(await page.locator('#landscape .entity[data-box="octopus"] .what').textContent(), fleet.shared.services.find((service) => service.id === 'octopus').detail);
    // First on the page: above the systems, and on the first screen.
    const tops = await page.evaluate(() => ['map', 'systems', 'shared'].map((id) => document.getElementById(id).getBoundingClientRect().top));
    assert.ok(tops[0] < tops[1] && tops[1] < tops[2], `the order of the sections: ${tops}`);
    assert.ok(tops[0] < 1000, `the landscape starts on the first screen: ${tops[0]}`);
    assert.equal(await page.locator('.side a.on').textContent(), 'Landscape');
    assert.equal(await page.locator('#c4').getAttribute('href'), '/data/landscape.svg');
    assert.deepEqual(complaints, []);
  });
});

test('the landscape is never wider than the screen: its boxes wrap', async () => {
  const data = await dataWith();
  const server = await serve({ site, data });
  try {
    for (const width of [400, 820, 1280, 1920]) {
      const page = await newPage({ width, height: 900 });
      await page.clock.setFixedTime(new Date(SOON_AFTER));
      await page.goto(server.url);
      await page.waitForSelector('body[data-ready="true"]');
      const read = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('#landscape .entity, #landscape .cluster')].map((box) => box.getBoundingClientRect());
        return {
          sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          outside: boxes.filter((box) => box.left < 0 || box.right > document.documentElement.clientWidth + 1).length,
          rows: new Set([...document.querySelectorAll('#landscape .scape-systems .entity')].map((box) => Math.round(box.getBoundingClientRect().top))).size,
        };
      });
      assert.equal(read.sideways, 0, `nothing scrolls sideways at ${width}`);
      assert.equal(read.outside, 0, `every box is on the screen at ${width}`);
      // One row where the screen is wide enough for all of them, more rows where it is not.
      if (width >= 1920) assert.equal(read.rows, 1, `rows of systems at ${width}`);
      if (width <= 820) assert.ok(read.rows > 1, `rows of systems at ${width}: ${read.rows}`);
      await page.close();
    }
  } finally {
    await server.close();
  }
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
    // The same answer is a dot on the system's box in the landscape; a system that names no address has no dot.
    const dot = (slug) => page.locator(`#landscape .entity[data-box="${slug}"] .pulse`);
    assert.equal(await dot(fleet.systems[0].slug).getAttribute('data-word'), 'healthy');
    assert.match(await dot(fleet.systems[0].slug).getAttribute('title'), /^health: healthy \(asked just now\)$/);
    assert.equal(await dot(fleet.systems[1].slug).getAttribute('data-word'), 'answers');
    assert.equal(await dot(fleet.systems[2].slug).count(), 0);
    const paint = (slug) => dot(slug).evaluate((one) => document.defaultView.getComputedStyle(one).backgroundColor);
    assert.equal(await paint(fleet.systems[0].slug), 'rgb(0, 171, 98)');
    assert.equal(await paint(fleet.systems[1].slug), 'rgb(214, 61, 61)');
  });
});

test('a system\'s box says what it is made of, where it stands in each environment, what production runs, its state and two numbers', async () => {
  const data = await dataWith((fleet) => {
    Object.assign(fleet.systems[0], {
      state: 'behind', behind: ['GitHub identity: a user\'s token', 'Private build: not yet'], madeOf: 'Container Apps', asleep: false,
      environments: [{ name: 'tdd', tier: 'nonprod' }, { name: 'uat', tier: 'nonprod' }, { name: 'prod', tier: 'prod' }],
      projects: [
        { name: 'web', environments: [
          { name: 'tdd', release: '2.4.43', state: 'Success', finished: '2026-10-07 04:28', url: '' },
          { name: 'uat', release: '2.4.42', state: 'Success', finished: '2026-10-06 21:02', url: '' },
          { name: 'prod', release: '2.4.42', state: 'Success', finished: '2026-10-07 02:10', url: '' },
        ] },
        { name: 'api', environments: [{ name: 'tdd', release: '1.0.7', state: 'Success', finished: '2026-10-07 01:00', url: '' }] },
      ],
      standards: [{ standard: 'tests', label: 'Tests', status: 'met', text: '' }, { standard: 'build', label: 'Private build', status: 'behind', text: '' }, { standard: 'idle', label: 'Idle cost', status: 'met', text: '' }],
      cost: { monthToDate: '1.74', currency: 'USD' },
    });
    Object.assign(fleet.systems[1], { state: 'ok', behind: [], findings: [], asleep: false, cost: null, standards: [] });
    delete fleet.systems[1].madeOf;
    return fleet;
  });
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  await withPage(data, SOON_AFTER, async (page, complaints) => {
    const box = page.locator(`#landscape .entity[data-box="${fleet.systems[0].slug}"]`);
    assert.equal(await box.locator('.made').textContent(), 'Container Apps');
    assert.deepEqual(await box.locator('.env').evaluateAll((all) => all.map((one) => [one.textContent, one.className, one.getAttribute('title')])), [
      ['tdd', 'env same', 'tdd: deployed'], ['uat', 'env behind', 'uat: deployed, behind tdd'], ['prod', 'env behind', 'prod: deployed, behind tdd'],
    ]);
    assert.equal(await box.locator('.runs').textContent(), 'prod 2.4.42 · 3 h');
    assert.equal(await box.locator('.says').textContent(), 'Behind the standard: 2 standards');
    assert.equal(await box.locator('.small').textContent(), '2 of 3 standards · 1.74 USD');
    const tile = (kind) => box.locator(`.env.${kind} i`).first().evaluate((one) => document.defaultView.getComputedStyle(one).backgroundColor);
    assert.equal(await tile('same'), 'rgb(0, 171, 98)');
    assert.equal(await tile('behind'), 'rgb(245, 141, 58)');
    // A system as declared says nothing about its state, and a line the fleet read nothing for is not drawn.
    const quiet = page.locator(`#landscape .entity[data-box="${fleet.systems[1].slug}"]`);
    assert.deepEqual([await quiet.locator('.says').count(), await quiet.locator('.made').count(), await quiet.locator('.small').count()], [0, 0, 0]);
    assert.deepEqual(complaints, []);
  });
});

test('the name of a system zooms into its runtime view, its dashboard when it names none, and opens its Octopus space when it has neither', async () => {
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
    assert.equal(await third.locator('h3 a').getAttribute('href'), fleet.systems[2].space.url);
    assert.equal(await third.locator('h3 a').getAttribute('target'), '_blank');
    assert.equal(await third.locator('h3 a').getAttribute('data-zoom'), null);
    assert.equal(await page.locator(`#landscape .entity[data-box="${fleet.systems[2].slug}"]`).getAttribute('data-open'), fleet.systems[2].space.url);
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

test('a deployment in flight is marked on the tile and on the box, from the file the system publishes', async () => {
  const data = await dataWith((fleet) => {
    fleet.systems[0].deployments = '/data/flights-one.json';
    fleet.systems[1].deployments = '/data/flights-two.json';
    fleet.systems[2].deployments = '/data/absent.json';
    return fleet;
  });
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  const entry = (state, environment, extra = {}) => ({ project: 'web', environment, release: '2.4.43', state, since: '2026-10-07T05:00:00Z', url: 'https://octopus.example/task', ...extra });
  await writeFile(join(data, 'flights-one.json'), JSON.stringify({ generated: READ_AT, deployments: [
    entry('executing', 'uat'), entry('waiting', 'prod'), entry('succeeded', 'tdd', { finished: '2026-10-07T05:05:00Z' }), entry('succeeded', 'tdd', { release: '2.4.42', finished: '2026-10-07T04:00:00Z' }),
  ] }));
  await writeFile(join(data, 'flights-two.json'), JSON.stringify({ generated: READ_AT, deployments: [entry('queued', 'prod')] }));
  await withPage(data, SOON_AFTER, async (page, complaints) => {
    await page.waitForSelector('body[data-flights="read"]');
    const one = tile(page, fleet.systems[0].slug);
    assert.deepEqual(await one.locator('.flights li').allTextContents(), [
      'web 2.4.43 waits for a sign-off in prod', 'deploying web 2.4.43 to uat', 'web 2.4.43 reached tdd 5 min ago',
    ]);
    assert.equal(await one.getAttribute('data-deploying'), 'waiting');
    assert.equal(await page.locator(`#landscape .entity[data-box="${fleet.systems[0].slug}"] .flight.waiting`).count(), 1);
    const two = tile(page, fleet.systems[1].slug);
    assert.deepEqual(await two.locator('.flights li').allTextContents(), ['web 2.4.43 is queued for prod']);
    assert.equal(await page.locator(`#landscape .entity[data-box="${fleet.systems[1].slug}"] .flight.queued`).count(), 1);
    const three = tile(page, fleet.systems[2].slug);
    assert.equal(await three.locator('.flights').isHidden(), true);
    assert.equal(await page.locator(`#landscape .entity[data-box="${fleet.systems[2].slug}"] .flight`).count(), 0);
    assert.equal(await page.locator('#fact-deploying b').textContent(), '2');
    assert.deepEqual(complaints.filter((line) => !line.includes('404')), []);
  });
});

test('a click on a system zooms into its dashboard inside the fleet, and Fleet, Escape and Back zoom out', async () => {
  const data = await dataWith((fleet) => {
    Object.assign(fleet.systems[0], { dashboard: '/health.json', runtimeView: '/health.json?view=runtime' });
    Object.assign(fleet.systems[1], { dashboard: '', runtimeView: '' });
    return fleet;
  });
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  const [first, second] = fleet.systems.map((system) => system.slug);
  await withPage(data, SOON_AFTER, async (page) => {
    const zoomed = () => page.evaluate(() => document.body.dataset.zoomed || '');
    assert.equal(await page.locator('#zoom').isHidden(), true);
    assert.equal(await page.locator(`#landscape .entity[data-box="${second}"]`).getAttribute('data-zoom'), null);

    await page.locator(`#landscape .entity[data-zoom="${first}"]`).click();
    await page.waitForFunction((slug) => document.body.dataset.zoomed === slug, first);
    assert.equal(await page.locator('#zoom').isVisible(), true);
    assert.match(await page.locator('#zoom-frame').getAttribute('src'), /\/health\.json\?view=runtime$/);
    assert.equal(await page.locator('#zoom-name').textContent(), first);
    assert.match(page.url(), new RegExp(`#${first}$`));
    assert.match(await page.frameLocator('#zoom-frame').locator('body').textContent(), /"status": "ok"/);

    await page.locator('#zoom-out').click();
    await page.waitForFunction(() => document.getElementById('zoom').hidden);
    assert.equal(await zoomed(), '');
    assert.doesNotMatch(page.url(), /#/);

    await tile(page, first).locator('h3 a').click();
    await page.waitForFunction((slug) => document.body.dataset.zoomed === slug, first);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('zoom').hidden);

    await page.goBack();
    await page.waitForFunction((slug) => document.body.dataset.zoomed === slug, first);
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('zoom').hidden);
    assert.equal(await page.locator('article.tile').first().isVisible(), true);
  });
});

test('an address that names a system opens it, and reduced motion opens without the animation', async () => {
  const data = await dataWith((fleet) => {
    Object.assign(fleet.systems[0], { dashboard: '/health.json', runtimeView: '' });
    return fleet;
  });
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  const server = await serve({ site, data });
  const page = await newPage({ width: 1600, height: 1000 });
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${server.url}#${fleet.systems[0].slug}`);
    await page.waitForFunction((slug) => document.body.dataset.zoomed === slug, fleet.systems[0].slug);
    assert.match(await page.locator('#zoom-frame').getAttribute('src'), /\/health\.json$/);
    assert.equal(await page.locator('#zoom-own').getAttribute('href'), '/health.json');
    await page.locator('#zoom-out').click();
    await page.waitForFunction(() => document.getElementById('zoom').hidden);
    assert.ok(await page.locator('article.tile').count() > 0);
  } finally {
    await page.close();
    await server.close();
  }
});

test('a system that is asleep is not asked for its health, and says it is asleep also when it is behind', async () => {
  const data = await dataWith((fleet) => {
    Object.assign(fleet.systems[0], { state: 'ok', asleep: true, behind: [], health: '/data/absent' });
    Object.assign(fleet.systems[1], { state: 'behind', asleep: true, behind: ['Kit templates: 2 file(s) behind the kit'], health: '/data/absent' });
    return fleet;
  });
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  await withPage(data, SOON_AFTER, async (page, complaints) => {
    const [quiet, yellow] = [tile(page, fleet.systems[0].slug), tile(page, fleet.systems[1].slug)];
    assert.equal(await quiet.locator('.pill').textContent(), 'Asleep');
    assert.equal(await quiet.locator('.health').textContent(), 'health: not asked while asleep');
    assert.equal(await quiet.locator('.asleep-note').count(), 0);
    assert.equal(await yellow.locator('.pill').textContent(), 'Behind the standard');
    assert.equal(await yellow.locator('.asleep-note').textContent(), 'Asleep: switched off on purpose.');
    assert.equal(await yellow.locator('.health').textContent(), 'health: not asked while asleep');
    assert.deepEqual(complaints, []);
  });
});

test('a system is drawn as a project group: each project, and a tile, the release and when for each environment', async () => {
  const data = await dataWith((fleet) => {
    fleet.systems[0].environments = [{ name: 'tdd', tier: 'nonprod' }, { name: 'uat', tier: 'nonprod' }, { name: 'prod', tier: 'prod' }];
    fleet.systems[0].projects = [
      { name: 'web', environments: [
        { name: 'tdd', release: '2.4.43', state: 'Success', finished: '2026-10-07 04:28', url: 'https://octopus.example/web/tdd' },
        { name: 'uat', release: '2.4.42', state: 'Success', finished: '2026-10-06 21:02', url: '' },
        { name: 'prod', release: '2.4.42', state: 'Failed', finished: '2026-10-06 21:40', url: '' },
      ] },
      { name: 'api', environments: [{ name: 'tdd', release: '1.0.7', state: 'Success', finished: '2026-10-07 01:00', url: '' }] },
      { name: 'never', environments: [{ name: 'tdd', release: '', state: 'not deployed', finished: '', url: '' }] },
    ];
    return fleet;
  });
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  const server = await serve({ site, data });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, timezoneId: 'America/Chicago' });
  await page.route(/^https:\/\/fonts\./, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  try {
    await page.clock.setFixedTime(new Date(SOON_AFTER));
    await page.goto(server.url);
    await page.waitForSelector('body[data-ready="true"]');
    const one = tile(page, fleet.systems[0].slug);
    assert.equal(await one.locator('header .count').textContent(), '2');
    assert.deepEqual(await one.locator('table.releases th').allTextContents(), ['Project', 'tdd', 'uat', 'prod']);
    assert.deepEqual(await one.locator('table.releases td.project').allTextContents(), ['web', 'api']);
    const cells = await one.locator('table.releases td.rel').evaluateAll((all) => all.map((cell) => [
      cell.className, cell.querySelector('.status').getAttribute('aria-label'), cell.querySelector('.num').textContent, cell.querySelector('.when')?.textContent || '',
    ]));
    assert.deepEqual(cells, [
      ['rel same', 'deployed', '2.4.43', 'Oct 6, 2026 11:28 PM'],
      ['rel behind', 'deployed, behind tdd', '2.4.42', 'Oct 6, 2026 4:02 PM'],
      ['rel failed', 'failed', '2.4.42 failed', 'Oct 6, 2026 4:40 PM'],
      ['rel same', 'deployed', '1.0.7', 'Oct 6, 2026 8:00 PM'],
      ['rel none', 'not deployed', 'none', ''],
      ['rel none', 'not deployed', 'none', ''],
    ]);
    assert.equal(await one.locator('td.rel.same a.num').first().getAttribute('href'), 'https://octopus.example/web/tdd');
    assert.equal(await one.locator('table.releases').isVisible(), true);
    // Each environment's name stands above its own tiles: a cell of the grid is a cell of a table, in one row.
    const columns = await one.locator('table.releases').evaluate((table) => {
      const left = (cell) => Math.round(cell.getBoundingClientRect().left);
      const top = (cell) => Math.round(cell.getBoundingClientRect().top);
      const rows = [...table.rows];
      return { heads: [...rows[0].cells].map(left), first: [...rows[1].cells].map(left), tops: [...rows[1].cells].map(top), shown: [...rows[1].cells].map((cell) => document.defaultView.getComputedStyle(cell).display) };
    });
    assert.deepEqual(columns.heads, columns.first, 'the heads and the cells below them start at the same place');
    assert.equal(new Set(columns.tops).size, 1, 'a project is one row');
    assert.deepEqual([...new Set(columns.shown)], ['table-cell']);
    // The tiles are Octopus's: green for what succeeded, red for what failed, none where nothing is.
    const paint = (kind) => one.locator(`td.rel.${kind} .status`).first().evaluate((status) => document.defaultView.getComputedStyle(status).backgroundColor);
    assert.equal(await paint('same'), 'rgb(0, 171, 98)');
    assert.equal(await paint('failed'), 'rgb(214, 61, 61)');
    assert.equal(await paint('none'), 'rgba(0, 0, 0, 0)');
  } finally {
    await page.close();
    await server.close();
  }
});

test('the bar carries the logo and the fleet\'s name, finds systems by what is typed, and the doors lead out', async () => {
  const data = await dataWith();
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  await withPage(data, SOON_AFTER, async (page, complaints) => {
    assert.ok(await page.locator('.topbar .brand img').evaluate((logo) => logo.complete && logo.naturalWidth > 0), 'the logo is loaded');
    assert.equal(await page.locator('.topbar .brand img').getAttribute('alt'), 'Clear Measure');
    assert.equal(await page.locator('.topbar #fleet-name').textContent(), fleet.fleet.name);
    // Clear Measure's own: the face of the headings, the yellow of "behind the standard", the blue of what is selected.
    const style = (selector, property) => page.locator(selector).first().evaluate((one, name) => document.defaultView.getComputedStyle(one).getPropertyValue(name), property);
    assert.match(await style('main h1', 'font-family'), /^Jost, Futura/);
    assert.match(await style('.topbar #fleet-name', 'font-family'), /^Jost, Futura/);
    assert.equal(await style('.pill.behind', 'border-top-color'), 'rgb(238, 203, 26)');
    assert.match(await style('.side a.on', 'box-shadow'), /rgb\(0, 133, 202\)/);
    assert.equal(await page.locator('#shown').textContent(), `${fleet.systems.length} of ${fleet.systems.length} systems`);
    assert.equal(await page.locator('#open-octopus').getAttribute('href'), fleet.fleet.octopus);
    assert.equal(await page.locator('#open-kit').getAttribute('href'), `https://github.com/${fleet.fleet.repository}`);
    assert.equal(await page.locator('#nav-data').getAttribute('href'), '/data/fleet.json');

    const wanted = fleet.systems[1];
    await page.locator('#find').fill(wanted.slug.toUpperCase());
    assert.deepEqual(await page.locator('article.tile:visible').evaluateAll((all) => all.map((one) => one.dataset.system)), [wanted.slug]);
    assert.equal(await page.locator('#shown').textContent(), `1 of ${fleet.systems.length} systems`);
    assert.equal(await page.locator('#no-match').isHidden(), true);
    await page.locator('#find').fill('no system is called this');
    assert.equal(await page.locator('article.tile:visible').count(), 0);
    assert.equal(await page.locator('#no-match').isVisible(), true);
    await page.locator('#find').fill('');
    assert.equal(await page.locator('article.tile:visible').count(), fleet.systems.length);

    // A section beside the page scrolls to its part and leaves the address alone: after "#" it names a system.
    await page.locator('.side a[data-go="shared"]').click();
    await page.waitForFunction(() => document.getElementById('shared').getBoundingClientRect().top < document.documentElement.clientHeight);
    assert.equal(await page.evaluate(() => document.location.hash), '');
    assert.equal(await page.locator('.side a.on').textContent(), 'Shared services');
    assert.deepEqual(complaints, []);
  });
});

test('no box of the landscape does nothing: a system zooms in, every other box opens what it stands for', async () => {
  const data = await dataWith();
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  await withPage(data, SOON_AFTER, async (page, complaints) => {
    // Every box is a real link: a click, Enter and "open in a new tab" all work without a line of script.
    const boxes = await page.locator('#landscape .entity, #landscape .cluster-name').evaluateAll((all) => all.map((box) => [
      box.dataset.box || 'subscription', box.tagName, box.dataset.zoom ? 'zooms' : box.getAttribute('href') || '', box.getAttribute('target') || '', box.getAttribute('rel') || '',
    ]));
    const kit = `https://github.com/${fleet.fleet.repository}`;
    const leads = Object.fromEntries(boxes.map(([name, , where]) => [name, where]));
    assert.deepEqual(boxes.filter(([, tag, where]) => tag !== 'A' || !where), [], 'a box that leads nowhere');
    assert.deepEqual(boxes.filter(([, , where, target, rel]) => where !== 'zooms' && (target !== '_blank' || rel !== 'noopener')), [], 'a box that opens in this tab');
    for (const system of fleet.systems) assert.equal(leads[system.slug], system.runtimeView || system.dashboard ? 'zooms' : system.space.url, system.slug);
    assert.equal(leads.octopus, fleet.fleet.octopus);
    assert.equal(leads.kit, `${kit}/tree/green`);
    assert.equal(leads.policies, `https://github.com/${fleet.fleet.policies}`);
    assert.equal(leads.fleet, `${kit}/tree/main/fleet`);
    assert.match(leads.operators, /\/issues\?q=.*label%3Afleet-finding$/);
    assert.match(leads.subscription, /^https:\/\/portal\.azure\.com\//);
    assert.match(await page.locator('#landscape .entity[data-box="octopus"]').getAttribute('title'), /^Octopus Deploy: As declared\. Opens .+ in a new tab$/);
    const zooming = fleet.systems.find((system) => system.runtimeView || system.dashboard);
    assert.equal(await page.locator(`#landscape .entity[data-box="${zooming.slug}"]`).getAttribute('title'), `${zooming.slug}: ${await tile(page, zooming.slug).locator('.pill').textContent()}. Zooms into its dashboard`);
    assert.equal(await page.evaluate(() => document.body.dataset.zoomed || ''), '');
    assert.deepEqual(await page.locator('#services .service b a').evaluateAll((all) => all.map((link) => link.getAttribute('href'))), [leads.octopus, leads.kit, leads.policies]);
    assert.deepEqual(complaints, []);
  });
});

test('a card leads to the system\'s resource groups in the portal, and the subscription\'s box to the subscription', async () => {
  const portal = 'https://portal.azure.com/#resource/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups';
  const data = await dataWith((fleet) => {
    fleet.fleet.azurePortal = portal;
    fleet.systems[0].azure = [{ group: 'rg-one-nonprod', url: `${portal}/rg-one-nonprod/overview` }, { group: 'rg-one-prod', url: `${portal}/rg-one-prod/overview` }];
    fleet.systems[1].azure = [];
    delete fleet.systems[2].azure;
    return fleet;
  });
  const fleet = JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8'));
  await withPage(data, SOON_AFTER, async (page, complaints) => {
    const azure = (slug) => tile(page, slug).locator('.links a').evaluateAll((all) => all.filter((link) => link.textContent.startsWith('Azure')).map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('target')]));
    assert.deepEqual(await azure(fleet.systems[0].slug), [
      ['Azure: rg-one-nonprod', `${portal}/rg-one-nonprod/overview`, '_blank'], ['Azure: rg-one-prod', `${portal}/rg-one-prod/overview`, '_blank'],
    ]);
    assert.deepEqual(await azure(fleet.systems[1].slug), [['Azure subscription', portal, '_blank']]);
    assert.deepEqual(await azure(fleet.systems[2].slug), [['Azure subscription', portal, '_blank']]);
    assert.equal(await page.locator('#landscape .cluster-name').getAttribute('href'), portal);
    assert.deepEqual(complaints, []);
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

// The fleet's own reading of Octopus (the kit writes it into fleet.json as "activity"): one system with a sign-off
// waiting and a deployment running, one that publishes its own file (which says nothing is in flight) with a freeze
// ahead, one with a freeze in force and nothing else, one where the fleet read that nothing happens, and the rest
// as the data was before the fleet read any of this.
function withActivity(fleet) {
  const three = [{ name: 'tdd', tier: 'nonprod' }, { name: 'uat', tier: 'nonprod' }, { name: 'prod', tier: 'prod' }];
  const [one, two, frozen, quiet] = fleet.systems;
  const flying = (system, state, environment, extra = {}) => ({
    project: `${system.slug}-web`, release: '2.4.76', environment, state, since: '2026-10-07T04:40:00Z', startedBy: 'a-service-account', url: 'https://octopus.example/app#/Spaces-1/tasks/ServerTasks-1', ...extra,
  });
  Object.assign(one, {
    state: 'ok', behind: [], findings: [], asleep: false, environments: three,
    projects: [{ name: `${one.slug}-web`, environments: [
      { name: 'tdd', release: '2.4.76', state: 'Success', finished: '2026-10-07 04:30', url: '' },
      { name: 'uat', release: '2.4.76', state: 'Executing', finished: '', inProgress: true, started: '2026-10-07 04:40', url: '' },
      { name: 'prod', release: '2.4.75', state: 'Queued', finished: '', inProgress: true, started: '2026-10-07 04:38', url: '' },
    ] }],
    activity: { read: READ_AT, missing: [], freezes: [], recent: [{ project: `${one.slug}-web`, release: '2.4.76', environment: 'tdd', result: 'succeeded', finished: '2026-10-07T04:30:00Z', startedBy: 'a-service-account', url: '' }],
      inFlight: [
        flying(one, 'waiting', 'prod', { release: '2.4.75', since: '2026-10-07T04:38:00Z', waitsFor: { kind: 'sign-off', title: 'Sign-off', since: '2026-10-07T04:58:00Z', responsible: 'approvers of the test' } }),
        flying(one, 'executing', 'uat'),
      ] },
  });
  Object.assign(two, {
    state: 'ok', behind: [], findings: [], asleep: false, deployments: '/data/flights-quiet.json',
    activity: { read: READ_AT, missing: [], inFlight: [flying(two, 'executing', 'uat')],
      recent: [{ project: `${two.slug}-web`, release: '2.4.75', environment: 'prod', result: 'succeeded', finished: '2026-10-07T04:50:00Z', startedBy: 'pat', url: '' }],
      freezes: [{ name: 'weekend freeze', from: '2026-10-10T00:00:00Z', to: '2026-10-12T00:00:00Z', active: false, environments: ['prod'], projects: [`${two.slug}-web`] }] },
  });
  Object.assign(frozen, {
    state: 'ok', behind: [], findings: [], asleep: false,
    activity: { read: READ_AT, missing: [], inFlight: [], recent: [], freezes: [{ name: 'audit week', from: '2026-10-06T00:00:00Z', to: '2026-10-12T00:00:00Z', active: true, environments: ['prod'], projects: [] }] },
  });
  Object.assign(quiet, { state: 'ok', behind: [], findings: [], asleep: false, activity: { read: READ_AT, missing: ['freezes'], inFlight: [], recent: [], freezes: [] } });
  fleet.shared.services.find((service) => service.id === 'octopus').activity = { executing: 2, queued: 0, waiting: 1, cap: 20 };
  return fleet;
}

async function activityData() {
  const data = await dataWith(withActivity);
  await writeFile(join(data, 'flights-quiet.json'), JSON.stringify({ generated: READ_AT, deployments: [] }));
  return { data, fleet: JSON.parse(await readFile(join(data, 'fleet.json'), 'utf8')) };
}

const boxOf = (page, slug) => page.locator(`#landscape .entity[data-box="${slug}"]`);
const actsOf = (page, slug) => boxOf(page, slug).locator('.acts .act').evaluateAll((all) => all.map((one) => [one.className, one.textContent, one.dataset.source]));
// How a tile is painted: its fill, its edge (the colour only where it has one) and whether it moves.
const paintOf = (locator) => locator.evaluate((one) => {
  const style = document.defaultView.getComputedStyle(one);
  return [style.backgroundColor, style.borderTopStyle === 'none' ? '' : style.borderTopColor, style.borderTopStyle, style.animationName];
});
const FLIGHT = 'rgb(36, 171, 225)';

test('a system\'s box says what is happening there: who waits for a person, what is deploying, a freeze, and otherwise the last thing', async () => {
  const { data, fleet } = await activityData();
  const [one, two, frozen, quiet, plain] = fleet.systems;
  await withPage(data, SOON_AFTER, async (page, complaints) => {
    await page.waitForSelector('body[data-flights="read"]');
    // The fleet's own reading, 22 minutes old, for a system that publishes no file: the person first, then what runs.
    assert.deepEqual(await actsOf(page, one.slug), [
      ['act act-waiting', 'prod waits for a sign-off, 12 min', 'fleet'], ['act act-deploying', 'deploying web 2.4.76 to uat', 'fleet'],
    ]);
    assert.equal(await boxOf(page, one.slug).locator('.act-waiting').getAttribute('title'),
      `${one.slug}-web 2.4.75 waits for a sign-off in prod; responsible: approvers of the test; started by a-service-account (the fleet's reading of Octopus)`);
    // The system's own file wins: it says nothing is in flight, so the fleet's "executing" is not said. The freeze
    // and the last deployment are what the fleet read.
    assert.deepEqual(await actsOf(page, two.slug), [
      ['act act-freeze', 'prod freezes Sat 00:00 UTC', 'fleet'], ['act act-last', `last: web 2.4.75 to prod, 20 min ago`, 'fleet'],
    ]);
    assert.equal(await boxOf(page, two.slug).locator('.flight').count(), 0);
    assert.deepEqual(await actsOf(page, frozen.slug), [['act act-freeze', 'prod frozen until Mon 00:00 UTC', 'fleet']]);
    // Nothing read, and data without the fields: nothing is said, and nothing takes room.
    for (const slug of [quiet.slug, plain.slug]) {
      assert.equal(await boxOf(page, slug).locator('.acts').isHidden(), true, slug);
      assert.equal(await boxOf(page, slug).locator('.act').count(), 0, slug);
    }
    // The tiles: flight's colour in place of the tick where something is deploying or waiting, and the others as they were.
    const tiles = await boxOf(page, one.slug).locator('.env').evaluateAll((all) => all.map((tile) => [tile.dataset.env, tile.className, tile.dataset.flight || '', tile.title, tile.querySelector('i').getAttribute('aria-label')]));
    assert.deepEqual(tiles, [
      ['tdd', 'env same', '', 'tdd: deployed', 'tdd: deployed'],
      ['uat', 'env progress', 'executing', 'uat: deploying now', 'uat: deploying now'],
      ['prod', 'env progress', 'waiting', 'prod: waits for a person', 'prod: waits for a person'],
    ]);
    const tilePaint = (name) => paintOf(boxOf(page, one.slug).locator(`.env[data-env="${name}"] i`));
    assert.deepEqual(await tilePaint('tdd'), ['rgb(0, 171, 98)', '', 'none', 'none']);
    assert.deepEqual(await tilePaint('uat'), [FLIGHT, '', 'none', 'pulse']);
    assert.deepEqual(await tilePaint('prod'), ['rgba(0, 0, 0, 0)', FLIGHT, 'double', 'none']);
    assert.deepEqual(await boxOf(page, two.slug).locator('.env[data-flight]').count(), 0);
    assert.equal(await boxOf(page, one.slug).locator('.flight.waiting').count(), 1);
    assert.equal(await boxOf(page, one.slug).locator('.runs').textContent(), 'prod 2.4.75 · in progress when read');
    // Where things are: the lines are inside the box, one under the other, under what production runs and above the
    // numbers; the three tiles are still one row inside the box.
    const where = await boxOf(page, one.slug).evaluate((box) => {
      const rect = (one) => { const r = one.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
      return { box: rect(box), runs: rect(box.querySelector('.runs')), acts: [...box.querySelectorAll('.act')].map(rect), small: rect(box.querySelector('.small')), tiles: [...box.querySelectorAll('.env')].map(rect), wider: box.scrollWidth - box.clientWidth };
    });
    assert.equal(where.acts.length, 2);
    for (const act of where.acts) assert.ok(act.left >= where.box.left && act.right <= where.box.right && act.bottom <= where.box.bottom, `a line is inside its box: ${JSON.stringify([act, where.box])}`);
    assert.ok(where.acts[0].top >= where.runs.bottom && where.acts[1].top >= where.acts[0].bottom && where.small.top >= where.acts[1].bottom, JSON.stringify(where));
    assert.equal(new Set(where.tiles.map((tile) => tile.top)).size, 1, 'the tiles are one row');
    assert.ok(where.tiles.every((tile) => tile.left >= where.box.left && tile.right <= where.box.right) && where.tiles[0].right <= where.tiles[1].left && where.tiles[1].right <= where.tiles[2].left, JSON.stringify(where.tiles));
    assert.equal(where.wider, 0);
    // The card: the same deployments are listed, the grid's tiles carry them, and a release that was being deployed
    // when it was read says so where its time would be. The columns still stand above their tiles.
    const card = tile(page, one.slug);
    assert.deepEqual(await card.locator('.flights li').evaluateAll((all) => all.map((li) => [li.className, li.textContent, li.dataset.source])), [
      ['waiting', `${one.slug}-web 2.4.75 waits for a sign-off in prod`, 'fleet'], ['executing', `deploying ${one.slug}-web 2.4.76 to uat`, 'fleet'],
    ]);
    const cells = await card.locator('table.releases td.rel').evaluateAll((all) => all.map((cell) => [
      cell.className, cell.dataset.flight || '', cell.querySelector('.status').getAttribute('aria-label'), cell.querySelector('.num').textContent, cell.querySelector('.when')?.textContent || '', cell.title,
    ]));
    assert.deepEqual(cells.map((cell) => cell.filter((part, index) => index !== 4)), [
      ['rel same', '', 'deployed', '2.4.76', 'finished 2026-10-07 04:30 UTC'],
      ['rel progress', 'executing', `${one.slug}-web / uat: deploying now`, '2.4.76', 'started 2026-10-07 04:40 UTC, not finished when the fleet read it'],
      ['rel progress', 'waiting', `${one.slug}-web / prod: waits for a person`, '2.4.75', 'started 2026-10-07 04:38 UTC, not finished when the fleet read it'],
    ]);
    // A release that is there has its time (in the reader's zone); one that was being deployed says that instead.
    assert.match(cells[0][4], /^Oct [67], 2026 \d+:30 [AP]M$/);
    assert.deepEqual([cells[1][4], cells[2][4]], ['in progress when read', 'in progress when read']);
    assert.deepEqual(await paintOf(card.locator('td.rel[data-flight="executing"] .status')), [FLIGHT, '', 'none', 'pulse']);
    assert.deepEqual((await paintOf(card.locator('td.rel[data-flight="waiting"] .status'))).slice(0, 3), ['rgba(0, 0, 0, 0)', FLIGHT, 'double']);
    const columns = await card.locator('table.releases').evaluate((table) => {
      const left = (cell) => Math.round(cell.getBoundingClientRect().left);
      return { heads: [...table.rows[0].cells].map(left), first: [...table.rows[1].cells].map(left), shown: [...table.rows[1].cells].map((cell) => document.defaultView.getComputedStyle(cell).display) };
    });
    assert.deepEqual(columns.heads, columns.first, 'the heads and the cells below them start at the same place');
    assert.deepEqual([...new Set(columns.shown)], ['table-cell']);
    // One system is deploying: the one whose flight the page may claim of now.
    assert.equal(await page.locator('#fact-deploying b').textContent(), '1');
    // The Octopus instance: what it is doing, beside its count against the cap, inside its box.
    const octopus = boxOf(page, 'octopus');
    assert.equal(await octopus.locator('.what').textContent(), '4 of 20 tasks');
    assert.deepEqual(await octopus.locator('.acts .act').evaluateAll((all) => all.map((one) => [one.className, one.textContent])), [['act act-instance num', '2 running · 1 waits for a person']]);
    const inside = await octopus.evaluate((box) => { const b = box.getBoundingClientRect(); const a = box.querySelector('.act').getBoundingClientRect(); const w = box.querySelector('.what').getBoundingClientRect(); return a.left >= b.left && a.right <= b.right && a.top >= w.bottom && a.bottom <= b.bottom; });
    assert.equal(inside, true, 'the instance\'s line is inside its box, under its count');
    assert.equal(await boxOf(page, 'kit').locator('.acts').count(), 0);
    assert.deepEqual(complaints, []);
  });
});

test('what the fleet read as in flight more than half an hour ago is said in the past tense and marks nothing', async () => {
  const { data, fleet } = await activityData();
  const [one, two] = fleet.systems;
  await withPage(data, '2026-10-07T07:48:18Z', async (page) => {
    await page.waitForSelector('body[data-flights="read"]');
    assert.deepEqual(await actsOf(page, one.slug), [
      ['act act-earlier', 'prod waited for a sign-off when read 3 h ago', 'fleet'], ['act act-earlier', 'was deploying web 2.4.76 to uat when read 3 h ago', 'fleet'],
    ]);
    assert.equal(await boxOf(page, one.slug).locator('.env[data-flight]').count(), 0);
    assert.equal(await boxOf(page, one.slug).locator('.flight').count(), 0);
    // The release that was being deployed still has no time, and still says why.
    assert.deepEqual(await boxOf(page, one.slug).locator('.env').evaluateAll((all) => all.map((tile) => [tile.className, tile.title])), [
      ['env same', 'tdd: deployed'], ['env progress', 'uat: in progress when read'], ['env progress', 'prod: in progress when read'],
    ]);
    assert.deepEqual(await paintOf(boxOf(page, one.slug).locator('.env.progress i').first()), [FLIGHT, '', 'none', 'none']);
    assert.deepEqual(await paintOf(tile(page, one.slug).locator('td.rel.progress .status').first()), [FLIGHT, '', 'none', 'none']);
    assert.deepEqual(await tile(page, one.slug).locator('.flights li').evaluateAll((all) => all.map((li) => [li.className, li.textContent])), [
      ['earlier', `${one.slug}-web 2.4.75 waited for a sign-off in prod when the fleet read it 3 h ago`], ['earlier', `${one.slug}-web 2.4.76 was deploying to uat when the fleet read it 3 h ago`],
    ]);
    assert.equal(await tile(page, one.slug).getAttribute('data-deploying'), null);
    assert.equal(await tile(page, one.slug).locator('td.rel[data-flight]').count(), 0);
    assert.deepEqual(await actsOf(page, two.slug), [['act act-freeze', 'prod freezes Sat 00:00 UTC', 'fleet'], ['act act-last', 'last: web 2.4.75 to prod, 3 h ago', 'fleet']]);
    assert.equal(await page.locator('#fact-deploying b').textContent(), '0');
  });
});

test('the system\'s own file says what is in flight when it publishes one, and the box says it in the same words', async () => {
  const { data, fleet } = await activityData();
  const two = fleet.systems[1];
  await writeFile(join(data, 'flights-quiet.json'), JSON.stringify({ generated: SOON_AFTER, deployments: [
    { project: `${two.slug}-web`, environment: 'tdd', release: '2.4.77', state: 'executing', since: '2026-10-07T05:08:00Z', url: 'https://octopus.example/task' },
  ] }));
  await withPage(data, SOON_AFTER, async (page) => {
    await page.waitForSelector('body[data-flights="read"]');
    assert.deepEqual(await actsOf(page, two.slug), [['act act-deploying', 'deploying web 2.4.77 to tdd', 'system'], ['act act-freeze', 'prod freezes Sat 00:00 UTC', 'fleet']]);
    assert.equal(await boxOf(page, two.slug).locator('.act-deploying').getAttribute('title'), `deploying ${two.slug}-web 2.4.77 to tdd (the system's own deployments.json)`);
    assert.deepEqual(await boxOf(page, two.slug).locator('.env[data-flight]').evaluateAll((all) => all.map((tile) => [tile.dataset.env, tile.dataset.flight])), [['tdd', 'executing']]);
    assert.deepEqual(await tile(page, two.slug).locator('.flights li').allTextContents(), [`deploying ${two.slug}-web 2.4.77 to tdd`]);
  });
});

test('data without the fleet\'s activity draws as it did: no line, no tile in flight, nothing more in the Octopus box', async () => {
  const data = await dataWith();
  await withPage(data, SOON_AFTER, async (page, complaints) => {
    await page.waitForSelector('body[data-flights="read"]');
    assert.equal(await page.locator('#landscape .act').count(), 0);
    assert.equal(await page.locator('#landscape .acts:not([hidden])').count(), 0);
    assert.equal(await page.locator('[data-flight]').count(), 0);
    assert.equal(await page.locator('.progress').count(), 0);
    assert.equal(await boxOf(page, 'octopus').locator('.acts').count(), 0);
    assert.deepEqual(await boxOf(page, 'octopus').evaluate((box) => [...box.children].map((child) => child.className)), ['', 'what']);
    assert.deepEqual(complaints, []);
  });
});

test('with reduced motion nothing of the activity moves, and on a phone it stays inside its box', async () => {
  const { data, fleet } = await activityData();
  const one = fleet.systems[0];
  const server = await serve({ site, data });
  const page = await browser.newPage({ viewport: { width: 400, height: 800 }, reducedMotion: 'reduce' });
  await page.route(/^https:\/\/fonts\./, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  try {
    await page.clock.setFixedTime(new Date(SOON_AFTER));
    await page.goto(server.url);
    await page.waitForSelector('body[data-flights="read"]');
    assert.deepEqual(await actsOf(page, one.slug), [['act act-waiting', 'prod waits for a sign-off, 12 min', 'fleet'], ['act act-deploying', 'deploying web 2.4.76 to uat', 'fleet']]);
    assert.equal((await paintOf(boxOf(page, one.slug).locator('.env[data-flight="executing"] i')))[3], 'none');
    assert.equal(await boxOf(page, one.slug).locator('.act-deploying').evaluate((line) => document.defaultView.getComputedStyle(line, '::before').animationName), 'none');
    assert.equal((await paintOf(tile(page, one.slug).locator('td.rel[data-flight="executing"] .status')))[3], 'none');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    const fits = await boxOf(page, one.slug).evaluate((box) => { const b = box.getBoundingClientRect(); return [...box.querySelectorAll('.act')].every((act) => { const a = act.getBoundingClientRect(); return a.left >= b.left && a.right <= b.right; }); });
    assert.equal(fits, true);
  } finally {
    await page.close();
    await server.close();
  }
});
