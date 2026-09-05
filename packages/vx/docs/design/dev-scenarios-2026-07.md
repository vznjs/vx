# Developer scenarios — one dev inside a huge monorepo (2026-07)

Owner ask: _"Create development scenarios. As a developer working locally in a
huge monorepo owning some of the projects and being part of teams, and when
working on PRs. What information do you need to assess your or its effect,
debug failures/flakiness, what information do you need to maintain the shape of
your projects, track them over time, compare to others. Shape real-life
experiences, then look for ideas and solutions and implement."_

Method: each scenario is a concrete moment in a real day. For each: the
questions the developer actually asks, the data needed to answer them, what vx
/ vx-cloud answers **today** (verified against the shipping surfaces), the gap,
and the solution. A ranked build list closes the doc.

**The cast.** Mira owns `packages/checkout` and `packages/payments-sdk` — two
of ~1,800 projects in the workspace (~5,400 tasks). She's on the Payments team,
ships several PRs a week, and reviews others'. CI runs vx with a shared remote
cache and distributed agents; the team self-hosts the vx-cloud platform. The
default branch is `main`.

---

## S1 · Morning triage — "did anything I own break while I was away?"

**The moment.** 9:04, coffee, dashboard open. 1,800 projects produce a wall of
green and red that is mostly other people's.

**Questions.** Is `checkout`'s latest `main` run green? Did anything in MY
projects start failing or get slower since yesterday? Is anything of mine newly
flaky?

**Data needed.** Latest trunk outcome per owned project; regressions/movers
scoped to owned projects; flaky list scoped the same way.

**Today.** The notifications bell (workspace-wide broken runs), Runs facets
(filter by ONE project at a time), Insights regressions + movers
(workspace-wide), the project drill-in (one project at a time). Everything
exists — but nothing knows which projects are HERS. At 1,800 projects the
signal is drowned; she tab-cycles two drill-ins every morning.

**Gap → solution: pinned projects ("my projects").** Let a dev star projects
(persisted like the notification watermark — per origin+workspace). Pins scope
a landing strip (latest trunk status + failures + biggest deltas across pinned
projects only) and a notifications filter ("mine first"). No org/team
machinery — the personal lens the dashboard's product directive already names.

## S2 · Pre-flight — "what will this change cost CI?"

**The moment.** Mira touched `payments-sdk/src/client.ts` and wants to know
the blast radius before pushing: what re-runs, how long, does she have time
for review before standup.

**Questions.** Which tasks does this diff invalidate (dependents included)?
How long will the affected set take? Will the remote cache absorb most of it?

**Data needed.** Affected task set; predicted hit/miss per task; per-task
typical duration (p50) + the critical path through the affected subgraph.

**Today.** `vx run <task> --affected --dry` gives the exact set and a
hit/miss prediction (real existence probe). It does NOT predict time — the
plan shows what runs, never how long.

**Gap → solution: durations on the plan.** The local history provider already
computes per-task p50 for predictive scheduling (opt-in). Fold it into the
`--dry` plan output: per-task `~p50` and a predicted wall-clock (critical path
over predicted misses). Zero new data collection — a presentation of history
the cache.db already holds.

## S3 · Red PR — "is this failure mine?" (the sharpest moment of the week)

**The moment.** CI on Mira's PR is red: `orders#test` failed. She did not
touch `orders`. The next 20 minutes decide whether she reverts, retries,
or files a flake — and today those 20 minutes are manual archaeology.

**Questions, in the order she asks them.**

1. What failed, with what output? _(answered: run detail names failures, task
   logs are one click)_
2. **Did I cause it?** Three mutually exclusive explanations:
   - **Flaky** — the same task with the SAME cache key (identical inputs) has
     succeeded elsewhere → nondeterminism, not her change.
   - **Already broken** — `main`'s latest run of this task also fails → she
     inherited it.
   - **New failure** — the key first appeared with her change and has only
     failed → probably hers; the why-panel's `inputs changed` tells her
     whether her diff altered the task's inputs.

