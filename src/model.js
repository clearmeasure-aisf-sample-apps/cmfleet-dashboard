// What the wall says about the fleet's data, with no page in it: every function here takes data and a time and
// returns what to show, so it is tested without a browser.

// The fleet writes its data every six hours. Data older than two refreshes is not a reading any more.
export const REFRESH_HOURS = 6;
export const STALE_AFTER_HOURS = 2 * REFRESH_HOURS;

const FAILED = ['Failed', 'TimedOut', 'Canceled'];

export const STATE_WORDS = {
  critical: 'Production affected',
  attention: 'Needs attention',
  behind: 'Behind the standard',
  'not-read': 'Not read',
  asleep: 'Asleep',
  ok: 'As declared',
};

// The fleet's times are UTC: "2026-10-07T04:48:18Z" for a reading, "2026-10-07 04:28" for a deployment.
// Anything else is not a time: the engine's own reading of a date is too forgiving to trust with a reading's age.
const UTC_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?Z?$/;

export function parseUtc(text) {
  const parts = UTC_TIME.exec(text || '');
  if (!parts) return null;
  const time = new Date(`${parts[1]}T${parts[2]}${parts[3] || ':00'}Z`);
  return Number.isNaN(time.getTime()) ? null : time;
}

export function ageHours(text, now) {
  const time = parseUtc(text);
  return time ? Math.max(0, (now.getTime() - time.getTime()) / 3600000) : null;
}

export function formatAge(hours) {
  if (hours === null || hours === undefined) return 'unknown';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}

// When a deployment finished, as Octopus writes it beside a release: "Oct 8, 2026 8:18 AM", in the reader's own time
// zone (a zone is named only to say which one, as a test does). Nothing for a time that was not read.
export function formatWhen(text, timeZone) {
  const time = parseUtc(text);
  if (!time) return '';
  const parts = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).formatToParts(time);
  const part = (type) => parts.find((one) => one.type === type)?.value || '';
  return `${part('month')} ${part('day')}, ${part('year')} ${part('hour')}:${part('minute')} ${part('dayPeriod')}`;
}

export function isStale(generated, now) {
  const hours = ageHours(generated, now);
  return hours === null || hours > STALE_AFTER_HOURS;
}

export const asked = (system) => system.findings.filter((finding) => !finding.observed);
export const observed = (system) => system.findings.filter((finding) => finding.observed);

// A finding's class: critical (production is affected), broken (something that worked has stopped) or gap (something
// the system never had). Data written before the classes existed has none: it reads as broken.
export function counts(system) {
  const result = { critical: 0, broken: 0, gap: 0, observed: observed(system).length };
  for (const finding of asked(system)) {
    const cls = finding.class in result && finding.class !== 'observed' ? finding.class : 'broken';
    result[cls] += 1;
  }
  return result;
}

// The one state a system has on the wall. Old data is not read, whatever it said; a system that is switched off on
// purpose is asleep, not healthy.
export function displayState(system, stale) {
  if (stale || system.state === 'unknown') return 'not-read';
  if (['critical', 'attention', 'behind'].includes(system.state)) return system.state;
  return system.asleep ? 'asleep' : 'ok';
}

// Where a system stands on one standard, in the words the wall uses. The fleet's own word is kept for a status the
// wall does not know yet.
export const STANDING_WORDS = {
  critical: 'production affected',
  broken: 'broken',
  gap: 'gap',
  behind: 'behind',
  observed: 'observed',
  variance: 'intended variance',
  asleep: 'asleep',
  exempt: 'not compared',
  none: 'nothing to judge',
  unchecked: 'not checked',
  met: 'met',
};

// Every standard of the fleet for one system: its name, how the system stands on it and the fleet's words for why.
// Data written before the fleet recorded this has none.
export function standing(system) {
  return (system.standards || []).map((row) => ({
    label: row.label || row.standard,
    status: row.status,
    word: STANDING_WORDS[row.status] || row.status,
    text: row.text || '',
  }));
}

// The standing in one line, the worst first: "1 gap · 1 behind · 9 met · 1 not checked".
export function standingSummary(system) {
  const rows = standing(system);
  const order = Object.keys(STANDING_WORDS);
  const seen = [...new Set(rows.map((row) => row.status))].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return seen.map((status) => `${rows.filter((row) => row.status === status).length} ${STANDING_WORDS[status] || status}`).join(' · ');
}

// Why a system is behind the standard: one line per standard it does not keep yet.
export const behindReasons = (system) => system.behind || [];

