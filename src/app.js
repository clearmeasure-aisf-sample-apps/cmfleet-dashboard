// The page: reads the fleet's data and its landscape from where the fleet publishes them, and draws the wall. What
// each thing means is decided in model.js; this file only puts it on the page.
import { initZoom, openFromAddress } from './zoom.js';
import {
  STATE_WORDS, asked, azureLinks, behindReasons, boxLinks, counts, deploymentMarks, displayState, flightState, fleetFacts, formatAge, formatWhen, healthWord, hostOf, limitShare, limitsInUse,
  matches, observed, releaseGrid, releaseWord, serviceState, standing, standingSummary, systemDoor, systemLink, withoutSlug,
} from './model.js';

const RELOAD_MINUTES = 5;
const FLIGHT_SECONDS = 60;
const SVG = 'http://www.w3.org/2000/svg';
const byId = (id) => document.getElementById(id);

function el(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'text') element.textContent = value;
    else if (value !== null && value !== undefined && value !== '') element.setAttribute(name, value);
  }
  for (const child of [].concat(children)) if (child) element.append(child);
  return element;
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

async function readJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function readText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

function drawFacts(data, facts) {
  byId('fleet-name').textContent = data.fleet.name;
  byId('as-of').textContent = facts.stale
    ? `The fleet's data is ${formatAge(facts.age)} old, older than two of its six-hourly readings: nothing below is a reading of now.`
    : `Read ${formatAge(facts.age)} ago. Deployments from Octopus, findings from the fleet's rules, cost from Azure for the month to date.`;
  byId('as-of').classList.toggle('stale', facts.stale);
  const list = [
    [String(facts.systems), 'systems', ''],
    [String(facts.critical), 'production affected', facts.critical ? 'crit' : ''],
    [String(facts.attention), 'need attention', facts.attention ? 'attn' : ''],
    [String(facts.behind), 'behind the standard', facts.behind ? 'behind' : ''],
    [String(facts.broken), 'broken', ''],
    [String(facts.gaps), 'gaps', ''],
    ['0', 'deploying', '', 'fact-deploying'],
    [facts.cost, 'this month', ''],
  ];
  if (facts.notRead) list.splice(4, 0, [String(facts.notRead), 'not read', '']);
  byId('facts').replaceChildren(...list.map(([value, label, kind, id]) => el('div', { class: `fact ${kind}`, id }, [
    el('b', { class: 'num', text: value }), el('span', { text: label }),
  ])));
}

// A box that opens what it stands for beside this page, for the mouse and for the keyboard.
function opens(box, name, url) {
  box.setAttribute('data-open', url);
  box.setAttribute('data-box', name);
  box.setAttribute('role', 'link');
  box.setAttribute('tabindex', '0');
  const title = box.querySelector(':scope > title') || box.insertBefore(document.createElementNS(SVG, 'title'), box.firstChild);
  title.textContent = [title.textContent, `Opens ${hostOf(url)} in a new tab`].filter(Boolean).join('. ');
}

// Every box that is not a system, and the frame of the subscription, opens what it stands for.
function openOthers(drawing, data) {
  for (const [name, url] of Object.entries(boxLinks(data))) {
    const box = [...drawing.querySelectorAll('g.entity, g.cluster')].find((one) => (one.getAttribute('data-qualified-name') || '') === name);
    if (box) opens(box, name, url);
  }
}

// The landscape is the fleet's own drawing. Its boxes are found by name and take the state of what they stand for.
function drawLandscape(svgText, data, facts) {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
  if (parsed.nodeName !== 'svg') throw new Error('the landscape is not an SVG drawing');
  for (const unwanted of parsed.querySelectorAll('script, foreignObject')) unwanted.remove();
  for (const name of ['style', 'width', 'height', 'preserveAspectRatio', 'zoomAndPan', 'contentStyleType']) parsed.removeAttribute(name);
  parsed.setAttribute('role', 'img');
  parsed.setAttribute('aria-label', 'System landscape of the fleet');
  const mark = (name, state, label) => {
    const box = [...parsed.querySelectorAll('g.entity')].find((entity) => {
      const qualified = entity.getAttribute('data-qualified-name') || '';
      return qualified === name || qualified.endsWith(`.${name}`);
    });
    if (!box) return null;
    box.setAttribute('data-state', state);
    box.setAttribute('data-box', name);
    const title = document.createElementNS(SVG, 'title');
    title.textContent = `${label}: ${STATE_WORDS[state]}`;
    box.prepend(title);
    return box;
  };
  // No box is left that does nothing. A system zooms into its runtime view or its dashboard; one that names neither
  // opens its space in Octopus.
  for (const system of data.systems) {
    const box = mark(system.slug, displayState(system, facts.stale), system.slug);
    if (!box) continue;
    if (systemLink(system)) box.setAttribute('data-zoom', system.slug);
    else if (systemDoor(system)) opens(box, system.slug, systemDoor(system));
  }
  for (const service of data.shared.services || []) mark(service.id, serviceState(service, facts.stale), service.name);
  openOthers(parsed, data);
  byId('landscape').replaceChildren(document.importNode(parsed, true));
}

