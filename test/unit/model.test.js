import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AZURE_PORTAL, azureLinks, boxLinks, boxTitle, costLine, environmentTiles, hostOf, landscape, prodLine, standardsLine, stateLine,
  FINISHED_MINUTES, STALE_AFTER_HOURS, ageHours, asked, behindReasons, counts, deploymentMarks, deploymentText, flightState, deploymentWord, displayState, findText, fleetFacts, formatAge, formatWhen,
  healthWord, isStale, limitShare, limitsInUse, matches, observed, parseUtc, prodEnvironments, prodRows, releaseGrid, releaseWord, serviceState, standing,
  standingSummary, systemDoor, systemLink, withoutSlug,
  ACTIVITY_LINES, FLEET_FRESH_MINUTES, IN_PROGRESS, activityLines, cellFlights, cellKey, cellTitle, cellWhen, fleetMarks, fleetText, flightLine, flightMarks, flightWord, formatUntil, freezeLines, instanceLine,
  lastLine, liveMarks, shortProject, tileFlights,
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
  assert.equal(displayState(system({ state: 'behind' }), false), 'behind');
  assert.equal(displayState(system({ state: 'behind', asleep: true }), false), 'behind');
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
      system({ state: 'behind', findings: [{ key: 'policy/d/code-metrics', class: 'gap', observed: false }] }),
    ],
    shared: { cost: [{ of: 'the fleet', monthToDate: '91.07', currency: 'USD' }, { of: 'the rest of the subscription', monthToDate: '1.00', currency: 'USD' }] },
  };
  assert.deepEqual(fleetFacts(data, now), { stale: false, age: 2, systems: 4, critical: 1, attention: 1, behind: 1, notRead: 1, broken: 2, gaps: 2, cost: '91.07 USD' });
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

test('where a system stands on each standard, in the words of the wall, and in one line with the worst first', () => {
  const one = system({ standards: [
    { standard: 'registry', label: 'Registry', status: 'met', text: 'system.json agrees' },
    { standard: 'templates', label: 'Kit templates', status: 'behind', text: '7 file(s) behind the kit' },
    { standard: 'code metrics', label: 'Code metrics', status: 'gap', text: 'no code metrics for ui' },
    { standard: 'proof', label: 'Proofs', status: 'none', text: 'none of the proof runbooks' },
    { standard: 'identity', label: 'GitHub identity', status: 'unchecked', text: 'not checked yet' },
    { standard: 'promotion', label: 'Promotion', status: 'met', text: 'no environment behind' },
    { standard: 'new', status: 'something-new', text: '' },
  ] });
  assert.deepEqual(standing(one).map((row) => [row.label, row.word]), [
    ['Registry', 'met'], ['Kit templates', 'behind'], ['Code metrics', 'gap'], ['Proofs', 'nothing to judge'],
    ['GitHub identity', 'not checked'], ['Promotion', 'met'], ['new', 'something-new'],
  ]);
  assert.equal(standingSummary(one), '1 gap · 1 behind · 1 nothing to judge · 1 not checked · 2 met · 1 something-new');
});

test('a system the fleet wrote before it recorded standings has none, and no reasons', () => {
  assert.deepEqual(standing(system()), []);
  assert.equal(standingSummary(system()), '');
  assert.deepEqual(behindReasons(system()), []);
  assert.deepEqual(behindReasons(system({ behind: ['Code metrics: no code metrics for ui'] })), ['Code metrics: no code metrics for ui']);
});

const flight = (state, extra = {}) => ({ project: 'web', environment: 'uat', release: '2.4.43', state, since: '2026-10-07T11:50:00Z', url: 'https://octopus.example/task', ...extra });

test('what is marked for a system: everything in flight, and what ended in the last ten minutes', () => {
  assert.equal(FINISHED_MINUTES, 10);
  const marks = deploymentMarks({ deployments: [
    flight('succeeded', { finished: '2026-10-07T11:55:00Z' }),
    flight('failed', { environment: 'prod', finished: '2026-10-07T11:30:00Z' }),
    flight('queued', { environment: 'prod' }),
    flight('executing'),
    flight('waiting', { environment: 'prod', release: '2.4.42' }),
  ] }, now);
  assert.deepEqual(marks.map((mark) => [mark.state, mark.environment, mark.ended, mark.minutes]), [
    ['waiting', 'prod', false, 10], ['executing', 'uat', false, 10], ['queued', 'prod', false, 10], ['succeeded', 'uat', true, 5],
  ]);
  assert.equal(marks[0].url, 'https://octopus.example/task');
});

test('a deployment is said in the words of someone at the wall', () => {
  const said = (state, extra = {}) => deploymentText({ project: 'web', environment: 'uat', release: '2.4.43', state, minutes: 5, ...extra });
  assert.equal(said('queued'), 'web 2.4.43 is queued for uat');
  assert.equal(said('executing'), 'deploying web 2.4.43 to uat');
  assert.equal(said('waiting'), 'web 2.4.43 waits for a sign-off in uat');
  assert.equal(said('succeeded'), 'web 2.4.43 reached uat 5 min ago');
  assert.equal(said('failed'), 'web 2.4.43 failed in uat 5 min ago');
  assert.equal(said('canceled', { minutes: null }), 'web 2.4.43 was canceled in uat');
  assert.equal(said('paused'), 'web 2.4.43 in uat: paused');
});