// A deployment in a few words: how long ago it finished, or what it is doing when it has not finished or did not
// succeed.
export function deploymentWord(environment, now) {
  if (FAILED.includes(environment.state)) return environment.state.toLowerCase();
  const age = ageHours(environment.finished, now);
  if (age === null) return environment.state ? environment.state.toLowerCase() : 'no time read';
  return `${formatAge(age)} in ${environment.name}`;
}

export function prodEnvironments(system) {
  return system.environments.filter((environment) => environment.tier === 'prod').map((environment) => environment.name.toLowerCase());
}

// What runs in production: one row per project that has a release there, the newest deployment first.
export function prodRows(system, now) {
  const names = prodEnvironments(system);
  const rows = [];
  for (const project of system.projects) {
    for (const environment of project.environments) {
      if (!names.includes(environment.name.toLowerCase()) || !environment.release) continue;
      rows.push({
        project: project.name,
        environment: environment.name,
        release: environment.release,
        failed: FAILED.includes(environment.state),
        state: environment.state,
        age: ageHours(environment.finished, now),
        url: environment.url || '',
        when: deploymentWord(environment, now),
      });
    }
  }
  return rows.sort((a, b) => (a.age ?? Infinity) - (b.age ?? Infinity));
}

// The release of every project in every environment, and how it stands beside the first environment's.
export function releaseGrid(system) {
  const names = system.environments.map((environment) => environment.name.toLowerCase());
  const rows = [];
  for (const project of system.projects) {
    const byName = new Map(project.environments.map((environment) => [environment.name.toLowerCase(), environment]));
    if (![...byName.values()].some((environment) => environment.release)) continue;
    const first = byName.get(names[0])?.release || '';
    rows.push({
      project: project.name,
      cells: names.map((name) => {
        const environment = byName.get(name);
        if (!environment?.release) return { name, kind: 'none', text: 'none', url: '', finished: '' };
        const failed = FAILED.includes(environment.state);
        const kind = failed ? 'failed' : first && environment.release !== first ? 'behind' : 'same';
        const text = failed ? `${environment.release} ${environment.state.toLowerCase()}` : environment.release;
        return { name, kind, text, url: environment.url || '', finished: environment.finished || '' };
      }),
    });
  }
  return { names, rows };
}

// A cell of the release grid in words, for a reader who does not see its tile: deployed, deployed and behind the
// first environment, failed, or nothing there.
export function releaseWord(cell, first) {
  if (cell.kind === 'none') return 'not deployed';
  if (cell.kind === 'failed') return 'failed';
  return cell.kind === 'behind' ? `deployed, behind ${first}` : 'deployed';
}

// What a reader may type to find a system: its name, what it is, its owner and its projects.
export function findText(system) {
  return [system.slug, system.name, system.owner, ...system.projects.map((project) => project.name)].filter(Boolean).join(' ').toLowerCase();
}

export const matches = (system, typed) => findText(system).includes((typed || '').trim().toLowerCase());

export function fleetFacts(data, now) {
  const stale = isStale(data.generated, now);
  const states = data.systems.map((system) => displayState(system, stale));
  const total = (data.shared.cost || []).find((cost) => cost.of === 'the fleet');
  const sum = (key) => data.systems.reduce((count, system) => count + counts(system)[key], 0);
  return {
    stale,
    age: ageHours(data.generated, now),
    systems: data.systems.length,
    critical: states.filter((state) => state === 'critical').length,
    attention: states.filter((state) => state === 'attention').length,
    behind: states.filter((state) => state === 'behind').length,
    notRead: states.filter((state) => state === 'not-read').length,
    broken: sum('broken') + sum('critical'),
    gaps: sum('gap'),
    cost: total ? `${total.monthToDate} ${total.currency}` : 'n/a',
  };
}

// A shared service's state on the wall: the same words as a system's, and not read when the data is old.
export function serviceState(service, stale) {
  if (stale || service.state === 'unknown') return 'not-read';
  return service.state === 'critical' || service.state === 'attention' ? service.state : 'ok';
}

// Where a system's name leads: its runtime view (what runs in production and how it is), or its own dashboard when
// it names no runtime view. Nothing when it has neither.
export function systemLink(system) {
  return system.runtimeView || system.dashboard || '';
}

// Where a box of the landscape leads that is not a system: the thing it stands for, in the tool that holds it. The
// operators' box leads to what they act on, the findings. The subscription leads to the Azure portal: to the
// subscription itself when the fleet's data names its address there, otherwise to the reader's resource groups.
// None of these pages lets itself be shown inside another page, so they open beside this one.
export const AZURE_PORTAL = 'https://portal.azure.com/#view/HubsExtension/BrowseResourceGroups';

