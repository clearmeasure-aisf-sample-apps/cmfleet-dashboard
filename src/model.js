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
        ...(environment.inProgress ? { progress: true } : {}),
      });
    }
  }
  return rows.sort((a, b) => (a.age ?? Infinity) - (b.age ?? Infinity));
}

// How a release stands in its environment: failed, in progress (its deployment had not ended when the fleet read it:
// the release is not there yet, and has no time), behind the first environment's release, or the same.
function cellKind(environment, first) {
  if (FAILED.includes(environment.state)) return 'failed';
  if (environment.inProgress) return 'progress';
  return first && environment.release !== first ? 'behind' : 'same';
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
        const kind = cellKind(environment, first);
        const text = kind === 'failed' ? `${environment.release} ${environment.state.toLowerCase()}` : environment.release;
        return { name, kind, text, url: environment.url || '', finished: environment.finished || '', ...(kind === 'progress' ? { started: environment.started || '' } : {}) };
      }),
    });
  }
  return { names, rows };
}

// A cell of the release grid in words, for a reader who does not see its tile: deployed, deployed and behind the
// first environment, failed, or nothing there.
export const IN_PROGRESS = 'in progress when read';

export function releaseWord(cell, first) {
  if (cell.kind === 'none') return 'not deployed';
  if (cell.kind === 'failed') return 'failed';
  if (cell.kind === 'progress') return IN_PROGRESS;
  return cell.kind === 'behind' ? `deployed, behind ${first}` : 'deployed';
}

// Under a release in the grid: when its deployment finished, or that it had not when the fleet read it. Never
// nothing for a release that was being deployed.
export function cellWhen(cell, timeZone) {
  return cell.kind === 'progress' ? IN_PROGRESS : formatWhen(cell.finished, timeZone);
}