test('the word a box carries: what is in flight wins over what ended, and nothing is nothing', () => {
  assert.equal(flightState(deploymentMarks({ deployments: [flight('succeeded', { finished: '2026-10-07T11:58:00Z' }), flight('queued')] }, now)), 'queued');
  assert.equal(flightState(deploymentMarks({ deployments: [flight('failed', { finished: '2026-10-07T11:58:00Z' })] }, now)), 'finished');
  assert.equal(flightState(deploymentMarks({ deployments: [] }, now)), '');
  assert.deepEqual(deploymentMarks(undefined, now), []);
  assert.deepEqual(deploymentMarks({ deployments: 'none' }, now), []);
  assert.deepEqual(deploymentMarks({ deployments: [flight('succeeded', { finished: 'not a time' })] }, now), []);
});

test('when a deployment finished is written as Octopus writes it, in the zone asked for', () => {
  assert.equal(formatWhen('2026-10-08 13:18', 'UTC'), 'Oct 8, 2026 1:18 PM');
  assert.equal(formatWhen('2026-10-08 13:18', 'America/Chicago'), 'Oct 8, 2026 8:18 AM');
  assert.equal(formatWhen('2026-10-08T00:05:09Z', 'UTC'), 'Oct 8, 2026 12:05 AM');
  assert.equal(formatWhen('2026-10-08 03:00', 'America/Chicago'), 'Oct 7, 2026 10:00 PM');
  assert.match(formatWhen('2026-10-08 13:18'), /^Oct [789], 2026 \d{1,2}:\d{2} [AP]M$/);
  assert.equal(formatWhen(''), '');
  assert.equal(formatWhen('yesterday'), '');
});

test('a cell of the release grid has words for a reader who does not see its tile', () => {
  const grid = releaseGrid(system({ projects: [
    project('web', { tdd: ['2.0', 'Success', 'x'], uat: ['1.9', 'Success', 'x'], prod: ['1.9', 'Failed', 'x'] }),
    project('api', { tdd: ['3.1', 'Success', 'x'] }),
  ] }));
  assert.deepEqual(grid.rows[0].cells.map((cell) => releaseWord(cell, grid.names[0])), ['deployed', 'deployed, behind tdd', 'failed']);
  assert.deepEqual(grid.rows[1].cells.map((cell) => releaseWord(cell, grid.names[0])), ['deployed', 'not deployed', 'not deployed']);
});

test('a system is found by its name, what it is, its owner or a project, whatever the case', () => {
  const one = system({ owner: 'Platform Hub', projects: [project('demo-web', { tdd: ['1.0', 'Success', 'x'] }), project('demo-api', {})] });
  assert.equal(findText(one), 'demo a demo system platform hub demo-web demo-api');
  assert.equal(findText(system()), 'demo a demo system');
  for (const typed of ['', '   ', undefined, 'DEMO', 'a demo', ' hub ', 'demo-API']) assert.equal(matches(one, typed), true, String(typed));
  for (const typed of ['prod', 'demo-ui', 'x']) assert.equal(matches(one, typed), false, typed);
});

test('every box of the landscape that is not a system leads to what it stands for', () => {
  const fleet = { repository: 'acme/kit', octopus: 'https://acme.octopus.app', policies: 'acme/policies' };
  assert.deepEqual(boxLinks({ fleet }), {
    operators: 'https://github.com/acme/kit/issues?q=is%3Aissue+state%3Aopen+label%3Afleet-finding',
    fleet: 'https://github.com/acme/kit/tree/main/fleet',
    octopus: 'https://acme.octopus.app',
    kit: 'https://github.com/acme/kit/tree/green',
    policies: 'https://github.com/acme/policies',
    subscription: AZURE_PORTAL,
  });
  assert.equal(boxLinks({ fleet: { ...fleet, azurePortal: 'https://portal.azure.com/#@acme/resource/subscriptions/1' } }).subscription, 'https://portal.azure.com/#@acme/resource/subscriptions/1');
  assert.deepEqual(boxLinks({ fleet: {} }), { subscription: AZURE_PORTAL });
  assert.deepEqual(boxLinks({}), { subscription: AZURE_PORTAL });
  assert.equal(hostOf('https://github.com/acme/kit/tree/green'), 'github.com');
  assert.equal(hostOf(AZURE_PORTAL), 'portal.azure.com');
  assert.equal(hostOf('not an address'), '');
});

test('a system with nothing to zoom into leads to its space in Octopus, then to its repository', () => {
  assert.equal(systemDoor(system({ space: { url: 'https://acme.octopus.app/app#/Spaces-1' }, repositoryUrl: 'https://github.com/acme/demo-system' })), 'https://acme.octopus.app/app#/Spaces-1');
  assert.equal(systemDoor(system({ space: { url: '' }, repositoryUrl: 'https://github.com/acme/demo-system' })), 'https://github.com/acme/demo-system');
  assert.equal(systemDoor(system()), '');
});

