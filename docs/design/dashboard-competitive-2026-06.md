# Dashboard competitive analysis + improvement plan (2026-06)

Research synthesis from a six-agent parallel sweep of monorepo/build dashboards
(Nx Cloud, Turborepo/Vercel, Gradle Develocity, BuildBuddy/Bazel, a second-tier
roundup — Moon/Rush/Lage/Wireit/Earthly/Depot/Namespace/Blacksmith/WarpBuild —
and an inventory of our own `apps/ui` + `serve.ts` + `metrics.ts` + `cache.db`).
This doc records what they have, what we already have, the gap, and the ranked
plan. Per-source detail lives in the research transcripts; this is the decision
record.

## 1. What the field does (condensed)

| Capability                                               | Who does it well                                                                                        | Notes                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cache-miss "why" — name the exact input that changed** | Develocity (the moat), Turbo `--summarize`, BuildBuddy AC-miss compare                                  | The single most-cited, most-valuable feature. Diff last-hit vs current-miss inputs; hide what matched; show the one property that differed. |
| **Compare two runs side-by-side**                        | Develocity build comparison, BuildBuddy compare-invocations/actions                                     | Diffs task outcomes, durations, cache status, inputs, flags.                                                                                |
| **"Time saved" as the hero number (+ counterfactual)**   | Turbo `timeSaved`, Develocity avoidance savings, moon "savings/loss", Depot "time saved / cost avoided" | Smaller tools make ROI the top-line, not a footnote. moon computes a counterfactual ("projected time without moon").                        |
| **Critical path as a first-class object**                | BuildBuddy/EngFlow, Lage `--profile`, Earthly Timings                                                   | Longest dependency chain = the wall-time floor; clickable, highlighted in the flamegraph.                                                   |
| **Parallelism gaps / "ready-but-waiting"**               | Turbo community viewer (nullvoxpopuli), Lage worker lanes                                               | Distinguish "blocked on a busy worker" (raise `-c`) from "blocked on deps" (fix the graph).                                                 |
| **Per-task duration sparkline + regression sort**        | Nx Enterprise Task Analytics                                                                            | "Task X got slower" via avg/max + inline sparkline.                                                                                         |
| **Flaky detection from cache identity**                  | Nx (deterministic), Develocity, BuildBuddy                                                              | Same input hash, fail-then-pass ⇒ flaky. Principled, no ML.                                                                                 |
| **Cache-entry inventory, filterable by key + last-hit**  | Blacksmith, Turbo analytics forks                                                                       | Answers "is my cache key actually hitting?"; surfaces cold/never-rehit entries.                                                             |
| **Local vs remote hit-rate split**                       | moon, WarpBuild                                                                                         | Blended hit-rate hides which one is failing (dev iteration vs CI).                                                                          |
| **Commit/PR-centric run grouping (CIPE)**                | Nx Cloud                                                                                                | Top-level object = a pipeline invocation with git metadata, not raw task rows.                                                              |
| **PR-comment as the dashboard**                          | moon run-report-action                                                                                  | A markdown table with savings + touched files, where devs already look.                                                                     |
| **OTLP / standards export**                              | Turbo 2.9 (`experimentalObservability`)                                                                 | Emit standard telemetry, let teams bring Grafana/Datadog. Fits our plugin `eventSink`.                                                      |
| **Self-healing CI / AI fix**                             | Nx Cloud                                                                                                | Out of scope for us (trust + cost + infra).                                                                                                 |
| **Predictive test selection / test distribution**        | Develocity, Nx Atomizer                                                                                 | Out of scope (ML model, test-level granularity we don't record).                                                                            |

## 2. What we already have (inventory highlights)

- Pages: Overview, Projects (+detail), Tasks (+detail), Runs (+detail), Bottlenecks, Trends, Cache, and a live **Run cockpit** (`/#/run`) with a DAG + flamegraph toggle.
- A rich read-only query layer (`src/orchestrator/metrics.ts`, ~22 functions) over `cache.db`, served as `/v1/*` JSON by `packages/cloud/src/cli/serve.ts`.
- **Already built, NOT surfaced in any view** (the low-hanging fruit):
  - `whyDidThisRerun` + `GET /v1/why/:runId/:taskId` — compares a run's task hash to the previous run's and flags `hashChanged`. **Zero UI.** This is ~80% of the field's #1 feature.
  - `explainCacheKey` + `GET /v1/explain/:taskId` — has an `api.ts` wrapper, **no view consumes it**.
  - `getCacheSavings` (time saved), `getFlakiestTasks` (flaky), `getParallelismHistory` (effective parallelism) — powering some pages but under-surfaced.
  - `forward_args` column, ns-precision wallclock spans — recorded, never shown.
- **Data-model gaps** (block the deepest features; require schema work): no git/commit/branch/CI context on runs; no persisted per-run input fingerprints (inputs are folded into the hash and discarded — so a _full_ "which file changed" diff isn't possible yet, only the hash-changed signal); no invocation header table; no remote-transfer bytes; no persisted DAG edges (historical critical path can't be reconstructed; live-run critical path can).

## 3. Ranked plan

Tiers by effort/risk. Tier 1–2 change **no** cache key or artifact format (no
`CACHE_VERSION`/`SCHEMA_VERSION` bump). Tier 3 needs schema work and is deferred
to a follow-up so this wave stays low-risk and shippable.

### Tier 1 — wire existing backend (fast, flagship, no schema change)

1. **"Why did this re-run?"** — surface `whyDidThisRerun` in the run-detail per-task view (and a badge on task rows). The flagship cache-debug feature, backend already built.
2. **Cache-key explain** — surface `explainCacheKey` in the task-detail page.

### Tier 2 — new read-only query/view over existing data (no schema change)

3. **Critical path + parallelism-gap callout in the run cockpit** — compute the longest-duration chain through the live DAG, highlight those nodes/bars, list them ordered, and call out worker-idle %. (`RunConsole.tsx` + a new util; uses the live `/v1/graph` + timings.)
4. **Run comparison** — `/v1/compare?a=&b=` + a `/#/compare` view diffing two runs' task outcomes, durations, cache status, and per-task hash changes (built on the same hash-diff `whyDidThisRerun` uses).
5. **Cache Entries inventory** — a filterable Cache-tab table (hash, task, size, last-hit, age, hit-staleness) with a "cold / never re-hit" badge, over the existing `listCacheEntries`.
6. **Local vs remote hit-rate split + "time saved" hero framing** — split the existing trend by `cache-hit-local`/`cache-hit-remote`; make time-saved the Overview hero with a counterfactual.

### Tier 3 — schema additions (deferred; own follow-up, CACHE/SCHEMA bump)

7. **Git/VCS + CI context on runs** (commit, branch, ci, host) → commit-centric grouping + filtering (Nx CIPE).
8. **Persisted per-run input fingerprints** → the _full_ Develocity-grade "which input file changed" diff.
9. **Invocation header table + tags** → build-scan metadata, tag filtering, `vx run --report=markdown` PR comments.
10. **Remote-transfer accounting** (bytes up/down) → network-savings + per-task cache-source breakdown.

### Explicitly NOT doing

Self-healing/AI CI fixes, ML predictive test selection, test distribution,
test-level (per-test-case) analytics, Bazel RBE worker dashboards — wrong
altitude / infra-heavy / need data we don't model.

## 4. Implementation waves (this effort)

Parallelized by **disjoint file ownership** to avoid conflicts on the shared
UI plumbing (`api.ts`, `jr/data.ts`, `jr/functions.ts`, `main.tsx`).

- **Wave 1 (parallel):** (A) Explainability — `whyDidThisRerun` + `explainCacheKey` surfaced (owns `api.ts`/`data.ts`/`functions.ts`/`runDetail.json`/`taskDetail.json`); (B) Critical path + parallelism in the cockpit (owns `RunConsole.tsx` + a new util — disjoint).
- **Wave 2 (after wave 1 merged):** Run comparison + Cache-entries inventory + hit-rate split.

UI changes do **not** rebuild the embedded `apps/ui/dist/index.html` per-agent;
the dist is rebuilt **once** at integration and verified e2e over the DevTools
Protocol before commit. No `CACHE_VERSION` bump in Tier 1–2.