export function boxLinks(data) {
  const fleet = data.fleet || {};
  const kit = fleet.repository ? `https://github.com/${fleet.repository}` : '';
  const links = {
    operators: kit ? `${kit}/issues?q=is%3Aissue+state%3Aopen+label%3Afleet-finding` : '',
    fleet: kit ? `${kit}/tree/main/fleet` : '',
    octopus: fleet.octopus || '',
    kit: kit ? `${kit}/tree/green` : '',
    policies: fleet.policies ? `https://github.com/${fleet.policies}` : '',
    subscription: fleet.azurePortal || AZURE_PORTAL,
  };
  return Object.fromEntries(Object.entries(links).filter(([, url]) => url));
}

// The place a link leads to, in a word a reader knows: "github.com".
export function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

// Where a system is in Azure: each resource group the fleet's data names for it, with its address in the portal. A
// system the data names no group for leads to the subscription, when the data names that; otherwise nowhere.
export function azureLinks(system, fleet) {
  const groups = (system.azure || []).filter((one) => one.group && one.url);
  if (groups.length) return groups.map((one) => ({ text: `Azure: ${one.group}`, url: one.url }));
  return fleet?.azurePortal ? [{ text: 'Azure subscription', url: fleet.azurePortal }] : [];
}

// A system with nothing to zoom into still leads somewhere: its space in Octopus, where what it runs is shown, or its
// repository when the fleet read no space.
export function systemDoor(system) {
  return system.space?.url || system.repositoryUrl || '';
}

// What a system's box says beyond its name (decision 0030 of the kit). Each is a line or a row of tiles, short
// enough for a box, and nothing where the fleet read nothing.

// Where the system stands in each of its environments: the worst of what its projects' last deployments there say.
// Failed comes before behind the first environment, and that before deployed; none where no project has a release.
const WORSE = ['none', 'same', 'behind', 'failed'];

export function environmentTiles(system) {
  const grid = releaseGrid(system);
  return grid.names.map((name, column) => {
    const kind = grid.rows.reduce((worst, row) => (WORSE.indexOf(row.cells[column].kind) > WORSE.indexOf(worst) ? row.cells[column].kind : worst), 'none');
    return { name, kind, word: `${name}: ${releaseWord({ kind }, grid.names[0])}` };
  });
}

// What production runs and since when: its newest deployment, or the one that failed where one did.
export function prodLine(system, now) {
  const rows = prodRows(system, now);
  const row = rows.find((one) => one.failed) || rows[0];
  if (!row) return '';
  if (row.failed) return `${row.environment} ${row.release} ${row.state.toLowerCase()}`;
  return row.age === null ? `${row.environment} ${row.release}` : `${row.environment} ${row.release} · ${formatAge(row.age)}`;
}

// The state in words, with a count, for a system that is not as declared: colour is then not the only thing that
// says it.
export function stateLine(system, stale) {
  const state = displayState(system, stale);
  if (state === 'ok') return '';
  if (state === 'behind') {
    const reasons = behindReasons(system).length;
    return reasons ? `${STATE_WORDS.behind}: ${reasons} ${reasons === 1 ? 'standard' : 'standards'}` : STATE_WORDS.behind;
  }
  if (state === 'attention') {
    const count = counts(system);
    return count.broken + count.critical ? `${STATE_WORDS.attention}: ${count.broken + count.critical} broken` : STATE_WORDS.attention;
  }
  return STATE_WORDS[state];
}

export function standardsLine(system) {
  const rows = standing(system);
  return rows.length ? `${rows.filter((row) => row.status === 'met').length} of ${rows.length} standards` : '';
}

export const costLine = (system) => (system.cost ? `${system.cost.monthToDate} ${system.cost.currency}` : '');

// The landscape as the page draws it: who watches, the fleet's oversight, the subscription with every system in it,
// and what the systems share. Each box says what it is, the state of what it stands for where it has one, and where
// it leads: a system zooms into its own dashboard (zoom), everything else opens what it stands for (open).
export function landscape(data, stale, now) {
  const links = boxLinks(data);
  const systems = data.systems.map((system) => ({
    name: system.slug,
    title: system.slug,
    text: system.name || '',
    state: displayState(system, stale),
    zoom: systemLink(system),
    open: systemLink(system) ? '' : systemDoor(system),
    pulls: Boolean(system.kitBuilt),
    madeOf: system.madeOf || '',
    tiles: environmentTiles(system),
    runs: prodLine(system, now),
    says: stateLine(system, stale),
    small: [standardsLine(system), costLine(system)].filter(Boolean).join(' · '),
    // A system that is switched off on purpose is not asked for its health.
    health: Boolean(system.health) && !system.asleep,
  }));
  const services = (data.shared?.services || []).map((service) => ({
    name: service.id, title: service.name, text: service.detail || '', state: serviceState(service, stale), zoom: '', open: links[service.id] || '',
  }));
  return {
    operators: { name: 'operators', title: 'Operators', text: 'watch the fleet and act on what needs attention', zoom: '', open: links.operators || '' },
    fleet: { name: 'fleet', title: data.fleet?.name || 'The fleet', text: 'Fleet oversight: the registry, the rules and the findings', zoom: '', open: links.fleet || '' },
    subscription: { name: 'subscription', title: 'Azure subscription', text: 'where the systems run', open: links.subscription },
    systems,
    services,
    pulling: systems.filter((system) => system.pulls).length,
  };
}