test('a system leads to each of its resource groups in the portal, or to the subscription when none is named', () => {
  const fleet = { azurePortal: 'https://portal.azure.com/#resource/subscriptions/1/resourceGroups' };
  const groups = [
    { group: 'rg-demo-nonprod', url: 'https://portal.azure.com/#resource/subscriptions/1/resourceGroups/rg-demo-nonprod/overview' },
    { group: 'rg-demo-prod', url: 'https://portal.azure.com/#resource/subscriptions/1/resourceGroups/rg-demo-prod/overview' },
  ];
  assert.deepEqual(azureLinks(system({ azure: groups }), fleet), [
    { text: 'Azure: rg-demo-nonprod', url: groups[0].url }, { text: 'Azure: rg-demo-prod', url: groups[1].url },
  ]);
  assert.deepEqual(azureLinks(system({ azure: [] }), fleet), [{ text: 'Azure subscription', url: fleet.azurePortal }]);
  assert.deepEqual(azureLinks(system(), fleet), [{ text: 'Azure subscription', url: fleet.azurePortal }]);
  assert.deepEqual(azureLinks(system({ azure: [{ group: 'rg-demo-prod', url: '' }] }), fleet), [{ text: 'Azure subscription', url: fleet.azurePortal }]);
  assert.deepEqual(azureLinks(system(), {}), []);
  assert.deepEqual(azureLinks(system(), undefined), []);
});

test('the landscape is who watches, the oversight, every system in the subscription and what they share', () => {
  const data = {
    fleet: { name: 'Acme systems', repository: 'acme/kit', octopus: 'https://acme.octopus.app', policies: 'acme/policies' },
    systems: [
      system({ slug: 'one', name: 'System one', state: 'attention', kitBuilt: true, runtimeView: 'https://one.example/#runtime/prod', dashboard: 'https://one.example/' }),
      system({ slug: 'two', name: 'System two', state: 'ok', kitBuilt: false, space: { url: 'https://acme.octopus.app/app#/Spaces-2' } }),
      system({ slug: 'three', state: 'behind', kitBuilt: true, asleep: true }),
    ],
    shared: { services: [{ id: 'octopus', name: 'Octopus Deploy', state: 'ok', detail: '4 of 20 tasks' }, { id: 'kit', name: 'Delivery standard', state: 'attention' }] },
  };
  const scape = landscape(data, false, now);
  const shape = ({ name, title, text, state, zoom, open, pulls }) => ({ name, title, text, state, zoom, open, pulls });
  assert.deepEqual(scape.systems.map(shape), [
    { name: 'one', title: 'one', text: 'System one', state: 'attention', zoom: 'https://one.example/#runtime/prod', open: '', pulls: true },
    { name: 'two', title: 'two', text: 'System two', state: 'ok', zoom: '', open: 'https://acme.octopus.app/app#/Spaces-2', pulls: false },
    { name: 'three', title: 'three', text: 'A demo system', state: 'behind', zoom: '', open: '', pulls: true },
  ]);
  assert.equal(scape.pulling, 2);
  assert.deepEqual(scape.services, [
    { name: 'octopus', title: 'Octopus Deploy', text: '4 of 20 tasks', state: 'ok', zoom: '', open: 'https://acme.octopus.app' },
    { name: 'kit', title: 'Delivery standard', text: '', state: 'attention', zoom: '', open: 'https://github.com/acme/kit/tree/green' },
  ]);
  assert.equal(scape.fleet.title, 'Acme systems');
  assert.equal(scape.fleet.open, 'https://github.com/acme/kit/tree/main/fleet');
  assert.match(scape.operators.open, /label%3Afleet-finding$/);
  assert.equal(scape.subscription.open, AZURE_PORTAL);
  // Old data is not read, whatever it said.
  assert.deepEqual(landscape(data, true, now).systems.map((one) => one.state), ['not-read', 'not-read', 'not-read']);
  assert.deepEqual(landscape(data, true, now).services.map((one) => one.state), ['not-read', 'not-read']);
  // Data with nothing in it still draws the frame.
  const bare = landscape({ systems: [] }, false, now);
  assert.deepEqual([bare.systems.length, bare.services.length, bare.pulling, bare.fleet.title, bare.fleet.open], [0, 0, 0, 'The fleet', '']);

  assert.equal(boxTitle(scape.systems[0]), 'one: Needs attention. Zooms into its dashboard');
  assert.equal(boxTitle(scape.systems[1]), 'two: As declared. Opens acme.octopus.app in a new tab');
  assert.equal(boxTitle(scape.systems[2]), 'three: Behind the standard');
  assert.equal(boxTitle(scape.operators), 'Operators. Opens github.com in a new tab');
  assert.equal(boxTitle({ title: 'Nothing' }), 'Nothing');
});

test('a system\'s box says where it stands in each environment: the worst of its projects there', () => {
  const one = system({ projects: [
    project('web', { tdd: ['2.0', 'Success', '2026-10-07 10:00'], uat: ['1.9', 'Success', '2026-10-06 10:00'], prod: ['1.9', 'Success', '2026-10-06 11:00'] }),
    project('api', { tdd: ['3.1', 'Success', '2026-10-07 09:00'], uat: ['3.1', 'Success', '2026-10-07 09:30'], prod: ['3.1', 'Failed', '2026-10-07 09:45'] }),
    project('never', { tdd: ['', '', ''] }),
  ] });
  assert.deepEqual(environmentTiles(one), [
    { name: 'tdd', kind: 'same', word: 'tdd: deployed' },
    { name: 'uat', kind: 'behind', word: 'uat: deployed, behind tdd' },
    { name: 'prod', kind: 'failed', word: 'prod: failed' },
  ]);
  assert.deepEqual(environmentTiles(system()).map((tile) => tile.kind), ['none', 'none', 'none']);
  assert.deepEqual(environmentTiles(system({ projects: [project('web', { tdd: ['2.0', 'Success', 'x'] })] })).map((tile) => tile.word), ['tdd: deployed', 'uat: not deployed', 'prod: not deployed']);
});

