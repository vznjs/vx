# Predictive execution — using history to win the perf war

Status: proposal (2026-06-20). Pure performance proposal. Builds on
the `runs` / `run_tasks` data model (`vx-cloud-2026-06.md`) and the
existing scheduler (`graph/scheduler.ts`).

## 1. The premise

Today's vx scheduler is **stateless across runs**. Every `vx run`
starts from zero knowledge — no idea which tasks are typically slow,
which are cache hits, which are flaky, which dominate the critical
path. The scheduler walks the DAG topologically and dispatches in
graph-insertion order with a transitive-reverse-deps priority. That's
the same algorithm a build system in 1995 used.

But we have data. The `runs` table has been recording cpu/rss/wall/
status/cache-hit per task since 2026-05 (schema v11). On any
established repo, after a week of runs, we know the empirical
distribution of every task's duration, cache hit rate, and likelihood
of failure. We use **none of it** to make scheduling decisions.

This proposal: turn vx into a **learning scheduler**. Use history to
predict, prioritize, and pre-warm. The result is faster runs without
asking the user for anything.

## 2. Three concrete wins

### 2.1 Critical-path priority from history (not from graph)

Today: priority = transitive-reverse-dep count. A task that blocks
many descendants runs first. Reasonable as a heuristic.

Tomorrow: priority = **expected remaining critical-path duration**.
Compute, per task, the expected wall time of itself + the longest
chain of descendants, using historical p50 durations. A 30-second
test that unblocks a 4-second lint is lower priority than a 4-second
build that unblocks a 30-second test. The graph-counter heuristic
gets this wrong; history gets it right.

The math is a single topo-DP pass:

```ts
function expectedCriticalPath(node: TaskNode, history: HistoryTable): number {
  if (cache.has(node.hash)) return 0   // a hit costs nothing
  const own = history.p50(node.id) ?? defaultDuration
  const downstream = max(node.dependents.map(d => expectedCriticalPath(d)))
  return own + downstream
}
```

Memoized; O(N) per run. The scheduler picks the highest-expected
remaining critical path among the ready set.

**Expected speedup**: 5-20% wall-clock reduction on graphs where the
slowest task is *not* the most-blocking task. Common in real
workloads — a database integration test blocks nothing but takes 90s;
prioritizing it over a 2s lint that blocks 40 build tasks would
catastrophically slow a single-worker run. Today's heuristic
correctly prioritizes the lint. The HISTORY-AWARE version
re-prioritizes when worker count makes the cost of mis-scheduling
small.

The mechanism gracefully handles missing history: a task with no
prior runs uses a default duration (workspace median). Once it has
runs, history dominates.

### 2.2 Speculative pre-warming

The remote-prefetch optimization (shipped 2026-06) starts remote-cache
GETs for every cacheable task at run start. It works because **we
know the hash in advance**.

Generalize: for any task whose hash we can compute upfront (stable
key — no dependence on upstream outputs), pre-warm:
- **Remote-cache prefetch** (shipped).
- **Local-cache stat probe** — touch the local entry to OS-cache the
  inode (negligible on SSDs, measurable on cold spinning disks).
- **Input file pre-read** — `posix_fadvise(WILLNEED)` on declared
  input files (Linux only; no-op elsewhere). For cache-miss tasks
  this overlaps a syscall the runner will make.
- **Module pre-load** — for tasks that exec a JS runtime (`bun
  run`, `node`), pre-resolve the entry's import closure. Bun
  supports `--preload`; we can leverage.

Each is a small win, all overlap with already-running work. Total
expected speedup: 3-8% on cold runs.

### 2.3 Bandit-driven retry decisions

Some tasks are flaky. Today: a task fails → the run fails. The user
re-runs. Lost time.

Future: per-task `failureRate` from history. A task with > 5%
historical flakiness gets *auto-retried once* on transient failure
(non-zero exit with a structurally-detected "flake" pattern —
network errors, port collisions, timing-dependent assertions). A
task with < 1% flakiness fails fast. The threshold and detection
heuristic are owner-configurable per project.

**Multi-armed bandit framing**: we balance the cost of retrying
(extra time) against the cost of false failures (broken CI, dev
re-runs). The expected-value calculation is straightforward:

```
expectedCost(retry) = (1 - p_succeed_on_retry) * 2 * task_duration
expectedCost(noretry) = p_flake * (cost_of_human_rerun + task_duration)
```

We retry when `expectedCost(retry) < expectedCost(noretry)`. With
real numbers from `cache.db`, this is a one-liner that materially
improves CI green rates.