export function cellTitle(cell) {
  if (cell.kind === 'progress') return cell.started ? `started ${cell.started} UTC, not finished when the fleet read it` : 'not finished when the fleet read it';
  return cell.finished ? `finished ${cell.finished} UTC` : '';
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
const WORSE = ['none', 'same', 'behind', 'progress', 'failed'];

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
  if (row.progress) return `${row.environment} ${row.release} · ${IN_PROGRESS}`;
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
    ...(instanceLine(service, stale) ? { acts: instanceLine(service, stale) } : {}),
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

// Activity: what happens in a system now and what just happened. Two sources say it. The system's own file
// (deployments.json, read every minute) is of the last minutes; the fleet's reading of Octopus ("activity" of
// fleet.json) is up to six hours old, and is the only one for a system that publishes no file, and the only one that
// knows a freeze, who is responsible for a sign-off and who started a deployment. They are never both shown about
// the same thing: where the system's file was read, what is in flight comes from it alone.

// For how long the fleet's own reading of what is in flight is said in the present tense. A deployment takes
// minutes; after this, what was executing then has most likely ended, and the page says "was".
export const FLEET_FRESH_MINUTES = 30;
export const ACTIVITY_LINES = 2;

const flightRank = (state) => (FLIGHT_ORDER.indexOf(state) + 1) || FLIGHT_ORDER.length + 1;
const personWaitedFor = (mark) => (mark.waitsFor === 'guided failure' ? 'a person' : 'a sign-off');

// A project's name on its own system's box: "cmdemo1-ui" is "ui" there.
export function shortProject(name, slug) {
  const prefix = `${slug}-`;
  return name && slug && name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name || '';
}

// What the fleet read as in flight, in the words of the card: present tense while the reading is fresh, past tense
// with its age after that.
export function fleetText(mark) {
  const what = `${mark.project} ${mark.release}`;
  if (!mark.past) return mark.state === 'waiting' && mark.waitsFor === 'guided failure' ? `${what} waits for a person in ${mark.environment}` : deploymentText(mark);
  const when = mark.read === null ? 'when the fleet read it' : `when the fleet read it ${formatAge(mark.read / 60)} ago`;
  if (mark.state === 'waiting') return `${what} waited for ${personWaitedFor(mark)} in ${mark.environment} ${when}`;
  return mark.state === 'queued' ? `${what} was queued for ${mark.environment} ${when}` : `${what} was deploying to ${mark.environment} ${when}`;
}

// The fleet's own reading of a system's deployments in flight, as marks of the shape deploymentMarks gives. A mark
// is "past" when the reading is older than FLEET_FRESH_MINUTES or has no time.
export function fleetMarks(system, now) {
  const activity = system.activity;
  const entries = Array.isArray(activity?.inFlight) ? activity.inFlight : [];
  const readHours = ageHours(activity?.read, now);
  const read = readHours === null ? null : Math.round(readHours * 60);
  return entries.map((entry) => {
    // What it waits for counts from when it began to wait, not from when the deployment started.
    const waits = { kind: '', responsible: '', since: entry.since, ...(entry.state === 'waiting' ? entry.waitsFor : {}) };
    const hours = ageHours(waits.since, now);
    const mark = {
      project: entry.project, environment: entry.environment, release: entry.release, state: entry.state,
      url: entry.url || '', ended: false, minutes: hours === null ? null : Math.round(hours * 60),
      source: 'fleet', past: read === null || read > FLEET_FRESH_MINUTES, read,
      waitsFor: waits.kind, responsible: waits.responsible, startedBy: entry.startedBy || '',
    };
    return { ...mark, text: fleetText(mark) };
  }).sort((a, b) => flightRank(a.state) - flightRank(b.state));
}

// What to mark for one system. The system's own file wins: where it was read, nothing of the fleet's older reading
// of what is in flight is used. Where a system publishes none (or it could not be read), the fleet's reading is,
// unless the fleet's data is too old to be a reading at all.
export function flightMarks(system, file, now, stale) {
  if (file) return deploymentMarks(file, now).map((mark) => ({ ...mark, source: 'system' }));
  return stale ? [] : fleetMarks(system, now);
}

// What is in flight now, as far as the page may claim it: not what ended, and not what the fleet read too long ago.
export const liveMarks = (marks) => marks.filter((mark) => !mark.ended && !mark.past);

const SOURCE_WORDS = { system: 'the system\'s own deployments.json', fleet: 'the fleet\'s reading of Octopus' };

// One deployment in flight as a line of the system's box: "prod waits for a sign-off, 12 min",
// "deploying ui 2.4.76 to uat", "ui 2.4.76 queued for uat"; in the past tense for an old reading of the fleet.
export function flightLine(mark, slug) {
  const what = `${shortProject(mark.project, slug)} ${mark.release}`;
  const title = [mark.text, mark.responsible ? `responsible: ${mark.responsible}` : '', mark.startedBy ? `started by ${mark.startedBy}` : ''].filter(Boolean).join('; ');
  const line = (kind, text) => ({ kind, text, title: `${title} (${SOURCE_WORDS[mark.source] || mark.source})`, source: mark.source });
  if (mark.past) {
    const read = mark.read === null ? 'when read' : `when read ${formatAge(mark.read / 60)} ago`;
    if (mark.state === 'waiting') return line('earlier', `${mark.environment} waited for ${personWaitedFor(mark)} ${read}`);
    return line('earlier', mark.state === 'queued' ? `${what} was queued for ${mark.environment} ${read}` : `was deploying ${what} to ${mark.environment} ${read}`);
  }
  if (mark.state === 'waiting') return line('waiting', `${mark.environment} waits for ${personWaitedFor(mark)}${mark.minutes === null ? '' : `, ${formatAge(mark.minutes / 60)}`}`);
  if (mark.state === 'executing') return line('deploying', `deploying ${what} to ${mark.environment}`);
  return line('queued', mark.state === 'queued' ? `${what} queued for ${mark.environment}` : `${what} in ${mark.environment}: ${mark.state}`);
}

// A time of a freeze, short enough for a box and in UTC, as the fleet's data is: "Mon 00:00 UTC", or with the date
// when it is more than six days away and the day of the week would not say which.
export function formatUntil(text, now) {
  const time = parseUtc(text);
  if (!time) return '';
  const parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).formatToParts(time);
  const part = (type) => parts.find((one) => one.type === type).value;
  const day = Math.abs(time.getTime() - now.getTime()) > 6 * 24 * 3600000 ? `${part('month')} ${part('day')}` : part('weekday');
  return `${day} ${part('hour')}:${part('minute')} UTC`;
}

function freezeText(freeze, active, now) {
  const where = (freeze.environments || []).join(', ') || 'deployments';
  return active ? `${where} frozen until ${formatUntil(freeze.to, now)}` : `${where} freezes ${formatUntil(freeze.from, now)}`;
}

// The deployment freezes the fleet read for a system, as lines: "prod frozen until Mon 00:00 UTC" while one is in
// force, "prod freezes Sat 00:00 UTC" before it begins. One that is over is not said; freezes that say the same
// (two projects frozen for the same days) are one line. The one in force first, then the one that begins first.
export function freezeLines(system, now) {
  const lines = [];
  for (const freeze of system.activity?.freezes || []) {
    const from = parseUtc(freeze.from);
    const to = parseUtc(freeze.to);
    if (!from || !to || to <= now) continue;
    const active = from <= now;
    const text = freezeText(freeze, active, now);
    const about = [`"${freeze.name}"`, ...(freeze.projects?.length ? [`(${freeze.projects.join(', ')})`] : [])].join(' ');
    const same = lines.find((line) => line.text === text);
    if (same) same.names.push(about);
    else lines.push({ kind: 'freeze', text, names: [about], active, from: from.getTime(), until: `${freeze.from} to ${freeze.to}`, source: 'fleet' });
  }
  return lines.sort((a, b) => Number(b.active) - Number(a.active) || a.from - b.from)
    .map((line) => ({ kind: line.kind, text: line.text, title: `Deployment freeze ${line.names.join(', ')}: ${line.until} (${SOURCE_WORDS.fleet})`, source: line.source }));
}

