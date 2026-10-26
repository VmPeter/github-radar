# GitHub Radar

A GoCD-inspired dashboard for personal use. Three views, switchable from the header:

- **Pull requests** — open PRs across a fixed list of repos, grouped by repo, with per-PR status (CI checks, review decision, mergeability).
- **Epics** — PRs across repositories grouped by their Jira epic, with ticket links and CI/review summaries.
- **Pipelines** — recent GitHub Actions workflow runs across repos, so you can see at a glance which changes are deployed to PROD and which are still **awaiting deployment** or **running**.

React + TypeScript SPA. Talks directly to the GitHub GraphQL + REST APIs from the browser using a personal access token stored in `localStorage`. The monitored repos/pipelines are configured per browser and also stored in `localStorage`. The optional Epics view uses a local Jira service included in the Vite development and preview servers.

## Setup

```bash
npm install
npm run dev
```

Open the printed URL, paste a fine-grained GitHub PAT into the first-run dialog, and you're in.

### Required PAT scopes

Use a **fine-grained PAT** scoped to only the repos in your configuration. Repository permissions:

- `Contents: Read`
- `Pull requests: Read`
- `Actions: Read` (for the Pipelines view)
- `Commit statuses: Read` (for PR CI status)
- `Metadata: Read` (implicit)

Create one at [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).

> The token lives in this browser's `localStorage`. That makes it readable by any XSS on this origin. Personal use only.

## Jira epics

Open **Epics → Connect Jira** and enter your Jira site URL. Jira Cloud uses your Atlassian email and an API token **without scopes**; Jira Data Center / Server uses a **Personal Access Token created in that Jira site's profile**, without an email. Automatic detection checks custom domains using Jira's server information, including Cloud aliases such as `https://jira.prod.vipps.io` → `https://vipps.atlassian.net`. Connection type can also be changed manually. Data Center context paths such as `/jira` are supported. The local service validates the connection and stores credentials in `.local/jira.json` with owner-only file permissions. This directory is ignored by Git and blocked from Vite file serving. Disconnect deletes the saved credentials. No Jira issues are changed.

Radar extracts issue keys from each PR's title, branch and description, follows Jira parents (including subtask → task → epic), and supports legacy Epic Link fields. PRs from all configured repositories appear under their epic, with Jira links, epic status, and CI/review summaries. A PR referencing multiple epics appears in each group. PRs with no issue, no epic, or failed lookups remain visible separately. Groups can be sorted by epic key, name, or latest PR activity. The existing PR filters still apply.

Lookups are cached locally for five minutes. **Refresh** reloads PRs and Jira mappings; **Retry Jira** retries unavailable issues. Jira Cloud scoped tokens are not supported. Data Center uses REST API v2 and bearer tokens; Cloud uses REST API v3 and email/token authentication. Run with `npm run dev` or `npm run preview`; a standalone static deployment cannot resolve Jira epics.

## Configuring repos

Open the **Config** button in the header to edit the JSON directly in the app. It is validated by Zod ([`src/config/schema.ts`](src/config/schema.ts)) and saved to this browser's `localStorage`, so each user keeps their own setup. "Reset to default" restores the bundled config.

The bundled default lives in [`src/config/repos.json`](src/config/repos.json) and is used as the seed whenever a browser has no saved config:

```json
{
  "teams": {},
  "groups": [
    {
      "name": "examples",
      "repos": [
        { "owner": "vercel", "name": "next.js" },
        { "owner": "facebook", "name": "react" }
      ]
    }
  ]
}
```

## Configuring pipelines

