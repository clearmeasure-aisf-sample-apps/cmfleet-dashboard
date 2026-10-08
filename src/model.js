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