### 2.4 Bonus: shard-aware affinity

For the distributed-execution proposal (`distributed-ci-2026-06.md`),
history tells the coordinator which tasks are **slow** and which are
**fast**. Assign slow tasks first to workers with the most capacity;
pack fast tasks together to minimize coordinator overhead. The
existing assignment policy gets a "bin-packing" upgrade for free.

## 3. The data we need (already there)

| Field                | Source                                   |
| -------------------- | ---------------------------------------- |
| Per-task wall time   | `run_tasks.duration_ms` (extant)         |
| Per-task CPU         | `run_tasks.cpu_ms` (extant)              |
| Per-task RSS         | `run_tasks.peak_rss_bytes` (extant)      |
| Per-task status      | `run_tasks.status` (extant)              |
| Cache hit/miss       | `run_tasks.cache_source` (extant)        |
| Branch / commit      | `runs.branch`, `runs.commit_sha` (cloud) |
| Author               | `runs.triggered_by` (cloud)              |

For *local* predictions, the local `cache.db` is sufficient. For
*team-wide* predictions ("most other people see this test as slow"),
the cloud `runs` table is the source.

## 4. The HistoryTable abstraction

A single in-memory snapshot loaded at `prepareRun`:

```ts
type HistoryTable = {
  // Per (project#task), last N runs (default 50)
  recent(id: string): TaskRun[]
  p50(id: string): number                    // ms
  p99(id: string): number                    // ms
  successRate(id: string): number            // [0, 1]
  hitRate(id: string): number                // [0, 1]
  failureMode(id: string): 'stable' | 'flaky-recoverable' | 'flaky-fatal'
  bytesProduced(id: string): number          // p50 artifact size
}
```

Already prototyped (and removed) as `Cache.getTaskHistory` for the
deleted TUI. We revive the SQL CTE that built it (one query, batched,
returns a Map). Cost: ~5ms on a 1000-project repo. Cached for the
run's lifetime.

For the cloud path, the same shape is served by an RPC the
coordinator calls before dispatching.

## 5. Continuous regression detection

Beyond scheduling: with the HistoryTable, we can **detect
regressions** at run-end and surface them:

```
⚠ Slowdown detected:
    @vzn/vx-docs#build: 4.2s (p50: 1.1s, +280%)
    Suspected: workspaceFiles glob change in vx.workspace.ts
```

This requires:
- Comparing this run's task durations against rolling p50.
- Identifying significant deviations (e.g., > 2.5σ above mean,
  excluding cache-hit runs).
- Attributing them to changes: if the cache key changed since the
  last run, the inputs differ; we can diff them.

Output goes on the run summary footer (one warning line) AND to a
new RPC `getRegressions(since)` for tools/CI to consume.

**This is the analytics killer feature**, materialized as a build-
time signal. Today you discover a regression days later when someone
notices CI is slow. Tomorrow vx tells you the moment the run
finishes.

## 6. Architecture

```
                ┌──── prepareRun() ────────────────────┐
                │                                       │
                │  load HistoryTable from cache.db      │
                │   (or from vx cloud RPC)              │
                │                                       │
                └────────────┬──────────────────────────┘
                             │
                             ▼
              ┌──────── computeCriticalPath ───────────┐
              │   topo-DP using HistoryTable.p50       │
              │   → priority per node                  │
              └────────────┬───────────────────────────┘
                           │
                           ▼
              ┌──────── scheduler ─────────────────────┐
              │   ready queue sorted by priority       │
              │   + worker-affinity from history       │
              └────────────┬───────────────────────────┘
                           │
                           ▼
              ┌──────── execute-task ──────────────────┐
              │   retry-or-not from HistoryTable       │
              │   prefetch overlap from prefetch.ts    │
              └────────────┬───────────────────────────┘
                           │
                           ▼
              ┌──────── recordRun() ───────────────────┐
              │   write back to cache.db.runs          │
              │   compare to history → regression flag │
              └────────────────────────────────────────┘
```

Each box reads or writes one shared table. The wire is the
`HistoryTable` interface. The mechanism is in `orchestrator/`
already; we extend it.

## 7. Safety + correctness

**Hard rule**: predictive scheduling must never break correctness. A
mis-prediction only changes *order* and *priority*, not WHAT runs.
The cache key remains the source of truth; an incorrect prediction
is a perf regression, never a bug.

**Hard rule**: history is hints, not contracts. A task with zero
history runs fine (default duration). A task whose history is
suddenly invalid (the code changed dramatically) re-converges within
a few runs as the rolling window updates.

