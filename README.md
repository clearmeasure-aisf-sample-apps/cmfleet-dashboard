# cmfleet-dashboard

The fleet health dashboard: every system of the fleet on one page, for operators who act on what it shows. It is the
one application of the system `cmfleet`, the fleet's own system.

The fleet is declared and overseen in
[demo-environment-kit](https://github.com/clearmeasure-aisf-sample-apps/demo-environment-kit) (`fleet/`). Its workflow
`fleet` writes what it finds every six hours and publishes it:
[fleet.json](https://clearmeasure-aisf-sample-apps.github.io/demo-environment-kit/fleet.json) and
[landscape.svg](https://clearmeasure-aisf-sample-apps.github.io/demo-environment-kit/landscape.svg). This page reads
`fleet.json` in the reader's browser and draws it; the landscape too is drawn from it (below), and the fleet's own C4
drawing is linked under it. Nothing is pushed into this repository, and the page has no
server of its own.

## How it looks, and why

The page wears two brands (Jeffrey Palermo, 2026-10-08: "restyled so that it matches Clear Measure and Octopus
branding ... mimic the styling of the octopus screen ... use Clear Measure brand guide and Clear Measure logo").

| Part | From | In the page |
|---|---|---|
| Navy surfaces, one line colour, cards with a thin border, the bar across the top with the sections beside the page | Octopus Deploy's dark screens | `--bg`, `--bar`, `--side`, `--line` in `src/styles.css` |
| A system drawn as a project group: its name, how many projects, then each project with a tile, the release and when for every environment | Octopus's Projects screen | `drawReleases` in `src/app.js` |
| The green tile with a tick for a deployment that succeeded, red with a cross for one that failed, the green primary button, blue for links | Octopus | `--ok`, `--crit-fill`, `--link` |
| The logo, in the bar where Octopus has its own, and its mark as the page's icon | Clear Measure | `src/clear-measure-logo-white.png`, `src/favicon.png` |
| The navy of the landscape's boxes, the primary blue of what is selected, focused or filled, and the yellow of "behind the standard" | Clear Measure's palette as clearmeasure.com carries it: navy `#004B87`, primary blue `#0085CA`, deep navy `#043E6C`, accent yellow `#EECB1A`, pale blue `#CFEAFF`; and the logo's own `#24ABE1` for a deployment in flight | `--cm-blue`, `--cm-primary`, `--cm-deep`, `--cm-yellow`, `--cm-light-blue`, `--cm-sky` |
| Headings and the fleet's name in Jost | Clear Measure's site is set in Futura and loads Jost as the face a browser can get | `--display` |
| Everything else in Roboto: tables, numbers, text | Octopus's type | `--body`, `--data` |

No brand guide document was found. The source is the public site's own stylesheet (read on 2026-10-08:
`wp-content/uploads/elementor/css/post-96.css` of clearmeasure.com), which Jeffrey Palermo accepted as the brand
source that day; the logo files are the ones Clear Measure's own web applications ship. Links stay Octopus's light
blue: the primary blue on these dark surfaces is for marks and edges, where its contrast is enough. Where a guide
says otherwise, the variables at the top of `src/styles.css` are the one place to change.

There is one theme, the dark one of the screen it mimics.

## What the page says

| On the page | Means |
|---|---|
| A green tile with a tick | That project's last deployment to that environment succeeded. The release is beside it, and when it finished, in the reader's own time zone |
| A red tile with a cross | It failed, timed out or was cancelled |
| A release in orange beside a green tile | The deployment succeeded, and the environment runs an older release than the first one |
| An empty dashed tile | Nothing is deployed there |
| No colour on a system's card, "As declared" | The normal state of a system has no colour |
| Orange, "Needs attention" | Something that worked has stopped: a failed deployment or check, an environment left behind, a stale proof |
| Yellow, "Behind the standard" | Nothing has stopped, and the system does not keep every standard yet: a gap it never closed, or a change of the standard it has not taken yet. Why is on the card's face |
| Red, "Production affected" | The last deployment to production failed, or a service every system depends on is out |
| Dashed, "Not read" | The fleet could not read the system, or its data is older than two of its six-hourly readings |
| Dotted, "Asleep" | Switched off on purpose |
| A blue dot | A deployment in flight, read every minute from the file each system publishes itself (`deployments.json`): pulsing while it runs, hollow while it is queued, ringed while it waits for a sign-off, small for what ended in the last ten minutes. The card says which release and environment |
| "Standards: 9 met · 1 gap …" | Where the system stands on every standard of the fleet. The whole list, with the fleet's words for each, opens on demand: met, behind, gap, broken, not compared (with the declared reason), intended variance, observed, nothing to judge, not checked |

The box in the bar finds systems by what is typed: a system's name, what it is, its owner or one of its projects.
The sections beside the page scroll to their part of it; on a narrow screen they are left out.

## The landscape

The landscape is the first thing on the page (Jeffrey Palermo, 2026-10-09: "the landscape section should be first so
that the first thing I see is the pictorial shape of the different systems in the fleet"): who watches, the fleet's
oversight, the Azure subscription with every system in it, and below it what the systems share: Octopus Deploy, the
policies it reads, and the delivery standard.

The page draws it itself, from `fleet.json`, as boxes that wrap to the width of the screen. Until 1.0.33 it showed
the fleet's C4 drawing, which is 1,665 pixels wide whatever the screen and had to be scrolled sideways on a tablet;
PlantUML could not lay the same picture out narrower than about 1,270. Drawn here, it takes one row of systems on a
wide screen and as many rows as it needs on a narrow one, in the page's own colours and type: Clear Measure's navy
for a system, its deep navy for what the systems share, its primary blue for the operators, the frame of the
subscription and the arrows. A box's edge is the state of what it stands for, as the legend under it says. A system
that follows the kit's templates says "pulls the standard". The arrows of the C4 drawing became five sentences
between the rows, because ten arrows that all end in the same two boxes say less than "every system is released by
Octopus Deploy".

No box of the landscape does nothing (Jeffrey Palermo, 2026-10-08: "whatever the box represents I want to be able to
click and zoom into the view of that resource"). Octopus Deploy opens the instance, the delivery standard and the
policies open their repositories on GitHub, the fleet's box opens the registry, the operators' box the open findings,
and the frame of the subscription the Azure portal. These open in a new tab: Octopus, GitHub and Azure do not let
themselves be shown inside another page. The portal opens at the subscription the systems run in, which the
fleet's public data names since 2026-10-08 (`fleet.azurePortal`; the kit's decision 0027), and a system's card leads
to each of its resource groups there ("Azure: rg-...", under "cost, links"); a system the data names no group for
leads to the subscription. Data without that address opens the portal at the reader's resource groups. A
system that names neither a runtime view nor a dashboard opens its space in Octopus.

A click on a system's box in the landscape, or on its name on its tile, zooms into that system's runtime view (its own
dashboard where it names none): the dashboard loads in a frame over the box and grows to the whole screen, inside this
page. "Fleet", Escape and the browser's Back zoom out; the address carries the system's name after `#`. Each card
shows what every project runs in every environment, and what is broken. The rest (every standard, gaps, what is only
observed, intended variances, cost, links) opens on demand. A system that names a
public health address in the fleet's registry is asked from the reader's browser, so that line is true now and not
as of the last reading.

## The delivery structure

| Part | Here |
|---|---|
| Private build | `pwsh -NoProfile -File build.ps1`: one command, before a commit. Only it writes the build's facts, and the facts say so: `build.command`, and `build.ranBy` (`integration` in what is deployed) with the run's address |
| Integration build | `.github/workflows/build.yml` runs the same command on every pull request and commit |
| Static analysis | eslint and PSScriptAnalyzer, warnings as errors; the count is in the build's facts |
| Unit tests | `test/unit`: the model (`src/model.js`), with coverage of at least 90 percent of its lines |
| Integration tests | `test/integration`: the built site in a browser, with data the tests chose |
| Acceptance tests | `test/acceptance`: the deployed first environment, run by the release itself |
| Code metrics | `/build.json` of every deployed site: version, commit, lines of code, tests, coverage, complexity, analyzer |
| Health | `/health.json` of every deployed site; asked after every deployment |
| Deployments in flight | Workflow `deployments` publishes `deployments.json` on branch `deployments`: after every build and on a five-minute schedule (GitHub starts it every twenty to thirty minutes in practice); a run stays while something is executing and reads Octopus again every half minute, so a deployment it sees is followed to its end. `platform/promote.ps1` starts the workflow after the sign-off, so a promotion is seen too |
| Environments | `tdd` (every release, by itself), `uat` and `prod` (promotions, each after a sign-off) |
| Release | Octopus Deploy, space `cmfleet`, project `cmfleet-dashboard` |

## What it is made of

One storage account per environment that serves the site's files as a static website (`deploy/site.json`), created
by the release that first needs it. That is this system's own choice; the kit specifies how a system is delivered,
not what it is made of. Why this and not Static Web Apps on the Free plan, where it began: a subscription may have
ten of those, and the fleet's systems had used them up. A storage website has no such limit, costs cents a month,
keeps three separate environments, and is deployed by Octopus with no key.

What it cannot do: send headers of its own. Azure Storage does not support CORS on a static website, so a page of
another origin cannot read `/build.json` or `/health.json` here. The fleet health dashboard reads its own, which is
the same origin. A site whose files other pages must read needs another hosting.

A release is one package, `cmfleet-dashboard.<version>.zip`:

- `site/`: the files the environment serves
- `deploy/`: how it is deployed, verified and accepted (`deploy.ps1`, `verify.ps1`, `acceptance.ps1`)
- `acceptance/`: the acceptance tests

So a release carries the way it is deployed, and an old release deploys the way it did when it was built.

## The plumbing

`platform/set-platform.ps1`, run by the operator, safe to run again: the Octopus space and what is in it, a resource
group and a deploy identity per tier in Azure (`platform/azure.bicep`), and this repository's settings. Identities are
federated: GitHub to Octopus for the release, Octopus to Azure for a deployment. No secret is stored anywhere, and no
key opens the sites: shared keys are switched off on the storage accounts, and the release writes the files as the
tier's deploy identity.

A release reaches `tdd` by itself. To promote it, as the operator:

```bash
pwsh -NoProfile -File platform/promote.ps1 -Environment uat -Reason "what was checked in tdd"
pwsh -NoProfile -File platform/promote.ps1 -Environment prod -Reason "what was checked in uat"
```

The reason is the sign-off's note and stays with the deployment in Octopus.

## Working here

```bash
npm ci
npx playwright install chromium   # or: export CHROMIUM_PATH=/usr/bin/chromium
pwsh -NoProfile -File build.ps1
```

To look at the page with the tests' data: `node tools/shot.js src test/fixtures out/wall.png`. To look at a deployed
environment as a browser shows it: `node tools/shot-live.js <address> out/live.png`.
