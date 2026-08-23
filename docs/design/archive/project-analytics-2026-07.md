# project analytics view — design

> **Status:** proposal

## What we're solving

The project detail page (`ui/src/views/projectDetail.json`) today is
aggregate-only: metric tiles, a 7d period-comparison trend, and a per-task
**lifetime** aggregate table. The owner wants a project drill-in that answers
five single-dev questions (dashboard lens: "dig into the projects I own", "did
MY perf improve", flaky, one-click debug):

1. **All tasks OVER TIME** — spot per-task outliers, spikes, trends (time-series,
   not just lifetime aggregates).
2. **One-click debug** — logs + artifact for each execution of those tasks.
3. **Rank vs OTHER projects** — failure rate, duration, hit rate.
4. **Failures vs successes** — clear counts, and over time.
5. **First-noticed across branches** — which branch a task first started failing
   on, and when.

Everything must be windowed by the just-shipped `?window` selector and stay
pure-JSON-view-able.

## Access pattern

- One project, opened from `/projects`. Route param `name`, query `?window`.
- Reads only (no ingest path change). Every read is `WHERE workspace_id=$ws AND
project=$project AND started_at>=$since` — partition-pruned by `started_at`,
  clamped to one project, so each read touches a thin slice of `task_runs` even
  at 50-100M rows/day. No unbounded raw-row fetch; every series/percentile
  aggregates in SQL (the `periodStats`/`getRunTrends` pattern).
- Polled at the standard analytics cadence (30s); windowed sources re-fetch when
  `?window` changes (the loader keys sources on params+window — already proven).

## Options considered (briefly)

- **A. One mega-query per page.** Rejected — couples five independent cards, hard
  to bound/test, and defeats the loader's per-source refetch/gating.
- **B. All-new project-scoped queries.** Rejected — four of the five asks are
  already served by existing queries with a `project` filter or a client-side
  rank. Only #5 (first-noticed-per-branch) has no existing shape.
- **C. Reuse + two net-new queries, phased.** **Chosen.** Ship #2/#3/#4 +
  windowing by reuse and ONE new query (#5) in phase 1; the richest per-task
  time-series (#1) as one more new query + one small component in phase 2.

## Recommendation

Reuse aggressively; add exactly **one new SQL query in phase 1**
(`getProjectBranchFailures`, the #5 marquee) plus a one-line `project` filter on
`getRunTrends`. Defer the per-task sparkline series (`getProjectTaskTrends`) and
its `SparkList` component to phase 2. Window the whole page with the existing
`windowDaysOf`/`trendArgsOf` helpers and a `TimeframeSelect` in the view header.

Mapping of asks → data source:

| Ask                                            | Source                                                                                        | New?                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| #2 recent executions + logs/artifact           | `listRuns({project,limit})`, rows deep-link `/runs/{id}?task=…` (logs) + hash→`/cache/{hash}` | reuse                                          |
| #3 rank vs other projects                      | `listProjects(500)` + client rank, current project highlighted                                | reuse (P1); windowed `getProjectRankings` = P2 |
| #4 failures vs successes over time             | `getRunTrends({bucket,from,to,project})`                                                      | +`project` filter (1 line)                     |
| #1 tasks over time (lifetime + Δ)              | `getHistory({project})` ⨝ `getPeriodComparison({project}).movers` for the Δavg column         | reuse (P1)                                     |
| #1 tasks over time (true per-bucket sparkline) | `getProjectTaskTrends`                                                                        | **new (P2)**                                   |
| #5 first-noticed across branches               | `getProjectBranchFailures`                                                                    | **new (P1)**                                   |
| windowed trend tiles                           | `getPeriodComparison({project, windowDays})`                                                  | reuse; make `projectTrend` read `?window`      |

## Concrete spec

### New query 1 (P1) — `getProjectBranchFailures`

```
getProjectBranchFailures(
  workspaceId: string,
  project: string,
  args: { sinceDays?: number; limit?: number } = {},
): Promise<ProjectBranchFailure[]>

interface ProjectBranchFailure {
  task: string
  firstBranch: string            // the branch that failed FIRST (rank 1)
  firstFailedAt: number          // when it was first noticed, anywhere
  firstCommit: string | null     // commit on the first-failing run
  lastFailedAt: number
  branchesFailing: number
  branches: { branch: string; firstFailedAt: number; firstCommit: string | null; failures: number }[]
}
```

ONE set-based query — earliest failing run per (task, branch), then rank
branches per task by that timestamp:

```sql
WITH failed AS (
  SELECT r.task AS task, inv.branch AS branch,
         MIN(r.started_at)::bigint                                    AS first_failed_at,
         (ARRAY_AGG(inv.commit_sha ORDER BY r.started_at ASC))[1]     AS first_commit,
         MAX(r.started_at)::bigint                                    AS last_failed_at,
         COUNT(*)::int                                                AS failures
  FROM task_runs r
  JOIN invocations inv ON inv.run_id = r.run_id AND inv.workspace_id = ${ws}
  WHERE r.workspace_id = ${ws} AND r.project = ${project}
    AND r.started_at >= ${since} AND r.status = 'failed'
    AND inv.branch IS NOT NULL
  GROUP BY r.task, inv.branch
)
SELECT task, branch, first_failed_at, first_commit, last_failed_at, failures,
       ROW_NUMBER() OVER (PARTITION BY task ORDER BY first_failed_at ASC, branch ASC) AS branch_rank
FROM failed
ORDER BY task, first_failed_at ASC
```

JS folds rows per `task`: `branch_rank = 1` → `firstBranch`/`firstFailedAt`/
`firstCommit`; the rest fill `branches[]`; `branchesFailing = branches.length`.
Sort tasks by `firstFailedAt` DESC (most recent regressions first), slice
`limit` (default 25, clamp ≤200), cap `branches` at `BRANCH_CAP` (12) like
`getRegressions`.

- **Clamp:** `since = now − clampInt(sinceDays,1,MAX_WINDOW_DAYS)·86.4e6`,
  `sinceDays` from `windowDaysOf(p,14)`.
- **Scale:** reads only `status='failed'` rows (a small fraction of the corpus)
  for one project in the window; the `inv` join is on `run_id` (indexed). Output
  bounded by (failing tasks × failing branches). Benefits from the deferred
  `task_runs WHERE status='failed'` partial index the decision log already tracks
  (needs a `CREATE INDEX CONCURRENTLY`-capable migration); until then project +
  window keep the scan thin. **No N+1** — one query for every task/branch.

### Query extension (P1) — `getRunTrends` gains `project?`

Add `project?: string` to the args and one `AND project = ${project}` to the
`WHERE`. Serves #4 as a project-scoped runs/failures/hits time-series (already
returns `runs`, `failures`, `hits`, `totalDurationMs` per bucket). Bucket count
stays clamped by `MAX_TREND_BUCKETS`; byte-identical when `project` is absent.

### New query 2 (P2) — `getProjectTaskTrends`

```
getProjectTaskTrends(
  workspaceId, project,
  args: { bucket?: 'hour'|'day'; from?; to?; limit? } = {},
): Promise<ProjectTaskTrendPoint[]>          // flat long-format rows

interface ProjectTaskTrendPoint {
  task: string; t: number; runs: number; failures: number
  avgDurationMs: number; p95DurationMs: number | undefined
}
```

```sql
WITH top AS (   -- bound the task set (a project rarely has many, but be safe)
  SELECT task FROM task_runs
  WHERE workspace_id=${ws} AND project=${project} AND started_at>=${from} AND started_at<=${to}
  GROUP BY task ORDER BY SUM(duration_ms) DESC LIMIT ${clampInt(limit,1,50)}
)
SELECT r.task,
       (r.started_at / ${bucketMs}::bigint) * ${bucketMs}::bigint AS t,
       count(*)::int AS runs,
       SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END)::int AS failures,
       COALESCE(round(avg(r.duration_ms) FILTER (
         WHERE (r.cache_hit IS NULL OR r.cache_hit=false) AND r.status='success')),0)::int AS avg_dur,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms) FILTER (
         WHERE (r.cache_hit IS NULL OR r.cache_hit=false) AND r.status='success'))::int AS p95
FROM task_runs r JOIN top USING (task)
WHERE r.workspace_id=${ws} AND r.project=${project} AND r.started_at>=${from} AND r.started_at<=${to}
GROUP BY r.task, t ORDER BY r.task, t
```

Output bounded by `top` (≤50 tasks) × `MAX_TREND_BUCKETS`; percentiles in SQL, no
raw-row stream. `data.ts` groups the long rows into one `series: number[]` per
task (bucket-filled) → feeds `SparkList` (below). A pivot to a wide multi-series
`LineChart` is avoided — task names are dynamic and a pure-JSON `series[]` is
static; the per-row sparkline is the correct shape for "spot per-task outliers".

### Routes (`analytics-routes.ts`, query-param style, ws-clamped)

- P1: `GET /v1/branch-failures?project=&sinceDays=&limit=` →
  `getProjectBranchFailures`; add `project` passthrough to `/v1/trends/runs`.
- P2: `GET /v1/trends/tasks?project=&bucket=&from=&to=&limit=` →
  `getProjectTaskTrends`.

All read the same `ws` the existing reads resolve; single-segment additions to
`isAnalyticsSurface` if the allowlist gates them (mirror `/v1/regressions`).

### `data.ts` sources (P1)

```
projectRecent:         (p) => listRuns({ project: p.name, limit: 100 }).then(withTaskRef)
projectFailureTrend:   (p) => getRunTrends({ ...trendArgsOf(p), project: p.name }).then(r => r.points)
projectRankings:       (p) => listProjects(500).then(ps => rankProjects(ps, p.name))  // sort+mark+percentile
projectBranchFailures: (p) => getProjectBranchFailures(p.name, windowDaysOf(p,14))    // + _branchList/_firstWhen/_dirReg
// existing, now windowed + Δ-enriched:
projectTrend: (p) => scopedTrend({ project: p.name }, windowDaysOf(p,7))
projectTasks: (p) => Promise.all([getHistory({project:p.name}), getAnalysis(windowDaysOf(p,7),1,200,{project:p.name})])
                       .then(([h,cmp]) => mergeMoverDelta(h, cmp?.movers))  // adds _deltaAvgLabel/_deltaTone per task
```

`scopedTrend` gains a `windowDays` param (defaults 7 — pages without the selector
stay byte-identical). `rankProjects`/`mergeMoverDelta` are pure `data.ts`
helpers (the established "shape raw rows so the JSON binds flat fields" pattern).

### New component (P2 only) — `SparkList`

`ui/src/jr/components.tsx`: `SparkList({ items, labelKey, seriesKey, valueKey,
valueFormat, dots, rowTaskRef })` — a row per task: label · inline SVG sparkline
of `item[seriesKey]` (number[]) · latest value · a failure/`delta` dot. Reuses
the existing `Dot`/`DotMap` + palette. Views stay pure JSON (the row carries its
`series` array from `data.ts`). No other component is needed — LineChart,
DataTable, RankList, Metric, Card, Grid cover P1.

### View layout (ASCII wireframe)

```
┌ project: <name>                                    [24h][7d][30d][90d] ┐  TimeframeSelect (new, reused from Insights)
├───────────────────────────────────────────────────────────────────────┤
│ [runs] [total time] [time saved] [hit rate] [cache]        metrics-5   │  existing summary tiles
│ [avg exec ▲Δ] [failure rate Δ] [runs Δ] [hit rate Δ]  windowed trend   │  existing projectTrend (now ?window-driven)
├──────────────────────────────────┬────────────────────────────────────┤
│ Failures & runs over time (#4)    │ How this project ranks (#3)         │
│  stacked LineChart                │  RankList of projects, THIS one     │
│  runs · failures · hits / bucket  │  highlighted · failRate/avg/hit     │
├──────────────────────────────────┴────────────────────────────────────┤
│ Where failures were first noticed — across branches (#5)  ● regressed  │  NEW getProjectBranchFailures
│  DataTable: task | first branch | when | commit | #branches | branches │
│  row → /tasks/{project#task}                                           │
├───────────────────────────────────────────────────────────────────────┤
│ Tasks — lifetime + Δ vs prior window (#1)                              │  getHistory ⨝ movers
│  DataTable: task | runs | success | hit | avg | p99 | Δavg | last      │
│  row → /tasks/{id}          (P2: + inline SparkList duration trend)     │
├───────────────────────────────────────────────────────────────────────┤
│ Recent executions (#2)                                                 │  listRuns({project})
│  DataTable: when | task | status | duration | hash                     │
│  row → /runs/{runId}?task={project#task}  (logs open) · hash→/cache/…  │
├───────────────────────────────────────────────────────────────────────┤
│ Resolved config (existing, unchanged)                                  │
└───────────────────────────────────────────────────────────────────────┘
```

## Phasing

| Phase         | Ships (asks)                                                                                                           | New server                                                                                                  | New UI                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **1**         | windowing; #2 recent executions; #3 client rank; #4 failures-over-time; #5 first-noticed; #1 lifetime table + Δ column | `getProjectBranchFailures`; `getRunTrends` +`project` filter                                                | `TimeframeSelect` on the view; `rankProjects`/`mergeMoverDelta` data helpers (reuse LineChart/DataTable/RankList) |
| **2**         | #1 true per-task per-bucket sparklines; regressed/still-failing flag on #5                                             | `getProjectTaskTrends`; enrich #5 with ever-passed + latest-per-branch status (reuse `getRegressions` CTEs) | `SparkList` component                                                                                             |
| **3** (later) | branch facet on recent executions; per-branch execution drill                                                          | `listRuns` + `invocations` branch join                                                                      | branch chips (Runs-facet pattern)                                                                                 |

## Scale hazards

- **No unbounded raw-row fetch.** Every new/extended query aggregates in SQL
  (counts, `percentile_cont`, bucketing) and is clamped to one project + a
  `started_at`-pruned window. Bucket loops bounded by `MAX_TREND_BUCKETS`; task
  fan-out bounded by the `top`/`limit` CTE.
- **#5 reads the failed subset only** — small vs the passing majority, but wants
  the deferred `task_runs WHERE status='failed'` partial index (CONCURRENTLY
  migration) to prune at extreme scale; project+window bound it meanwhile.
- **#3 rank** is client-side over `listProjects` (already one GROUP BY) — no new
  scan. A windowed variant (P2) adds one clamped GROUP BY, not per-project N+1.
- **listRuns recent-executions** is capped at 100 rows and ordered by the
  `started_at` index — never a full partition scan.

## What's out of scope

- Cross-machine / hermeticity per project (lives in the Insights hermeticity
  card).
- Cost/CI-minutes accounting, per-user attribution (org-analytics, not the
  single-dev lens).
- Live in-progress task streaming (the run cockpit owns "see it run").
- Windowing the **lifetime** aggregate table by `?window` — kept all-time on
  purpose (the "over time" story is the trend/sparkline cards); a windowed
  `getHistory` is a separate, deliberately-unmade change.
- Any ingest / schema / wire change — this is read-side only.

## Open questions

- #5 "regressed vs always-broken" + "still failing?" needs a second aggregate
  (ever-passed-before-first-fail, latest-per-branch status). Fold into
  `getProjectBranchFailures` as a P2 enrichment, or join the workspace
  `getRegressions` client-side? Recommend the P2 in-query enrichment (reuses the
  proven `windowed`/`passedSet` CTEs) so the card is self-contained.
- Rank scope: rank by failure rate, avg duration, or a composite? Recommend three
  separate mini-rank rows (failRate / avg / hit) so the dev reads each axis — no
  opaque composite.
- Trunk-scoping: analytics stays per-branch by design (decision log
  2026-07-14) — #5's per-branch view is exactly what the owner wants, so no
  trunk clamp here.

## Why this is the right move

- **Heavy reuse, one net-new query in P1.** Four of five asks land by reusing
  `listRuns`/`listProjects`/`getRunTrends`/`getPeriodComparison` with a filter or
  a client rank; only #5 has no existing shape.
- **#5 is one set-based CTE** — earliest-failing-run-per-(task,branch) + a
  `ROW_NUMBER` rank — no per-task/per-branch fan-out, partition-pruned, follows
  the codebase's set-based pattern exactly.
- **Windowed by the proven mechanism** — the `?window` params-refetch path the
  Insights selector already ships; the project page becomes shareable + windowed
  with zero new plumbing.
- **Pure-JSON, single new component** — P1 needs none; P2 adds only `SparkList`,
  and views stay data-only.
- **Serves the single-dev lens directly** — dig into an owned project (#1/#3),
  did-my-perf-change (#4 + Δ column), flaky/broke (#5), one-click to logs +
  artifact (#2) — each card ≤1 click from the dev's evidence.