const titles = (findings, slug) => el('ul', {}, findings.map((finding) => el('li', { text: withoutSlug(finding.title, slug) })));

// A system as Octopus draws a project group: each project, and in each environment a tile for how its last
// deployment ended, the release and when. A release behind the first environment's keeps its colour for that.
function drawReleases(system) {
  const grid = releaseGrid(system);
  if (!grid.rows.length) return { count: 0, grid: el('p', { class: 'sub', text: 'Nothing read in any environment.' }) };
  const table = el('table', { class: 'releases' }, [el('tr', {}, [el('th', {}, [el('span', { class: 'sr', text: 'Project' })]), ...grid.names.map((name) => el('th', { text: name }))])]);
  for (const row of grid.rows) {
    table.append(el('tr', {}, [
      el('td', { class: 'project' }, [el('span', { class: 'cell' }, [el('span', { class: 'icon', 'aria-hidden': 'true' }), el('span', { class: 'what', text: row.project })])]),
      ...row.cells.map((cell) => el('td', { class: `rel ${cell.kind}`, title: cell.finished ? `finished ${cell.finished} UTC` : '' }, [el('span', { class: 'cell' }, [
        el('span', { class: 'status', role: 'img', 'aria-label': releaseWord(cell, grid.names[0]) }),
        el('span', { class: 'release' }, [
          cell.url ? el('a', { class: 'num', href: cell.url, text: cell.text }) : el('span', { class: 'num', text: cell.text }),
          cell.finished ? el('span', { class: 'when', text: formatWhen(cell.finished) }) : null,
        ]),
      ])])),
    ]));
  }
  return { count: grid.rows.length, grid: el('div', { class: 'grid-wrap' }, [table]) };
}

// Where the system stands on every standard of the fleet, with the fleet's own words for why.
function drawStanding(system) {
  const rows = standing(system);
  if (!rows.length) return null;
  const table = el('table', { class: 'standards' }, [el('tr', {}, [el('th', { text: 'Standard' }), el('th', { text: 'Stands' }), el('th', { text: 'What the fleet read' })])]);
  for (const row of rows) {
    table.append(el('tr', { 'data-status': row.status }, [el('td', { text: row.label }), el('td', { class: 'stands', text: row.word }), el('td', { class: 'why', text: row.text })]));
  }
  return el('div', { class: 'grid-wrap' }, [table]);
}

function drawLinks(system, fleet) {
  const fee = system.parts.filter((part) => !/registry/i.test(part.part)).length;
  const link = (url, text) => (url ? el('a', { href: url, text }) : null);
  return [
    el('div', { class: 'meta' }, [
      el('span', {}, [el('b', { class: 'num', text: system.cost ? `${system.cost.monthToDate} ${system.cost.currency}` : 'n/a' }), ' this month']),
      el('span', {}, [el('b', { class: 'num', text: String(fee) }), fee === 1 ? ' part with a fee running' : ' parts with a fee running']),
      el('span', { text: `Owner: ${system.owner || 'not declared'}` }),
    ]),
    el('div', { class: 'links' }, [
      link(system.runtimeView, 'Runtime view'),
      link(system.dashboard, 'Its dashboard') || el('span', { class: 'sub', text: 'No dashboard of its own' }),
      link(system.repositoryUrl, 'Repository'), link(system.space?.url, 'Octopus space'), link(system.findingsUrl, 'Findings'),
      ...azureLinks(system, fleet).map((one) => el('a', { href: one.url, target: '_blank', rel: 'noopener', text: one.text })),
    ]),
  ];
}