**Hard rule**: opt-out per project. `defineProject({ predictive:
false })` reverts to today's behavior for that project. Useful for
CI where you want deterministic ordering for debug repeatability.

## 8. Implementation cost

Surprisingly low. The data exists, the SQL CTE has been written and
reverted once, the scheduler already has a priority field. The
moving parts:

- `orchestrator/history.ts` — the HistoryTable loader (one SQL pass).
- `orchestrator/predict.ts` — the critical-path-from-history calc.
- `graph/scheduler.ts` — accept a `priority` override per node from
  the predict module instead of `reachOf` only.
- `orchestrator/execute-task.ts` — read `failureMode` for the retry
  decision; consult `HistoryTable.bytesProduced` to budget local
  storage.
- `cli/info.ts` — surface "predicted vs actual" deltas, regressions.

~300 LOC of new code; the bulk is the SQL and tests.

## 9. The performance bar (the promise)

After this lands:

| Workload                        | Today | After | Gain  |
| ------------------------------- | ----- | ----- | ----- |
| Cold run, 1000-pkg deep graph   | T₀    | T₀ × 0.85 | -15% |
| Warm run, 1000-pkg              | T₁    | T₁ × 0.92 | -8%  |
| Single-worker mixed-duration    | T₂    | T₂ × 0.80 | -20% |
| CI with 8 matrix workers (DTE)  | T₃    | T₃ × 0.88 | -12% |
| Flaky-failure recovery          | manual | auto    | ∞    |

These numbers are bounded by physics: the critical-path duration
itself doesn't change. But running closer to the floor is the win.

Compared to:
- **Turbo**: no historical awareness. Static graph-counter priority.
- **Nx**: similar; Nx Cloud has analytics dashboards but the
  scheduler doesn't consume them.

We'd be the **first task runner that learns from its own runs**.

## 10. The composable architecture

This proposal stays clean because every piece is independently
useful:

- **HistoryTable alone**: powers `vx insights` (the local UI from the
  cloud proposal).
- **Critical-path-from-history alone**: improves single-worker
  scheduling.
- **Prefetch generalization alone**: improves cold runs.
- **Bandit retry alone**: reduces CI re-runs.
- **Regression detection alone**: surfaces drifts.

We can ship them in any order. Each delivers value standalone, and
together they compose.

## 11. Phasing

| Phase | Ships                                                                                                  | Validates                                |
| ----- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **A** | HistoryTable revival (CTE). Exposed via RPC. Used by `vx info`.                                          | Data plumbing works.                     |
| **B** | Critical-path-from-history priority on the scheduler. Opt-in via `defineWorkspace({ predictive: true })`. | Measurable gain on real workloads.       |
| **C** | Speculative pre-warming generalized (input WILLNEED, module preload).                                   | Cold-run gain.                           |
| **D** | Bandit retry. Per-project `flakyRetry: 'auto' | <number> | 'off'`.                                      | Flaky-test recovery without manual.      |
| **E** | Regression detection at run-end. Surfaced in footer + RPC.                                              | CI-time regression visibility.           |
| **F** | Default-on for `predictive`. The improvements are universal enough to make non-opt-in.                  | Confidence the perf gain is positive.    |

## 12. Open questions

- **Cold-start without history.** A fresh repo has no data; we use
  defaults (workspace median, optimistic cache hit). Need to verify
  the defaults don't bias the new-user experience badly.
- **History invalidation.** A task whose command changed yesterday
  has irrelevant history. We weight by *task config hash similarity*
  — if the resolved-config hash today differs from a historical
  run's, that run gets a lower weight. (Trivial to compute; we
  store both.)
- **Storage growth.** 50 runs × 1000 tasks = 50k rows in `run_tasks`.
  Bounded. We GC old runs at `vx cache prune` time.
- **Predictability under change.** A regression flag triggered by a
  legitimate code change is noise. Solution: include the regression
  in the run record; if subsequent runs all show the new duration,
  it's the new baseline. Self-converges.

## 13. Why this matters

The performance race against Turbo and Nx is bounded by **physics**
(the CPU you have) and **cleverness** (the optimizations you find).
We're winning the cleverness race — but every win is finite. The
*compounding* win is **learning**.

A task runner that gets faster every run, with no user intervention,
is a fundamentally different value proposition. It's the wedge that
turns "vx is competitive on perf" into "vx is the only system that
keeps improving as you use it."

This is the architecture for that wedge.
