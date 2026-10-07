import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_AFTER_HOURS, ageHours, asked, counts, deploymentWord, displayState, fleetFacts, formatAge, healthWord, isStale,
  limitShare, limitsInUse, observed, parseUtc, prodEnvironments, prodRows, releaseGrid, serviceState, systemLink,
  withoutSlug,
} from '../../src/model.js';

const now = new Date('2026-10-07T12:00:00Z');

function system(overrides = {}) {
  return {
    slug: 'demo',
    name: 'A demo system',
    state: 'ok',
    environments: [{ name: 'tdd', tier: 'nonprod' }, { name: 'uat', tier: 'nonprod' }, { name: 'prod', tier: 'prod' }],
    projects: [],
    findings: [],
    variances: [],
    parts: [],
    ...overrides,
  };
}

const project = (name, releases) => ({
  name,
  environments: Object.entries(releases).map(([environment, [release, state, finished]]) => ({
    name: environment, release, state, finished, url: release ? `https://octopus.example/${name}/${environment}` : '',
  })),
});

test('a reading and a deployment time are both read as UTC', () => {
  assert.equal(parseUtc('2026-10-07T04:48:18Z').toISOString(), '2026-10-07T04:48:18.000Z');
  assert.equal(parseUtc('2026-10-07 04:28').toISOString(), '2026-10-07T04:28:00.000Z');
  assert.equal(parseUtc('2026-10-07 04:28:30').toISOString(), '2026-10-07T04:28:30.000Z');
  assert.equal(parseUtc(''), null);
  assert.equal(parseUtc('yesterday'), null);
});

test('age is counted in hours and never negative', () => {
  assert.equal(ageHours('2026-10-07T06:00:00Z', now), 6);
  assert.equal(ageHours('2026-10-07T13:00:00Z', now), 0);
  assert.equal(ageHours('', now), null);
});

test('an age is said in minutes, hours, then days', () => {
  assert.equal(formatAge(0), '1 min');
  assert.equal(formatAge(0.5), '30 min');
  assert.equal(formatAge(5.4), '5 h');
  assert.equal(formatAge(47), '47 h');
  assert.equal(formatAge(72), '3 d');
  assert.equal(formatAge(null), 'unknown');
});

test('data older than two refreshes is stale, and so is data with no time', () => {
  assert.equal(STALE_AFTER_HOURS, 12);
  assert.equal(isStale('2026-10-07T00:00:00Z', now), false);
  assert.equal(isStale('2026-10-06T23:59:00Z', now), true);
  assert.equal(isStale('', now), true);
});

test('findings are counted by class, and what is only observed is counted apart', () => {
  const one = system({ findings: [
    { key: 'deployment/demo/web/prod', class: 'critical', observed: false },
    { key: 'promotion/demo/web', class: 'broken', observed: false },
    { key: 'policy/demo/code-metrics', class: 'gap', observed: false },
    { key: 'log/demo/web/tdd', class: 'broken', observed: true },
    { key: 'templates/demo', observed: false },
  ] });
  assert.deepEqual(counts(one), { critical: 1, broken: 2, gap: 1, observed: 1 });
  assert.equal(asked(one).length, 4);
  assert.equal(observed(one).length, 1);
});

test('a class the wall does not know reads as broken', () => {
  assert.deepEqual(counts(system({ findings: [{ key: 'x', class: 'observed', observed: false }] })), { critical: 0, broken: 1, gap: 0, observed: 0 });
});

test('the state on the wall: old data is not read, and a system switched off on purpose is asleep', () => {
  assert.equal(displayState(system({ state: 'critical' }), false), 'critical');
  assert.equal(displayState(system({ state: 'attention' }), false), 'attention');
  assert.equal(displayState(system({ state: 'unknown' }), false), 'not-read');
  assert.equal(displayState(system({ state: 'ok' }), false), 'ok');
  assert.equal(displayState(system({ state: 'ok', asleep: true }), false), 'asleep');
  assert.equal(displayState(system({ state: 'attention', asleep: true }), false), 'attention');
  assert.equal(displayState(system({ state: 'critical' }), true), 'not-read');
});

test('production is every environment of tier prod', () => {
  assert.deepEqual(prodEnvironments(system()), ['prod']);
  assert.deepEqual(prodEnvironments(system({ environments: [{ name: 'Blue', tier: 'prod' }, { name: 'green', tier: 'prod' }] })), ['blue', 'green']);
});

test('what runs in production: one row per project with a release there, newest first', () => {
  const rows = prodRows(system({ projects: [
    project('system', { tdd: ['1.0.10', 'Success', '2026-10-07 04:28'], prod: ['1.0.9', 'Success', '2026-10-07 02:00'] }),
    project('web', { tdd: ['1.0.33', 'Success', '2026-10-07 03:46'], prod: ['1.0.29', 'Failed', '2026-10-07 10:00'] }),
    project('new', { tdd: ['0.1.0', 'Success', '2026-10-07 03:46'], prod: ['', '', ''] }),
  ] }), now);
  assert.deepEqual(rows.map((row) => [row.project, row.release, row.failed, row.age]), [['web', '1.0.29', true, 2], ['system', '1.0.9', false, 10]]);
  assert.equal(rows[0].url, 'https://octopus.example/web/prod');
});

test('a production deployment with no time sorts last', () => {
  const rows = prodRows(system({ projects: [
    project('a', { prod: ['1', 'Success', ''] }),
    project('b', { prod: ['2', 'Success', '2026-10-07 11:00'] }),
  ] }), now);
  assert.deepEqual(rows.map((row) => row.project), ['b', 'a']);
  assert.equal(rows[1].age, null);
});

