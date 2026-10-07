// The page: reads the fleet's data and its landscape from where the fleet publishes them, and draws the wall. What
// each thing means is decided in model.js; this file only puts it on the page.
import {
  STATE_WORDS, asked, counts, displayState, fleetFacts, formatAge, healthWord, limitShare, limitsInUse, observed,
  prodRows, releaseGrid, serviceState, systemLink, withoutSlug,
} from './model.js';

const RELOAD_MINUTES = 5;
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
    [String(facts.broken), 'broken', ''],
    [String(facts.gaps), 'gaps', ''],
    [facts.cost, 'this month', ''],
  ];
  if (facts.notRead) list.splice(3, 0, [String(facts.notRead), 'not read', '']);
  byId('facts').replaceChildren(...list.map(([value, label, kind]) => el('div', { class: `fact ${kind}` }, [
    el('b', { class: 'num', text: value }), el('span', { text: label }),
  ])));
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
    if (!box) return;
    box.setAttribute('data-state', state);
    const title = document.createElementNS(SVG, 'title');
    title.textContent = `${label}: ${STATE_WORDS[state]}`;
    box.prepend(title);
  };
  for (const system of data.systems) mark(system.slug, displayState(system, facts.stale), system.slug);
  for (const service of data.shared.services || []) mark(service.id, serviceState(service, facts.stale), service.name);
  byId('landscape').replaceChildren(document.importNode(parsed, true));
}

const titles = (findings, slug) => el('ul', {}, findings.map((finding) => el('li', { text: withoutSlug(finding.title, slug) })));

function drawProd(system, now) {
  const rows = prodRows(system, now);
  if (!rows.length) return el('p', { class: 'sub', text: 'Nothing read in production.' });
  return el('ul', { class: 'prod' }, rows.map((row) => el('li', { class: row.failed ? 'failed' : '' }, [
    el('span', { class: 'what', text: row.project }),
    row.url ? el('a', { class: 'num', href: row.url, text: row.release }) : el('span', { class: 'num', text: row.release }),
    el('span', { class: 'age', text: row.when }),
  ])));
}

function drawReleases(system) {
  const grid = releaseGrid(system);
  if (!grid.rows.length) return null;
  const table = el('table', {}, [el('tr', {}, [el('th', { text: 'Project' }), ...grid.names.map((name) => el('th', { text: name }))])]);
  for (const row of grid.rows) {
    table.append(el('tr', {}, [el('td', { text: row.project }), ...row.cells.map((cell) => el('td', {
      class: `rel ${cell.kind}`, title: cell.finished ? `finished ${cell.finished} UTC` : '',
    }, cell.url ? [el('a', { href: cell.url, text: cell.text })] : [cell.text]))]));
  }
  return el('div', { class: 'grid-wrap' }, [table]);
}

function drawLinks(system) {
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
    ]),
  ];
}

// What a system never had, what is only observed and what it declares as intended: counted in the summary, read on
// demand. Colour and the tile's face are for what has stopped working.
function drawMore(system) {
  const count = counts(system);
  const gaps = asked(system).filter((finding) => finding.class === 'gap');
  const summary = [
    count.gap ? plural(count.gap, 'gap', 'gaps') : '',
    count.observed ? `${count.observed} observed` : '',
    system.variances.length ? plural(system.variances.length, 'variance', 'variances') : '',
    'releases, cost, links',
  ].filter(Boolean).join(' · ');
  const more = el('details', {}, [el('summary', { text: summary }), drawReleases(system)]);
  if (gaps.length) more.append(el('h4', { text: 'Gaps: what it never had' }), titles(gaps, system.slug));
  if (count.observed) more.append(el('h4', { text: 'Observed, nothing asked' }), titles(observed(system), system.slug));
  if (system.variances.length) {
    more.append(el('h4', { text: 'Intended variances' }), el('ul', {}, system.variances.map((variance) => el('li', {}, [variance.variance, el('span', { text: ` ${variance.reason}` })]))));
  }
  more.append(...drawLinks(system));
  return more;
}

function drawTile(system, facts, now) {
  const state = displayState(system, facts.stale);
  const tile = el('article', { class: 'tile', 'data-state': state, 'data-system': system.slug });
  tile.append(el('header', {}, [
    systemLink(system) ? el('h3', {}, [el('a', { href: systemLink(system), text: system.slug })]) : el('h3', { text: system.slug }),
    el('span', { class: `pill ${state}`, text: STATE_WORDS[state] }),
  ]));
  tile.append(el('p', { class: 'sub', text: system.name }), drawProd(system, now));
  const broken = asked(system).filter((finding) => finding.class !== 'gap');
  if (broken.length) {
    tile.append(el('ul', { class: 'asks' }, broken.map((finding) => el('li', { class: finding.class === 'critical' ? 'critical' : '', text: withoutSlug(finding.title, system.slug) }))));
  }
  if (system.health) tile.append(el('p', { class: 'health', 'data-health': system.health, text: 'health: not probed yet' }));
  tile.append(drawMore(system));
  return tile;
}

function drawShared(data, facts) {
  byId('services').replaceChildren(...(data.shared.services || []).map((service) => {
    const state = serviceState(service, facts.stale);
    return el('div', { class: 'service', 'data-state': state, 'data-service': service.id }, [
      el('b', { text: service.name }), el('span', { class: `pill ${state}`, text: STATE_WORDS[state] }),
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
async function probe(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    return { ok: response.ok, status: response.status };
  } catch {
    try {
      await fetch(url, { cache: 'no-store', mode: 'no-cors' });
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

function draw(now) {
  if (!last) return;
  const facts = fleetFacts(last.data, now);
  drawFacts(last.data, facts);
  if (last.svg) drawLandscape(last.svg, last.data, facts);
  byId('tiles').replaceChildren(...last.data.systems.map((system) => drawTile(system, facts, now)));
  drawShared(last.data, facts);
  drawFoot(last.data, config);
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
  await probeAll();
}

load();
setInterval(load, RELOAD_MINUTES * 60000);