test('and what production runs: its newest deployment, or the one that failed', () => {
  const healthy = system({ projects: [
    project('web', { prod: ['1.9', 'Success', '2026-10-07 09:00'] }),
    project('api', { prod: ['3.1', 'Success', '2026-10-07 11:30'] }),
  ] });
  assert.equal(prodLine(healthy, now), 'prod 3.1 · 30 min');
  const failed = system({ projects: [
    project('web', { prod: ['1.9', 'Success', '2026-10-07 11:30'] }),
    project('api', { prod: ['3.1', 'TimedOut', '2026-10-07 09:00'] }),
  ] });
  assert.equal(prodLine(failed, now), 'prod 3.1 timedout');
  assert.equal(prodLine(system({ projects: [project('web', { prod: ['1.9', 'Success', 'not a time'] })] }), now), 'prod 1.9');
  assert.equal(prodLine(system({ projects: [project('web', { tdd: ['2.0', 'Success', 'x'] })] }), now), '');
  assert.equal(prodLine(system(), now), '');
});

test('and its state in words with a count, its standards and its cost; nothing where the fleet read nothing', () => {
  assert.equal(stateLine(system(), false), '');
  assert.equal(stateLine(system({ state: 'behind', behind: ['GitHub identity: a user\'s token', 'Private build: not yet'] }), false), 'Behind the standard: 2 standards');
  assert.equal(stateLine(system({ state: 'behind', behind: ['one'] }), false), 'Behind the standard: 1 standard');
  assert.equal(stateLine(system({ state: 'behind' }), false), 'Behind the standard');
  assert.equal(stateLine(system({ state: 'attention', findings: [{ key: 'a', class: 'broken' }, { key: 'b', class: 'gap' }, { key: 'c' }] }), false), 'Needs attention: 2 broken');
  assert.equal(stateLine(system({ state: 'attention' }), false), 'Needs attention');
  assert.equal(stateLine(system({ state: 'critical', findings: [{ key: 'a', class: 'critical' }] }), false), 'Production affected');
  assert.equal(stateLine(system({ asleep: true }), false), 'Asleep');
  assert.equal(stateLine(system(), true), 'Not read');

  assert.equal(standardsLine(system({ standards: [{ standard: 'tests', status: 'met' }, { standard: 'build', status: 'behind' }, { standard: 'idle', status: 'met' }] })), '2 of 3 standards');
  assert.equal(standardsLine(system()), '');
  assert.equal(costLine(system({ cost: { monthToDate: '12.40', currency: 'USD' } })), '12.40 USD');
  assert.equal(costLine(system()), '');

  const scape = landscape({ systems: [
    system({ slug: 'one', madeOf: 'Container Apps', health: 'https://one.example/health', cost: { monthToDate: '1.74', currency: 'USD' }, standards: [{ standard: 'tests', status: 'met' }] }),
    system({ slug: 'two', health: 'https://two.example/health', asleep: true }),
    system({ slug: 'three' }),
  ] }, false, now);
  assert.deepEqual(scape.systems.map((one) => [one.madeOf, one.small, one.health, one.runs, one.says]), [
    ['Container Apps', '1 of 1 standards · 1.74 USD', true, '', ''],
    ['', '', false, '', 'Asleep'],
    ['', '', false, '', ''],
  ]);
});

// Activity. The fleet read at 11:50, ten minutes before "now"; a later reading is made by moving "now".
const READ = '2026-10-07T11:50:00Z';
const flying = (state, environment, extra = {}) => ({
  project: 'demo-ui', release: '2.4.76', environment, state, since: '2026-10-07T11:40:00Z', startedBy: 'demo-github', url: `https://octopus.example/tasks/${state}`, ...extra,
});
const signOff = { kind: 'sign-off', title: 'Sign-off', since: '2026-10-07T11:48:00Z', responsible: 'demo approvers' };
const ended = (result, environment, finished, extra = {}) => ({ project: 'demo-ui', release: '2.4.75', environment, result, finished, startedBy: 'pat', url: '', ...extra });
const acting = (activity) => system({ activity: { read: READ, inFlight: [], recent: [], freezes: [], missing: [], ...activity } });