// What a system never had, what is only observed and what it declares as intended: counted in the summary, read on
// demand. Colour and the tile's face are for what has stopped working.
function drawMore(system, fleet) {
  const count = counts(system);
  const summary = [
    count.gap ? plural(count.gap, 'gap', 'gaps') : '',
    count.observed ? `${count.observed} observed` : '',
    system.variances.length ? plural(system.variances.length, 'variance', 'variances') : '',
    standing(system).length ? 'every standard' : '',
    'cost, links',
  ].filter(Boolean).join(' · ');
  const more = el('details', {}, [el('summary', { text: summary }), drawStanding(system)]);
  if (count.observed) more.append(el('h4', { text: 'Observed, nothing asked' }), titles(observed(system), system.slug));
  if (system.variances.length) {
    more.append(el('h4', { text: 'Intended variances' }), el('ul', {}, system.variances.map((variance) => el('li', {}, [variance.variance, el('span', { text: ` ${variance.reason}` })]))));
  }
  more.append(...drawLinks(system, fleet));
  return more;
}

function drawTile(system, facts, fleet) {
  const state = displayState(system, facts.stale);
  const releases = drawReleases(system);
  const tile = el('article', { class: 'tile', 'data-state': state, 'data-system': system.slug });
  tile.append(el('header', {}, [
    el('h3', {}, [
      systemLink(system) ? el('a', { href: systemLink(system), 'data-zoom': system.slug, text: system.slug })
        : systemDoor(system) ? el('a', { href: systemDoor(system), target: '_blank', rel: 'noopener', text: system.slug }) : system.slug,
    ]),
    releases.count ? el('span', { class: 'count', title: plural(releases.count, 'project', 'projects'), text: String(releases.count) }) : null,
    el('span', { class: 'sub', text: system.name }),
    el('span', { class: `pill ${state}`, text: STATE_WORDS[state] }),
  ]));
  tile.append(releases.grid, el('ul', { class: 'flights', hidden: 'hidden' }));
  const broken = asked(system).filter((finding) => finding.class !== 'gap');
  if (broken.length) {
    tile.append(el('ul', { class: 'asks' }, broken.map((finding) => el('li', { class: finding.class === 'critical' ? 'critical' : '', text: withoutSlug(finding.title, system.slug) }))));
  }
  // Why the system is behind the standard: on the face of the tile, because a reader should not have to open
  // anything to learn that a system is behind and why.
  if (behindReasons(system).length) tile.append(el('ul', { class: 'behind' }, behindReasons(system).map((reason) => el('li', { text: reason }))));
  if (standing(system).length) tile.append(el('p', { class: 'standing', text: `Standards: ${standingSummary(system)}` }));
  // A system that is switched off on purpose is not asked: no answer would be the truth, and it would read as a failure.
  if (system.asleep && state !== 'asleep') tile.append(el('p', { class: 'sub asleep-note', text: 'Asleep: switched off on purpose.' }));
  if (system.health && system.asleep) tile.append(el('p', { class: 'health', text: 'health: not asked while asleep' }));
  else if (system.health) tile.append(el('p', { class: 'health', 'data-health': system.health, text: 'health: not probed yet' }));
  tile.append(drawMore(system, fleet));
  return tile;
}

function drawShared(data, facts) {
  byId('services').replaceChildren(...(data.shared.services || []).map((service) => {
    const state = serviceState(service, facts.stale);
    const url = boxLinks(data)[service.id];
    return el('div', { class: 'service', 'data-state': state, 'data-service': service.id }, [
      url ? el('b', {}, [el('a', { href: url, target: '_blank', rel: 'noopener', text: service.name })]) : el('b', { text: service.name }),
      el('span', { class: `pill ${state}`, text: STATE_WORDS[state] }),
      el('span', { class: 'detail', text: service.detail || '' }),
    ]);
  }));
  const limits = limitsInUse(data.shared.limits || []);
  byId('limits').replaceChildren(...limits.used.map((limit) => {
    const { share, over, full } = limitShare(limit);
    const note = over ? 'over the limit' : full ? 'full: the next one cannot be made' : '';
    return el('div', { class: 'limit', 'data-limit': limit.limit }, [
      el('div', { class: 'name' }, [el('b', { class: 'num', text: `${limit.used} of ${limit.of}` }), ` ${limit.limit}`]),
      el('div', { class: `bar ${over ? 'over' : ''}` }, [el('i', { style: `width:${share}%` })]),
      el('div', { class: 'where', text: [limit.where, note].filter(Boolean).join(' · ') }),
    ]);
  }));
  byId('unused').textContent = limits.unused ? `${plural(limits.unused, 'other limit', 'other limits')} with nothing used.` : '';
}