// The last thing that happened, for a system with nothing in flight: the newest of what the system's own file says
// ended and of what the fleet read. "last: ui 2.4.75 to prod, 20 min ago".
export function lastLine(system, marks, now, stale) {
  const ended = marks.filter((mark) => mark.ended && mark.minutes !== null).map((mark) => ({
    project: mark.project, release: mark.release, environment: mark.environment, result: mark.state, minutes: mark.minutes, startedBy: '', source: mark.source || 'system',
  }));
  const recent = stale ? null : (system.activity?.recent || [])[0];
  const hours = recent ? ageHours(recent.finished, now) : null;
  if (hours !== null) ended.push({ project: recent.project, release: recent.release, environment: recent.environment, result: recent.result, minutes: Math.round(hours * 60), startedBy: recent.startedBy || '', source: 'fleet' });
  if (!ended.length) return null;
  const last = ended.reduce((newest, one) => (one.minutes < newest.minutes ? one : newest));
  const what = `${shortProject(last.project, system.slug)} ${last.release}`;
  const how = last.result === 'failed' ? 'failed in' : last.result === 'canceled' ? 'canceled in' : 'to';
  const ago = `${formatAge(last.minutes / 60)} ago`;
  return {
    kind: last.result === 'failed' ? 'last failed' : 'last',
    text: `last: ${what} ${how} ${last.environment}, ${ago}`,
    title: `${last.project} ${last.release} ${how} ${last.environment}, ${ago}${last.startedBy ? `; started by ${last.startedBy}` : ''} (${SOURCE_WORDS[last.source]})`,
    source: last.source,
  };
}

// What a system's box says about its activity: at most two lines, the most urgent first. What waits for a person,
// then what is deploying, then what is queued, then a freeze, then what the fleet read as in flight too long ago to
// claim it of now; and where nothing is in flight, the last thing that happened. Nothing where nothing was read.
export function activityLines(system, marks, now, stale) {
  const flying = marks.filter((mark) => !mark.ended);
  const lines = [
    ...flying.filter((mark) => !mark.past).map((mark) => flightLine(mark, system.slug)),
    ...(stale ? [] : freezeLines(system, now)),
    ...flying.filter((mark) => mark.past).map((mark) => flightLine(mark, system.slug)),
  ];
  const last = flying.length ? null : lastLine(system, marks, now, stale);
  if (last) lines.push(last);
  const said = lines.filter((line, index) => lines.findIndex((other) => other.text === line.text) === index);
  return { lines: said.slice(0, ACTIVITY_LINES), more: Math.max(0, said.length - ACTIVITY_LINES) };
}

// Which environments have something in flight now, and what: the most urgent state of each, by the environment's
// name in lower case. And the same for each project in each environment, for the card's grid.
export function tileFlights(marks) {
  const flights = {};
  for (const mark of liveMarks(marks)) {
    const name = String(mark.environment).toLowerCase();
    if (!(name in flights) || flightRank(mark.state) < flightRank(flights[name])) flights[name] = mark.state;
  }
  return flights;
}

export const cellKey = (project, environment) => `${project} / ${environment}`.toLowerCase();

export function cellFlights(marks) {
  const flights = {};
  for (const mark of liveMarks(marks)) {
    const key = cellKey(mark.project, mark.environment);
    if (!(key in flights) || flightRank(mark.state) < flightRank(flights[key])) flights[key] = mark.state;
  }
  return flights;
}

// An environment's tile in words while something is in flight there.
export function flightWord(name, state) {
  const words = { waiting: 'waits for a person', executing: 'deploying now', queued: 'a deployment is queued' };
  return `${name}: ${words[state] || state}`;
}

// What the Octopus instance is doing, beside its count against the task cap: "2 running · 1 waits for a person".
// A number the fleet's account could not read is left out, and so is a zero that would only take room.
export function instanceLine(service, stale) {
  const activity = service.activity;
  if (!activity || stale) return '';
  const parts = [];
  if (Number.isFinite(activity.executing)) parts.push(`${activity.executing} running`);
  if (activity.queued > 0) parts.push(`${activity.queued} queued`);
  if (activity.waiting > 0) parts.push(activity.waiting === 1 ? '1 waits for a person' : `${activity.waiting} wait for a person`);
  return parts.join(' · ');
}
