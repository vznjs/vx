# @vzn/vx-schedule-history

History-based scheduling for [`@vzn/vx`](https://github.com/vznjs/vx): a `schedule` plugin that orders ready tasks by their expected REMAINING critical-path duration — a task's own p50 plus the longest chain of dependents behind it — learned from the workspace's local run history. Zero dependencies.

## Usage

```ts
// vx.workspace.ts
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'

export default { plugins: [scheduleHistoryPlugin()] }
```

`scheduleHistoryPlugin({ window?, assume?, resources?, memory?, reservations? })` learns from the last `window` invocations (default 20) through core's `LocalHistoryProvider` over the cache's own SQLite handle. With one worker and two chains of identical shape, the chain history says is slow starts first; with no history yet, the scheduler's structural order stands.

`assume` is for the run that has no history: a fresh CI runner. It names durations (task id → ms) for tasks the history has not seen, so a long leaf task — a docs build, a cross-compile — starts first instead of last:

```ts
export default {
  plugins: [scheduleHistoryPlugin({ assume: { '@vzn/vx-docs#build': 30_000 } })],
}
```

A recorded p50 always wins over an assumption, and assumptions never feed the workspace median: they are a hint for the cold run, not evidence. vx's own CI declares exactly this one — its docs build was the 29 s tail of a 99 s cold gate, ready from the second second and started last (2026-09-10).

## Reservations learned from history

The same history answers what each task used: the runner records every
execution's CPU time and peak RSS. Core's only gate is the worker count;
this plugin's `admit` hook packs the finer numbers, and core never
learns them. Each task's reservation is the largest peak RSS in the
window times a headroom (1.25), rounded up to 64 MB, and the most CPU
parallelism seen, rounded to a whole core; a task is admitted while its
reservation and those of everything running beside it fit the budgets —
cores are the run's worker count, memory is what this process may use
(the machine's total, capped by the cgroup limit a container runs
under) — and a task over a whole budget runs alone. A task with no execution in the
window reserves nothing and runs freely, as it would with no plugin; a
spike or a refactor ages out with the window. A cache hit counts too:
the producing execution's usage rides the artifact, so a fresh CI runner
that restored a task from a remote cache has its reservation on the
next run without ever having executed it.

```ts
plugins: [
  scheduleHistoryPlugin({
    // MB. The default is the machine's total capped by the cgroup limit; set it to budget below either.
    memory: 8192,
    resources: { headroom: 1.5 },
    // Declared by hand for what history cannot size (a first run); a declaration wins.
    reservations: { 'app#e2e': { cpus: 2, memory: 4096 } },
  }),
]
```

`resources: false` turns the learning off (declared `reservations` are
still packed). Admission control, not enforcement: nothing is
cgroup-limited or reniced, and a task that exceeds its reservation is
the job of `exec.timeout` and the OS. Design:
`docs/design/resource-estimates-2026-09.md` in `@vzn/vx`.

## What it does and does not do

- It is an ORDERING hint over the scheduler's structural baseline (remaining critical path by edge count), merged as `VxPlugin.schedule` returns it: task id → weight. It never changes what runs, only which ready task runs first.
- Cache hits are not modelled as zero-cost: predicting cache state needs the key and a probe, which the scheduler handles at run time (a confirmed hit is backfill, never a critical-path task). The estimate is "what if everything ran", which is exactly the case where order matters.
- It fails open: a broken history read warns (`[vx] schedule-history: ordering falls back to the baseline`) and leaves the baseline order and only the declared reservations. Observability never breaks a run.
- Cost: one history read per run, serving both hooks, paid only by workspaces that declare the plugin. Core applies no plugin by default.

`criticalPathPriorities(nodes, history)`, `resourceEstimates(nodes, history, headroom)`, `withDeclared(learned, declared)` and `admits(id, running, reservations, budgets)` are exported for tests and for policies that want the same scoring over another history source.

## History

Core's opt-in `predictive` mode until 2026-09-02, then core's one bundled plugin (`@vzn/vx/plugins/schedule-history`) until 2026-09-10, when it moved here so core ships no plugin at all.