test('the release grid says where an environment is behind the first, failed or empty', () => {
  const grid = releaseGrid(system({ projects: [
    project('web', { tdd: ['2.0', 'Success', 'x'], uat: ['1.9', 'Success', 'x'], prod: ['1.9', 'Canceled', 'x'] }),
    project('api', { tdd: ['3.1', 'Success', 'x'], uat: ['3.1', 'Success', 'x'] }),
    project('never', { tdd: ['', '', ''] }),
  ] }));
  assert.deepEqual(grid.names, ['tdd', 'uat', 'prod']);
  assert.deepEqual(grid.rows.map((row) => row.project), ['web', 'api']);
  assert.deepEqual(grid.rows[0].cells.map((cell) => [cell.kind, cell.text]), [['same', '2.0'], ['behind', '1.9'], ['failed', '1.9 canceled']]);
  assert.deepEqual(grid.rows[1].cells.map((cell) => cell.kind), ['same', 'same', 'none']);
});

test('the fleet in numbers', () => {
  const data = {
    generated: '2026-10-07T10:00:00Z',
    systems: [
      system({ state: 'critical', findings: [{ key: 'deployment/a/web/prod', class: 'critical', observed: false }] }),
      system({ state: 'attention', findings: [{ key: 'promotion/b/web', class: 'broken', observed: false }, { key: 'policy/b/code-metrics', class: 'gap', observed: false }] }),
      system({ state: 'unknown' }),
      system({ state: 'ok', findings: [{ key: 'policy/d/code-metrics', class: 'gap', observed: false }] }),
    ],
    shared: { cost: [{ of: 'the fleet', monthToDate: '91.07', currency: 'USD' }, { of: 'the rest of the subscription', monthToDate: '1.00', currency: 'USD' }] },
  };
  assert.deepEqual(fleetFacts(data, now), { stale: false, age: 2, systems: 4, critical: 1, attention: 1, notRead: 1, broken: 2, gaps: 2, cost: '91.07 USD' });
});

test('old data makes every system not read, and no cost reads as n/a', () => {
  const facts = fleetFacts({ generated: '2026-10-05T10:00:00Z', systems: [system({ state: 'critical' }), system()], shared: {} }, now);
  assert.equal(facts.stale, true);
  assert.equal(facts.notRead, 2);
  assert.equal(facts.critical, 0);
  assert.equal(facts.cost, 'n/a');
});

test('a shared service has the same states', () => {
  assert.equal(serviceState({ state: 'ok' }, false), 'ok');
  assert.equal(serviceState({ state: 'critical' }, false), 'critical');
  assert.equal(serviceState({ state: 'attention' }, false), 'attention');
  assert.equal(serviceState({ state: 'unknown' }, false), 'not-read');
  assert.equal(serviceState({ state: 'ok' }, true), 'not-read');
});

test('a title loses the name of the system it is shown under', () => {
  assert.equal(withoutSlug('demo: web 1.0 in prod: Failed', 'demo'), 'web 1.0 in prod: Failed');
  assert.equal(withoutSlug('other: something', 'demo'), 'other: something');
});

test('a limit is a share of what is allowed, and says when it is over', () => {
  assert.deepEqual(limitShare({ used: '3', of: '20' }), { share: 15, over: false, full: false });
  assert.deepEqual(limitShare({ used: '10', of: '10' }), { share: 100, over: false, full: true });
  assert.deepEqual(limitShare({ used: '12', of: '10' }), { share: 100, over: true, full: false });
  assert.deepEqual(limitShare({ used: 'n/a', of: '10' }), { share: 0, over: false, full: false });
  assert.deepEqual(limitShare({ used: '1', of: '0' }), { share: 0, over: false, full: false });
});

test('a health probe is said in one word', () => {
  assert.equal(healthWord(null), '');
  assert.equal(healthWord({ ok: true, status: 200 }), 'healthy');
  assert.equal(healthWord({ ok: false, status: 503 }), 'answers 503');
  assert.equal(healthWord({ opaque: true }), 'responding');
  assert.equal(healthWord({ error: true }), 'not responding');
});

test('a deployment is said by its age, or by what it is doing when it has not finished', () => {
  assert.equal(deploymentWord({ name: 'prod', state: 'Success', finished: '2026-10-07 10:00' }, now), '2 h in prod');
  assert.equal(deploymentWord({ name: 'prod', state: 'Executing', finished: '' }, now), 'executing');
  assert.equal(deploymentWord({ name: 'prod', state: 'Failed', finished: '2026-10-07 10:00' }, now), 'failed');
  assert.equal(deploymentWord({ name: 'prod', state: '', finished: '' }, now), 'no time read');
});

test('only a limit something uses gets a bar', () => {
  const limits = [{ limit: 'a', used: '0', of: '1' }, { limit: 'b', used: '2', of: '1' }, { limit: 'c', used: 'n/a', of: '1' }];
  assert.deepEqual(limitsInUse(limits), { used: [limits[1]], unused: 2 });
});

test('a system leads to its runtime view, to its dashboard when it names none, and nowhere when it has neither', () => {
  assert.equal(systemLink(system({ runtimeView: 'https://d.example/#runtime/prod', dashboard: 'https://d.example' })), 'https://d.example/#runtime/prod');
  assert.equal(systemLink(system({ runtimeView: '', dashboard: 'https://d.example' })), 'https://d.example');
  assert.equal(systemLink(system()), '');
});