test('a release whose deployment had not ended when the fleet read it says so, in the grid, on its tile and for production', () => {
  const one = system({ projects: [{ name: 'web', environments: [
    { name: 'tdd', release: '2.1', state: 'Executing', finished: '', inProgress: true, started: '2026-10-07 11:40', url: 'https://octopus.example/t' },
    { name: 'uat', release: '2.0', state: 'Success', finished: '2026-10-07 09:00', url: '' },
    { name: 'prod', release: '2.1', state: 'Queued', finished: '', inProgress: true, url: '' },
  ] }] });
  const cells = releaseGrid(one).rows[0].cells;
  assert.deepEqual(cells[0], { name: 'tdd', kind: 'progress', text: '2.1', url: 'https://octopus.example/t', finished: '', started: '2026-10-07 11:40' });
  assert.deepEqual(cells[1], { name: 'uat', kind: 'behind', text: '2.0', url: '', finished: '2026-10-07 09:00' });
  assert.equal(releaseWord(cells[0], 'tdd'), IN_PROGRESS);
  assert.equal(cellWhen(cells[0], 'UTC'), 'in progress when read');
  assert.equal(cellWhen(cells[1], 'UTC'), 'Oct 7, 2026 9:00 AM');
  assert.equal(cellWhen({ kind: 'same', finished: '' }, 'UTC'), '');
  assert.equal(cellTitle(cells[0]), 'started 2026-10-07 11:40 UTC, not finished when the fleet read it');
  assert.equal(cellTitle(cells[2]), 'not finished when the fleet read it');
  assert.equal(cellTitle(cells[1]), 'finished 2026-10-07 09:00 UTC');
  assert.equal(cellTitle({ kind: 'none', finished: '' }), '');
  assert.deepEqual(environmentTiles(one), [
    { name: 'tdd', kind: 'progress', word: 'tdd: in progress when read' },
    { name: 'uat', kind: 'behind', word: 'uat: deployed, behind tdd' },
    { name: 'prod', kind: 'progress', word: 'prod: in progress when read' },
  ]);
  assert.equal(prodLine(one, now), 'prod 2.1 · in progress when read');
  // A failure is still a failure, whatever else the data says.
  const failed = system({ projects: [{ name: 'web', environments: [{ name: 'prod', release: '2.1', state: 'Failed', finished: '', inProgress: true, url: '' }] }] });
  assert.equal(releaseGrid(failed).rows[0].cells[2].kind, 'failed');
  assert.equal(prodLine(failed, now), 'prod 2.1 failed');
});

test('a project is named without its system on the system\'s own box', () => {
  assert.equal(shortProject('demo-ui', 'demo'), 'ui');
  assert.equal(shortProject('workorders', 'demo'), 'workorders');
  assert.equal(shortProject('demo-', 'demo'), 'demo-');
  assert.equal(shortProject('', 'demo'), '');
  assert.equal(shortProject('ui', ''), 'ui');
});

test('what the fleet read as in flight is marked like a system\'s own file: the one a person holds first', () => {
  const marks = fleetMarks(acting({ inFlight: [flying('queued', 'tdd'), flying('executing', 'uat'), flying('waiting', 'prod', { waitsFor: signOff })] }), now);
  assert.deepEqual(marks.map((mark) => [mark.state, mark.environment, mark.minutes, mark.past, mark.read, mark.source]), [
    ['waiting', 'prod', 12, false, 10, 'fleet'], ['executing', 'uat', 20, false, 10, 'fleet'], ['queued', 'tdd', 20, false, 10, 'fleet'],
  ]);
  assert.deepEqual(marks.map((mark) => mark.text), ['demo-ui 2.4.76 waits for a sign-off in prod', 'deploying demo-ui 2.4.76 to uat', 'demo-ui 2.4.76 is queued for tdd']);
  assert.deepEqual([marks[0].waitsFor, marks[0].responsible, marks[0].startedBy, marks[0].url, marks[0].ended], ['sign-off', 'demo approvers', 'demo-github', 'https://octopus.example/tasks/waiting', false]);
  assert.deepEqual([marks[1].waitsFor, marks[1].responsible], ['', '']);
  // A wait with nothing said about it counts from when the deployment started; a time that is none gives no age.
  assert.equal(fleetMarks(acting({ inFlight: [flying('waiting', 'prod')] }), now)[0].minutes, 20);
  assert.deepEqual(fleetMarks(acting({ inFlight: [{ project: 'demo-ui', release: '1', environment: 'tdd', state: 'executing', since: '' }] }), now).map((mark) => [mark.minutes, mark.url, mark.startedBy]), [[null, '', '']]);
  assert.deepEqual(fleetMarks(system(), now), []);
  assert.deepEqual(fleetMarks(system({ activity: null }), now), []);
  assert.deepEqual(fleetMarks(system({ activity: { read: READ } }), now), []);
});

test('a reading of the fleet older than half an hour is said in the past tense, with its age', () => {
  const later = new Date('2026-10-07T14:50:00Z');
  const one = acting({ inFlight: [flying('executing', 'uat'), flying('queued', 'tdd'), flying('waiting', 'prod', { waitsFor: signOff }), flying('waiting', 'prod', { release: '9', waitsFor: { kind: 'guided failure' } })] });
  assert.equal(FLEET_FRESH_MINUTES, 30);
  assert.deepEqual(fleetMarks(one, new Date('2026-10-07T12:20:00Z')).map((mark) => mark.past), [false, false, false, false]);
  const marks = fleetMarks(one, later);
  assert.deepEqual(marks.map((mark) => mark.past), [true, true, true, true]);
  assert.deepEqual(marks.map((mark) => mark.text), [
    'demo-ui 2.4.76 waited for a sign-off in prod when the fleet read it 3 h ago', 'demo-ui 9 waited for a person in prod when the fleet read it 3 h ago',
    'demo-ui 2.4.76 was deploying to uat when the fleet read it 3 h ago', 'demo-ui 2.4.76 was queued for tdd when the fleet read it 3 h ago',
  ]);
  assert.equal(fleetMarks(one, now)[1].text, 'demo-ui 9 waits for a person in prod');
  // A reading with no time is not of now either.
  const undated = fleetMarks(system({ activity: { inFlight: [flying('executing', 'uat')] } }), now);
  assert.deepEqual([undated[0].past, undated[0].read, undated[0].text], [true, null, 'demo-ui 2.4.76 was deploying to uat when the fleet read it']);
  assert.equal(fleetText({ project: 'a', release: '1', environment: 'tdd', state: 'executing', past: false, minutes: 1 }), 'deploying a 1 to tdd');
});