**Data needed.** Same-key outcome history (in `task_runs.hash`), the default
branch's latest outcome for the task (in `task_runs` × `invocations.branch =
default_branch`), key-changed-vs-previous (the why panel's comparison). ALL
of it is already in Postgres — no surface connects the three signals **at the
failure**, so devs cross-reference the flaky list, the regressions card, and
the why panel by hand.

**Gap → solution: failure triage, batched per run.** One
`GET /v1/triage/:runId` classifies every failed task — `flaky` (N same-key
successes exist) / `pre-existing` (default branch's latest run of the task is
also failing) / `new-failure` (first failure of this key; notes whether the
key changed) — with evidence links (the trunk run, the previous run). The
run-detail page shows a "Failed-task triage" card; each verdict is one glance.
**Implemented in this wave.** Follow-up: carry the verdicts into the GHA check
summary (`github-check.ts` already posts per-task rows on the PR).

## S4 · Flake war — "prove it, then kill it"

**The moment.** `checkout#e2e` fails ~5% of runs. Mira needs to prove it's
flaky (not blame-worthy), find when it started, and fix or quarantine it.

**Today.** Strong: the flaky list requires a REAL nondeterminism signal —
a within-run retry (confirmed) or a same-key fail+pass (`mixedOutcomeKeys`,
this wave) — so "failed once on a broken commit" no longer smears a task as
flaky. Per-run logs for each failure are one click; hermeticity catches
machine-dependent keys.

**Gap (minor).** No trend: is the flake getting better or worse, when did it
first appear? Ranked low — the current list + logs answer the acute need.
**Shipped**: the task-detail Flakiness-trend card (per-day episodes,
first/last seen, direction verdict) via `/v1/flake-trend`.

## S5 · Shape over time — "my project got slower this quarter"

**The moment.** Quarterly health check: `checkout`'s CI feels slower than in
May. Where did the time go, which task, when did it step?

**Today.** Strong: the project drill-in has the failures/runs trend, per-task
duration sparklines, a period-over-period Δavg column, movers, and a
timeframe selector (24h–90d). The task detail shows duration history with
percentiles.

**Gap.** Nothing NOTIFIES; she must go looking. A "got slower" signal —
latest executed duration ≥2× the task's own p50 (with an absolute floor) —
belongs on Insights beside movers, giving the passive surface an active
edge. Ranked mid; the parked astryx app's Attention page has the exact
detector to port.

## S6 · Standing in the crowd — "is my project's health normal here?"

**Questions.** Is `checkout`'s failure rate / cache hit rate / avg exec
duration typical for this workspace or an outlier?

**Today: covered.** The project drill-in's three-axis rank card (failure
rate, avg exec, hit rate — top-8 per axis + own true rank highlighted).

## S7 · Cache hygiene — "why does my task keep missing?"

**Questions.** What in the key changed? Is the task hermetic? Is the remote
cache actually serving me?

**Today: covered.** `vx why` locally (exact component diff), the batched
why-panel on every run, `/cache/:hash` provenance, hermeticity divergence
naming exact paths, hit-split local/remote. The per-file diff staying local
(entry_inputs lives in cache.db) is a documented, accepted asymmetry.

## S8 · Team lens

Teams exist as schema metadata only; the owner's product lens is explicitly
the single dev. Personal pins (S1) are the deliberate v1 of "my team's
stuff" — a shared team scope stays out until the owner asks.

---

## Ranked build list

1. **Failure triage on run detail** (S3) — `/v1/triage/:runId` + verdict
   card. **Shipped with this doc.**
2. **Pinned projects** (S1) — personal scope for the landing + notifications.
   **Shipped** (PR #158).
3. **"Got slower" detector on Insights** (S5) — port the astryx Attention
   detector onto the shipping UI. **Shipped.**
4. **Plan-time duration prediction** (S2) — p50 + predicted wall on `--dry`.
   **Shipped** (PR #160).
5. **Triage verdicts on the GHA check** (S3 follow-up) — the PR page says
   "flaky / pre-existing / yours" without opening the dashboard. **Shipped**
   (PR #161).
6. **Flake trend / first-seen** (S4) — low. **Shipped.**
