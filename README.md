# cmfleet-dashboard

The fleet health dashboard: every system of the fleet on one page, for operators who act on what it shows. It is the
one application of the system `cmfleet`, the fleet's own system.

The fleet is declared and overseen in
[demo-environment-kit](https://github.com/clearmeasure-aisf-sample-apps/demo-environment-kit) (`fleet/`). Its workflow
`fleet` writes what it finds every six hours and publishes it:
[fleet.json](https://clearmeasure-aisf-sample-apps.github.io/demo-environment-kit/fleet.json) and
[landscape.svg](https://clearmeasure-aisf-sample-apps.github.io/demo-environment-kit/landscape.svg). This page reads
those two files in the reader's browser and draws them. Nothing is pushed into this repository, and the page has no
server of its own.

## What the page says

| On the page | Means |
|---|---|
| Gray | As declared. The normal state has no colour |
| Amber, "Needs attention" | Something that worked has stopped: a failed deployment or check, an environment left behind, a stale proof |
| Red, "Production affected" | The last deployment to production failed, or a service every system depends on is out |
| Dashed, "Not read" | The fleet could not read the system, or its data is older than two of its six-hourly readings |
| Dotted, "Asleep" | Switched off on purpose |
| "1 gap" | Something the system never had, such as code metrics. Counted, never coloured: colour is for what stopped working |

A system's box in the landscape and its name on its tile open that system's runtime view (its own dashboard where it
names none). Each tile shows what runs in production and for how long, and what is broken. The rest (every release in every
environment, gaps, what is only observed, intended variances, cost, links) opens on demand. A system that names a
public health address in the fleet's registry is asked from the reader's browser, so that line is true now and not
as of the last reading.

## The delivery structure

| Part | Here |
|---|---|
| Private build | `pwsh -NoProfile -File build.ps1`: one command, before a commit |
| Integration build | `.github/workflows/build.yml` runs the same command on every pull request and commit |
| Static analysis | eslint and PSScriptAnalyzer, warnings as errors; the count is in the build's facts |
| Unit tests | `test/unit`: the model (`src/model.js`), with coverage of at least 90 percent of its lines |
| Integration tests | `test/integration`: the built site in a browser, with data the tests chose |
| Acceptance tests | `test/acceptance`: the deployed first environment, run by the release itself |
| Code metrics | `/build.json` of every deployed site: version, commit, lines of code, tests, coverage, complexity, analyzer |
| Health | `/health.json` of every deployed site; asked after every deployment |
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