test('the system\'s own file wins over the fleet\'s reading; the fleet\'s is used where a system publishes none', () => {
  const one = acting({ inFlight: [flying('executing', 'uat')] });
  const file = { deployments: [{ project: 'demo-ui', environment: 'prod', release: '2.4.76', state: 'waiting', since: '2026-10-07T11:55:00Z', url: 'https://octopus.example/x' }] };
  assert.deepEqual(flightMarks(one, file, now, false).map((mark) => [mark.source, mark.state, mark.environment]), [['system', 'waiting', 'prod']]);
  // A file that says nothing is in flight says so: what the fleet read earlier is not shown against it.
  assert.deepEqual(flightMarks(one, { deployments: [] }, now, false), []);
  assert.deepEqual(flightMarks(one, undefined, now, false).map((mark) => [mark.source, mark.state, mark.environment]), [['fleet', 'executing', 'uat']]);
  // Old data of the fleet is not a reading: nothing is claimed from it. The system's own file still is.
  assert.deepEqual(flightMarks(one, undefined, now, true), []);
  assert.equal(flightMarks(one, file, now, true).length, 1);
  const marks = [{ state: 'executing', ended: false }, { state: 'succeeded', ended: true }, { state: 'waiting', ended: false, past: true }];
  assert.deepEqual(liveMarks(marks), [{ state: 'executing', ended: false }]);
});

test('a deployment in flight as a line of the box: who waits where, what is deploying, what is queued', () => {
  const marks = fleetMarks(acting({ inFlight: [
    flying('waiting', 'prod', { waitsFor: signOff }), flying('executing', 'uat'), flying('queued', 'tdd'), flying('waiting', 'uat', { waitsFor: { kind: 'guided failure', since: '' } }),
  ] }), now);
  const lines = marks.map((mark) => flightLine(mark, 'demo'));
  assert.deepEqual(lines.map((line) => [line.kind, line.text]), [
    ['waiting', 'prod waits for a sign-off, 12 min'], ['waiting', 'uat waits for a person'], ['deploying', 'deploying ui 2.4.76 to uat'], ['queued', 'ui 2.4.76 queued for tdd'],
  ]);
  assert.equal(lines[0].title, 'demo-ui 2.4.76 waits for a sign-off in prod; responsible: demo approvers; started by demo-github (the fleet\'s reading of Octopus)');
  assert.equal(lines[0].source, 'fleet');
  // From the system's own file: the same words, and the title says where it is from. A state the page does not know is said as it is.
  const own = flightMarks(system(), { deployments: [
    { project: 'demo-ui', environment: 'prod', release: '2.4.76', state: 'waiting', since: '2026-10-07T11:55:00Z' },
    { project: 'demo-ui', environment: 'uat', release: '2.4.76', state: 'paused', since: '2026-10-07T11:55:00Z' },
  ] }, now, false).map((mark) => flightLine(mark, 'demo'));
  assert.deepEqual(own.map((line) => [line.kind, line.text, line.source]), [['waiting', 'prod waits for a sign-off, 5 min', 'system'], ['queued', 'ui 2.4.76 in uat: paused', 'system']]);
  assert.equal(own[0].title, 'demo-ui 2.4.76 waits for a sign-off in prod (the system\'s own deployments.json)');
  assert.equal(flightLine({ project: 'a', release: '1', environment: 'tdd', state: 'executing', source: 'other', text: 'deploying a 1 to tdd' }, 'demo').title, 'deploying a 1 to tdd (other)');
  // An old reading of the fleet, in the past tense.
  const old = fleetMarks(acting({ inFlight: [flying('waiting', 'prod', { waitsFor: signOff }), flying('executing', 'uat'), flying('queued', 'tdd')] }), new Date('2026-10-07T14:50:00Z')).map((mark) => flightLine(mark, 'demo'));
  assert.deepEqual(old.map((line) => [line.kind, line.text]), [
    ['earlier', 'prod waited for a sign-off when read 3 h ago'], ['earlier', 'was deploying ui 2.4.76 to uat when read 3 h ago'], ['earlier', 'ui 2.4.76 was queued for tdd when read 3 h ago'],
  ]);
  assert.equal(flightLine(fleetMarks(system({ activity: { inFlight: [flying('executing', 'uat')] } }), now)[0], 'demo').text, 'was deploying ui 2.4.76 to uat when read');
});

test('the time of a freeze is short and in UTC: the day of the week, or the date when that would not say which', () => {
  assert.equal(formatUntil('2026-10-12T00:00:00Z', now), 'Mon 00:00 UTC');
  assert.equal(formatUntil('2026-10-10T19:30:00Z', now), 'Sat 19:30 UTC');
  assert.equal(formatUntil('2026-10-20T06:05:00Z', now), 'Oct 20 06:05 UTC');
  assert.equal(formatUntil('', now), '');
});