Pipeline tracking is configured in the **same** config (Config editor / [`src/config/repos.json`](src/config/repos.json) default). The workflow name is set **per repo** (workflow names differ across repos, so the name is repeated on each entry — that's expected). Shared settings like `branch`, `runsToShow`, and `prodEnvironment` live in a top-level `pipelineDefaults` block and can still be overridden per repo:

```json
{
  "pipelineDefaults": {
    "branch": "main",
    "runsToShow": 10,
    "prodEnvironment": "PROD"
  },
  "groups": [
    {
      "name": "core",
      "repos": [
        { "owner": "your-org", "name": "service-a", "pipeline": { "workflow": "Build and publish main" } },
        {
          "owner": "your-org",
          "name": "service-b",
          "pipeline": { "workflow": "Deploy", "branch": "release" }
        },
        {
          "owner": "your-org",
          "name": "service-c",
          "pipeline": { "enabled": false }
        }
      ]
    }
  ]
}
```

Per-repo `pipeline` fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `workflow` | _(required per repo)_ | Workflow display name or file name to match (e.g. `Build and publish main` or `build-and-publish.yml`) |
| `branch` | `main` (from `pipelineDefaults`) | Branch whose runs to track |
| `runsToShow` | `10` (from `pipelineDefaults`) | Upper bound of recent runs to fetch (see truncation note below) |
| `prodEnvironment` | `PROD` (from `pipelineDefaults`) | Display label for the production target |
| `enabled` | `true` | Set to `false` to hide this repo from the Pipelines view |

A repo appears on the Pipelines view only if it has a `workflow` set and is not disabled. You can still put a `workflow` in `pipelineDefaults` as a fallback if most repos share the same name.

### Monitoring multiple pipelines from one repo

Use a `pipelines` array instead of a single `pipeline` to track several workflows from the same repo (each renders as its own section):

```json
{
  "owner": "your-org",
  "name": "multi-service",
  "pipelines": [
    { "workflow": "service-one", "branch": "master" },
    { "workflow": "service-two", "branch": "master" }
  ]
}
```

Each array entry takes the same fields as `pipeline` and inherits any unset field from `pipelineDefaults`. Entries are de-duplicated by `workflow` + `branch`.

### Pipeline status semantics

Status is derived from each workflow run's `status` / `conclusion`:

| Color | State | Meaning |
| --- | --- | --- |
| green | In PROD | Run completed successfully (deployed) |
| orange | Awaiting deployment | Waiting on a deployment approval / environment protection rule |
| yellow | Running | Queued or in progress |
| red | Failed | Failed, timed out, or startup failure |
| gray | No deployment | Cancelled / skipped / stale |

The per-repo header shows how many runs are still awaiting PROD, or "Up to date" when everything has shipped.

The list is truncated to everything **up to and including the first run that reached PROD** — older runs are already shipped and hidden. `runsToShow` is only the upper bound fetched from GitHub; if PROD isn't reached within that many runs, all fetched runs are shown.

## Scripts

- `npm run dev` -- Vite dev server
- `npm run build` -- typecheck + production build to `dist/`
- `npm run preview` -- serve the production build
- `npm run typecheck` -- TS only, no emit

## Architecture

- Single-page React app, no router
- TanStack Query for caching; one paced rolling queue refreshes the active view (paused on hidden tabs)
- Lightweight count queries followed by 25-PR cursor pages, rotated across repos; per-repo errors are isolated
- Status derivation lives in [`src/lib/status.ts`](src/lib/status.ts) and drives the colored status bar on each card

## Status semantics

**Can review** includes PRs where your approval can contribute to an unmet review requirement, **or** you have an outstanding request directly to your username. A team request alone does not qualify. Radar checks your repository access, effective organization/repository rules and classic branch protection, counted reviews, base-branch CODEOWNERS and required reviewing teams. It excludes drafts, your own PRs and already-counted approvals, unless directly requested again. Both Pull requests and Epics use the same filter, and existing saved personal-filter selections migrate automatically.

This filter means your approval can help, not necessarily finish every review requirement. Last-push-only eligibility cannot be confirmed from the exposed GitHub data. Missing permissions, incomplete results, invalid CODEOWNERS and other unresolved cases show **Eligibility unknown** and are listed separately when the filter is active. Direct username requests remain visible even if rule lookup fails. Membership and rule caches reset each refresh; search indexing can briefly lag changed requests. Reading rules and private team membership may require additional token access; Radar never assumes membership when a lookup fails.

CODEOWNERS uses [GitHub ownership rules](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners); reviewing-team file patterns follow [ruleset gitignore matching](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

| Color | Meaning |
| --- | --- |
| green | Checks passing AND review approved |
| yellow | Checks running / awaiting review |
| red | Any required check failing |
| orange | Changes requested by reviewer |
| gray | Draft, or no signals available |

## Rolling refresh

The default interval is **10 minutes**. On opening either view, Radar warms up with up to four targets in parallel: the first 25 open PRs per repository or the configured pipeline history. It then continues every remaining page in the background. Later sweeps count open PRs first and rotate 25-PR pages across repositories until all finish. If a sweep takes longer than the interval, the next starts immediately; otherwise it waits the remaining time. GitHub rate limits can delay progress. There is no 100-PR total cap.

Existing cards stay visible during refresh. Partial pages update cards in place; counts never clear cached cards. New data updates them; closed PRs disappear after that repository finishes loading. Failed pages retain existing data. **Refresh** queues a sweep; **Off** stops periodic refresh. Filters and interval choices are remembered in this browser.

Pipeline summaries use the latest run, counting one awaiting deployment per workflow/branch. The newest and oldest/latest successful matching runs stay visible; intermediate matching runs start collapsed between them.

PR cards show **Approved**, or **Ready to merge** when approval, passing CI and known mergeability agree. Failing/errored CI makes the bar red, including drafts. GitHub verifies final merge requirements. Hover, focus or tap **Checks** for named results; details load only when opened and include check runs and commit statuses.