// The doors out of this page: the Octopus instance every system is released in, the delivery standard, the data.
function drawDoors(data) {
  const door = (id, url) => {
    const link = byId(id);
    if (url) link.setAttribute('href', url);
    link.hidden = !url;
  };
  const kit = data.fleet.repository ? `https://github.com/${data.fleet.repository}` : '';
  door('open-octopus', data.fleet.octopus);
  door('nav-octopus', data.fleet.octopus);
  door('open-kit', kit);
  door('nav-kit', kit);
  door('nav-data', `${config.dataUrl}fleet.json`);
}

// What the reader typed in the bar: the systems that have it in their name, in what they are or in a project's name.
function find() {
  const typed = byId('find').value;
  const tiles = [...document.querySelectorAll('article.tile')];
  let shown = 0;
  for (const tile of tiles) {
    const system = last?.data.systems.find((one) => one.slug === tile.dataset.system);
    tile.hidden = Boolean(system) && !matches(system, typed);
    if (!tile.hidden) shown += 1;
  }
  byId('shown').textContent = tiles.length ? `${shown} of ${plural(tiles.length, 'system', 'systems')}` : '';
  byId('no-match').hidden = shown > 0 || tiles.length === 0;
}

function drawFoot(data, config) {
  const rest = (data.shared.cost || []).find((cost) => cost.of !== 'the fleet');
  const read = (text) => (text ? text.replace('T', ' ').replace(/:\d\dZ$/, ' UTC') : 'not read');
  byId('foot').replaceChildren(
    el('p', { text: `Inputs: findings ${read(data.read?.findings)}, deployments ${read(data.read?.status)}, limits and cost ${read(data.read?.limits)}.`
      + (rest ? ` The rest of the subscription cost ${rest.monthToDate} ${rest.currency} this month.` : '')
      + ((data.missing || []).length ? ` Missing in that run: ${data.missing.join(', ')}.` : '') }),
    el('p', {}, ['Data: ', el('a', { href: `${config.dataUrl}fleet.json`, text: 'fleet.json' }), `, written by workflow fleet of ${data.fleet.repository}. This page: `, el('a', { href: 'build.json', text: 'what it was built from' }), '.']),
  );
}

// Each system may name a public health address. The probe runs in the reader's browser, so it says what is true now.
// An address that does not answer within this time is not responding: a request that hangs is not left open.
const PROBE_SECONDS = 10;

async function probe(url) {
  const within = () => AbortSignal.timeout(PROBE_SECONDS * 1000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: within() });
    return { ok: response.ok, status: response.status };
  } catch {
    try {
      await fetch(url, { cache: 'no-store', mode: 'no-cors', signal: within() });
      return { opaque: true };
    } catch {
      return { error: true };
    }
  }
}

async function probeAll() {
  await Promise.all([...document.querySelectorAll('[data-health]')].map(async (line) => {
    const word = healthWord(await probe(line.dataset.health));
    line.textContent = `health: ${word} (asked just now)`;
    line.dataset.word = word.replace(/\s.*$/, '');
  }));
}

function problem(text) {
  byId('problem').textContent = text;
  byId('problem').hidden = !text;
}

let config = null;
let last = null;
// What each system says is being deployed, by its name: read from the file the system itself publishes.
const flights = new Map();

// A dot on the system's box in the landscape: filled and pulsing while something runs, hollow while it waits its
// turn, ringed while it waits for a person, small and still for what just ended.
function drawBadge(slug, state, text) {
  const box = document.querySelector(`#landscape g.entity[data-box="${slug}"]`);
  if (!box) return;
  box.querySelector('.flight')?.remove();
  if (!state) { box.removeAttribute('data-deploying'); return; }
  box.setAttribute('data-deploying', state);
  const rect = box.querySelector('rect');
  if (!rect) return;
  const { x, y, width } = rect.getBBox();
  const badge = document.createElementNS(SVG, 'circle');
  badge.setAttribute('class', `flight ${state}`);
  badge.setAttribute('cx', String(x + width - 16));
  badge.setAttribute('cy', String(y + 16));
  badge.setAttribute('r', '9');
  const title = document.createElementNS(SVG, 'title');
  title.textContent = text;
  badge.append(title);
  box.append(badge);
}