test('a freeze is said while it is in force and before it begins, once for freezes that say the same', () => {
  const one = acting({ freezes: [
    { name: 'weekend ui', from: '2026-10-10T00:00:00Z', to: '2026-10-12T00:00:00Z', active: false, environments: ['prod'], projects: ['demo-ui'] },
    { name: 'weekend api', from: '2026-10-10T00:00:00Z', to: '2026-10-12T00:00:00Z', active: false, environments: ['prod'], projects: ['demo-api'] },
    { name: 'audit', from: '2026-10-06T00:00:00Z', to: '2026-10-08T00:00:00Z', active: true, environments: ['tdd', 'uat'], projects: [] },
    { name: 'over', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', active: false, environments: ['prod'], projects: ['demo-ui'] },
    { name: 'undated', from: '', to: '', environments: ['prod'] },
    { name: 'everything', from: '2026-10-08T00:00:00Z', to: '2026-10-09T00:00:00Z' },
  ] });
  assert.deepEqual(freezeLines(one, now), [
    { kind: 'freeze', text: 'tdd, uat frozen until Thu 00:00 UTC', title: 'Deployment freeze "audit": 2026-10-06T00:00:00Z to 2026-10-08T00:00:00Z (the fleet\'s reading of Octopus)', source: 'fleet' },
    { kind: 'freeze', text: 'deployments freezes Thu 00:00 UTC', title: 'Deployment freeze "everything": 2026-10-08T00:00:00Z to 2026-10-09T00:00:00Z (the fleet\'s reading of Octopus)', source: 'fleet' },
    { kind: 'freeze', text: 'prod freezes Sat 00:00 UTC', title: 'Deployment freeze "weekend ui" (demo-ui), "weekend api" (demo-api): 2026-10-10T00:00:00Z to 2026-10-12T00:00:00Z (the fleet\'s reading of Octopus)', source: 'fleet' },
  ]);
  // The page decides by its own clock, not by what was true when the fleet read: a freeze that has begun since is in force.
  assert.deepEqual(freezeLines(one, new Date('2026-10-10T08:00:00Z')).map((line) => line.text), ['prod frozen until Mon 00:00 UTC']);
  assert.deepEqual(freezeLines(system(), now), []);
});

test('the last thing that happened: the newest of what the system\'s file says ended and of what the fleet read', () => {
  const one = acting({ recent: [ended('succeeded', 'prod', '2026-10-07T11:40:00Z'), ended('failed', 'tdd', '2026-10-07T09:00:00Z')] });
  assert.deepEqual(lastLine(one, [], now, false), {
    kind: 'last', text: 'last: ui 2.4.75 to prod, 20 min ago', title: 'demo-ui 2.4.75 to prod, 20 min ago; started by pat (the fleet\'s reading of Octopus)', source: 'fleet',
  });
  const file = { deployments: [{ project: 'demo-ui', environment: 'uat', release: '2.4.76', state: 'failed', since: '2026-10-07T11:50:00Z', finished: '2026-10-07T11:55:00Z' }] };
  assert.deepEqual(lastLine(one, flightMarks(one, file, now, false), now, false), {
    kind: 'last failed', text: 'last: ui 2.4.76 failed in uat, 5 min ago', title: 'demo-ui 2.4.76 failed in uat, 5 min ago (the system\'s own deployments.json)', source: 'system',
  });
  // What the fleet read is newer than what the system's file still holds: then that is the last.
  const newer = acting({ recent: [ended('canceled', 'prod', '2026-10-07T11:58:00Z', { startedBy: '' })] });
  assert.deepEqual([lastLine(newer, flightMarks(newer, file, now, false), now, false).text, lastLine(newer, [], now, false).title], [
    'last: ui 2.4.75 canceled in prod, 2 min ago', 'demo-ui 2.4.75 canceled in prod, 2 min ago (the fleet\'s reading of Octopus)',
  ]);
  // Old data of the fleet says nothing; the system's own file still does. Nothing read is no line.
  assert.equal(lastLine(one, [], now, true), null);
  assert.equal(lastLine(one, flightMarks(one, file, now, true), now, true).source, 'system');
  assert.equal(lastLine(system(), [], now, false), null);
  assert.equal(lastLine(acting({ recent: [ended('succeeded', 'prod', '')] }), [], now, false), null);
  assert.equal(lastLine(system(), [{ project: 'demo-ui', release: '1', environment: 'tdd', state: 'succeeded', ended: true, minutes: 3 }], now, false).source, 'system');
});

test('a box says at most two things about its activity, the most urgent first, and nothing where nothing was read', () => {
  const freezes = [{ name: 'weekend', from: '2026-10-06T00:00:00Z', to: '2026-10-12T00:00:00Z', environments: ['prod'], projects: [] }];
  const recent = [ended('succeeded', 'prod', '2026-10-07T11:40:00Z')];
  const said = (one, file, at = now, stale = false) => activityLines(one, flightMarks(one, file, at, stale), at, stale);
  assert.equal(ACTIVITY_LINES, 2);
  // Everything at once: a person first, then what is deploying; the queue, the freeze and the rest are counted.
  const busy = acting({ freezes, recent, inFlight: [flying('queued', 'tdd'), flying('executing', 'uat'), flying('waiting', 'prod', { waitsFor: signOff })] });
  assert.deepEqual([said(busy).lines.map((line) => line.text), said(busy).more], [['prod waits for a sign-off, 12 min', 'deploying ui 2.4.76 to uat'], 2]);
  // Something deploying and a freeze: the freeze second, and no "last" while something is in flight.
  const deploying = acting({ freezes, recent, inFlight: [flying('executing', 'uat')] });
  assert.deepEqual([said(deploying).lines.map((line) => [line.kind, line.text]), said(deploying).more], [[['deploying', 'deploying ui 2.4.76 to uat'], ['freeze', 'prod frozen until Mon 00:00 UTC']], 0]);
  // Nothing in flight: the freeze, then the last thing that happened.
  assert.deepEqual(said(acting({ freezes, recent })).lines.map((line) => line.text), ['prod frozen until Mon 00:00 UTC', 'last: ui 2.4.75 to prod, 20 min ago']);
  assert.deepEqual(said(acting({ recent })).lines.map((line) => line.text), ['last: ui 2.4.75 to prod, 20 min ago']);
  // What the fleet read too long ago comes after a freeze, in the past tense, and there is no "last" beside it.
  const later = new Date('2026-10-07T14:50:00Z');
  assert.deepEqual(said(deploying, undefined, later).lines.map((line) => [line.kind, line.text]), [['freeze', 'prod frozen until Mon 00:00 UTC'], ['earlier', 'was deploying ui 2.4.76 to uat when read 3 h ago']]);
  // The system's own file wins: what it says is in flight, and not what the fleet read; the freeze is the fleet's.
  const file = { deployments: [{ project: 'demo-ui', environment: 'tdd', release: '2.4.77', state: 'executing', since: '2026-10-07T11:58:00Z' }] };
  assert.deepEqual(said(deploying, file).lines.map((line) => [line.text, line.source]), [['deploying ui 2.4.77 to tdd', 'system'], ['prod frozen until Mon 00:00 UTC', 'fleet']]);
  assert.deepEqual(said(deploying, { deployments: [] }).lines.map((line) => line.text), ['prod frozen until Mon 00:00 UTC', 'last: ui 2.4.75 to prod, 20 min ago']);
  // Two deployments that say the same in a box are one line.
  const twice = acting({ inFlight: [flying('waiting', 'prod', { waitsFor: signOff }), flying('waiting', 'prod', { project: 'demo-api', waitsFor: signOff })] });
  assert.deepEqual(said(twice).lines.map((line) => line.text), ['prod waits for a sign-off, 12 min']);
  // Old data of the fleet says nothing; data without activity says nothing, as before.
  assert.deepEqual(said(busy, undefined, now, true), { lines: [], more: 0 });
  assert.deepEqual(said(system()), { lines: [], more: 0 });
  assert.deepEqual(said(acting({})), { lines: [], more: 0 });
});

test('an environment with something in flight is known by its name, and a project in it by both', () => {
  const marks = [
    ...fleetMarks(acting({ inFlight: [flying('queued', 'UAT'), flying('executing', 'uat', { project: 'demo-api' }), flying('waiting', 'prod', { waitsFor: signOff }), flying('executing', 'prod')] }), now),
    { project: 'demo-ui', environment: 'tdd', state: 'succeeded', ended: true, minutes: 2 },
  ];
  assert.deepEqual(tileFlights(marks), { prod: 'waiting', uat: 'executing' });
  assert.deepEqual(cellFlights(marks), { 'demo-ui / prod': 'waiting', 'demo-api / uat': 'executing', 'demo-ui / uat': 'queued' });
  assert.equal(cellKey('Demo-UI', 'Prod'), 'demo-ui / prod');
  // What the fleet read too long ago marks nothing.
  const old = fleetMarks(acting({ inFlight: [flying('executing', 'uat')] }), new Date('2026-10-07T14:50:00Z'));
  assert.deepEqual([tileFlights(old), cellFlights(old)], [{}, {}]);
  assert.deepEqual([flightWord('prod', 'waiting'), flightWord('uat', 'executing'), flightWord('tdd', 'queued'), flightWord('tdd', 'paused')], [
    'prod: waits for a person', 'uat: deploying now', 'tdd: a deployment is queued', 'tdd: paused',
  ]);
});

test('the Octopus instance says what it is doing beside its count against the cap', () => {
  const service = (activity) => ({ id: 'octopus', name: 'Octopus Deploy', state: 'ok', detail: '4 of 20 tasks', activity });
  assert.equal(instanceLine(service({ executing: 2, queued: 0, waiting: 1, cap: 20 }), false), '2 running · 1 waits for a person');
  assert.equal(instanceLine(service({ executing: 1, queued: 3, waiting: 2, cap: 20 }), false), '1 running · 3 queued · 2 wait for a person');
  assert.equal(instanceLine(service({ executing: 0, queued: 0, waiting: 0, cap: 20 }), false), '0 running');
  // What the fleet's account could not read is not said, and old data says nothing.
  assert.equal(instanceLine(service({ executing: null, queued: null, waiting: 1, cap: null }), false), '1 waits for a person');
  assert.equal(instanceLine(service({ executing: 2, queued: 0, waiting: 1 }), true), '');
  assert.equal(instanceLine(service(null), false), '');
  assert.equal(instanceLine({ id: 'kit' }, false), '');
  const data = { fleet: {}, systems: [], shared: { services: [service({ executing: 2, queued: 0, waiting: 1, cap: 20 }), { id: 'kit', name: 'Delivery standard', state: 'ok', detail: '' }] } };
  assert.deepEqual(landscape(data, false, now).services.map((one) => one.acts), ['2 running · 1 waits for a person', undefined]);
  assert.deepEqual(landscape(data, true, now).services.map((one) => 'acts' in one), [false, false]);
});