// What a box says when the pointer rests on it: what it is, its state where it has one, and where a click leads.
export function boxTitle(box) {
  const state = box.state ? `${box.title}: ${STATE_WORDS[box.state]}` : box.title;
  if (box.zoom) return `${state}. Zooms into its dashboard`;
  return box.open ? `${state}. Opens ${hostOf(box.open)} in a new tab` : state;
}

// A title the fleet wrote starts with the system's name; on the system's own tile that is said already.
export function withoutSlug(title, slug) {
  return title.startsWith(`${slug}: `) ? title.slice(slug.length + 2) : title;
}

// A limit that is used up is full: nothing has stopped, but the next system that needs one cannot have it. Over the
// limit is the state that gets colour.
export function limitShare(limit) {
  const used = Number(limit.used);
  const of = Number(limit.of);
  if (!Number.isFinite(used) || !Number.isFinite(of) || of <= 0) return { share: 0, over: false, full: false };
  return { share: Math.min(100, Math.round((100 * used) / of)), over: used > of, full: used === of };
}

// The limits worth a bar are the ones something uses; the rest are counted, so a quota nobody touches takes no room.
export function limitsInUse(limits) {
  const used = limits.filter((limit) => Number(limit.used) > 0);
  return { used, unused: limits.length - used.length };
}

// What a probe of a system's health address says. A page of another origin may answer without letting this page read
// the answer: then all that is known is that it responded.
export function healthWord(probe) {
  if (!probe) return '';
  if (probe.error) return 'not responding';
  if (probe.opaque) return 'responding';
  return probe.ok ? 'healthy' : `answers ${probe.status}`;
}

// A system's deployments in flight, from the file the system itself publishes (deployments.json). What ended stays on
// the wall for ten minutes, so that a deployment of a few minutes is still seen.
export const FINISHED_MINUTES = 10;
const FLIGHT_ORDER = ['waiting', 'executing', 'queued', 'failed', 'canceled', 'succeeded'];

export function deploymentText(mark) {
  const what = `${mark.project} ${mark.release}`;
  const ago = mark.minutes === null ? '' : ` ${formatAge(mark.minutes / 60)} ago`;
  switch (mark.state) {
    case 'queued': return `${what} is queued for ${mark.environment}`;
    case 'executing': return `deploying ${what} to ${mark.environment}`;
    case 'waiting': return `${what} waits for a sign-off in ${mark.environment}`;
    case 'succeeded': return `${what} reached ${mark.environment}${ago}`;
    case 'failed': return `${what} failed in ${mark.environment}${ago}`;
    case 'canceled': return `${what} was canceled in ${mark.environment}${ago}`;
    default: return `${what} in ${mark.environment}: ${mark.state}`;
  }
}

// What to mark for one system: everything in flight, and what ended in the last ten minutes. The one a person has to
// act on first, then what runs, what waits its turn, and what ended.
export function deploymentMarks(file, now) {
  const entries = Array.isArray(file?.deployments) ? file.deployments : [];
  const rank = (state) => (FLIGHT_ORDER.indexOf(state) + 1) || FLIGHT_ORDER.length + 1;
  return entries.map((entry) => {
    const ended = Boolean(entry.finished);
    const hours = ageHours(ended ? entry.finished : entry.since, now);
    const mark = {
      project: entry.project, environment: entry.environment, release: entry.release, state: entry.state,
      url: entry.url || '', ended, minutes: hours === null ? null : Math.round(hours * 60),
    };
    return { ...mark, text: deploymentText(mark) };
  }).filter((mark) => !mark.ended || (mark.minutes !== null && mark.minutes <= FINISHED_MINUTES))
    .sort((a, b) => rank(a.state) - rank(b.state));
}

// The one word a system's box carries: what is in flight wins over what ended.
export function flightState(marks) {
  const inFlight = marks.find((mark) => !mark.ended);
  if (inFlight) return inFlight.state;
  return marks.length ? 'finished' : '';
}