function drawFlights(now) {
  let deploying = 0;
  for (const system of last?.data.systems || []) {
    const marks = deploymentMarks(flights.get(system.slug), now);
    const state = flightState(marks);
    if (state && state !== 'finished') deploying += 1;
    const tile = document.querySelector(`article.tile[data-system="${system.slug}"]`);
    const list = tile?.querySelector('.flights');
    if (list) {
      list.replaceChildren(...marks.map((mark) => el('li', { class: mark.state }, [mark.url ? el('a', { href: mark.url, text: mark.text }) : mark.text])));
      list.hidden = marks.length === 0;
      if (state) tile.dataset.deploying = state; else delete tile.dataset.deploying;
    }
    drawBadge(system.slug, state, marks.map((mark) => mark.text).join('; '));
  }
  const fact = byId('fact-deploying');
  if (fact) {
    fact.querySelector('b').textContent = String(deploying);
    fact.classList.toggle('flight', deploying > 0);
  }
}

// Every minute, from each system's own file. A file that cannot be read marks nothing: no marker is not a claim.
async function loadFlights() {
  await Promise.all((last?.data.systems || []).filter((system) => system.deployments).map(async (system) => {
    try { flights.set(system.slug, await readJson(system.deployments)); } catch { flights.delete(system.slug); }
  }));
  drawFlights(new Date());
  document.body.dataset.flights = 'read';
}

function draw(now) {
  if (!last) return;
  const facts = fleetFacts(last.data, now);
  drawFacts(last.data, facts);
  if (last.svg) drawLandscape(last.svg, last.data, facts);
  byId('tiles').replaceChildren(...last.data.systems.map((system) => drawTile(system, facts, last.data.fleet)));
  find();
  drawShared(last.data, facts);
  drawFoot(last.data, config);
  drawDoors(last.data);
  drawFlights(now);
  document.body.dataset.ready = 'true';
}

async function load() {
  try {
    config ??= await readJson('config.json');
    const data = await readJson(`${config.dataUrl}fleet.json`);
    let svg = '';
    try { svg = await readText(`${config.dataUrl}${data.landscape || 'landscape.svg'}`); } catch { svg = ''; }
    last = { data, svg };
    problem(svg ? '' : 'The landscape could not be read; the systems below are as the fleet last wrote them.');
  } catch (error) {
    problem(last
      ? `The fleet's data could not be read just now (${error.message}). What is shown is the last reading this page has.`
      : `The fleet's data could not be read (${error.message}). Nothing is known until it can.`);
    document.body.dataset.ready = 'true';
  }
  draw(new Date());
  await Promise.all([probeAll(), loadFlights()]);
}

// A system has something to zoom into when it names a runtime view or a dashboard.
initZoom((slug) => {
  const system = last?.data.systems.find((one) => one.slug === slug);
  return system && systemLink(system) ? { name: system.slug, url: systemLink(system) } : null;
});
// A box of the landscape that is not a system opens what it stands for, beside this page: with a click, or with Enter
// when the keyboard is on it.
function openBox(event) {
  if (event.type === 'keydown' && event.key !== 'Enter') return;
  const box = event.target.closest?.('[data-open]');
  if (!box) return;
  event.preventDefault();
  window.open(box.dataset.open, '_blank', 'noopener');
}
byId('landscape').addEventListener('click', openBox);
byId('landscape').addEventListener('keydown', openBox);
byId('find').addEventListener('input', find);
// The sections beside the page scroll to their part of it. The address is left alone: after "#" it names the system
// that is zoomed into.
for (const link of document.querySelectorAll('.side a[data-go]')) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    byId(link.dataset.go)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    for (const other of document.querySelectorAll('.side a[data-go]')) other.classList.toggle('on', other === link);
  });
}
load().then(openFromAddress);
setInterval(load, RELOAD_MINUTES * 60000);
setInterval(loadFlights, FLIGHT_SECONDS * 1000);
