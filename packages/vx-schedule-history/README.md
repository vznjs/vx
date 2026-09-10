# @vzn/vx-schedule-history

History-based scheduling for [`@vzn/vx`](https://github.com/vznjs/vx): a `schedule` plugin that orders ready tasks by their expected REMAINING critical-path duration — a task's own p50 plus the longest chain of dependents behind it — learned from the workspace's local run history. Zero dependencies.

## Usage

```ts
// vx.workspace.ts
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'

export default { plugins: [scheduleHistoryPlugin()] }
```

`scheduleHistoryPlugin({ window?, assume? })` learns from the last `window` invocations (default 20) through core's `LocalHistoryProvider` over the cache's own SQLite handle. With one worker and two chains of identical shape, the chain history says is slow starts first; with no history yet, the scheduler's structural order stands.

`assume` is for the run that has no history: a fresh CI runner. It names durations (task id → ms) for tasks the history has not seen, so a long leaf task — a docs build, a cross-compile — starts first instead of last:

```ts
export default {
  plugins: [scheduleHistoryPlugin({ assume: { '@vzn/vx-docs#build': 30_000 } })],
}
```

A recorded p50 always wins over an assumption, and assumptions never feed the workspace median: they are a hint for the cold run, not evidence. vx's own CI declares exactly this one — its docs build was the 29 s tail of a 99 s cold gate, ready from the second second and started last (2026-09-10).

## What it does and does not do

- It is an ORDERING hint over the scheduler's structural baseline (remaining critical path by edge count), merged as `VxPlugin.schedule` returns it: task id → weight. It never changes what runs, only which ready task runs first.
- Cache hits are not modelled as zero-cost: predicting cache state needs the key and a probe, which the scheduler handles at run time (a confirmed hit is backfill, never a critical-path task). The estimate is "what if everything ran", which is exactly the case where order matters.
- It fails open: a broken history read warns (`[vx] schedule-history: falling back to the baseline order`) and leaves the baseline order. Observability never breaks a run.
- Cost: one history read per run, paid only by workspaces that declare the plugin. Core applies no plugin by default.

`criticalPathPriorities(nodes, history)` is exported for tests and for policies that want the same scoring over another history source.

## History

Core's opt-in `predictive` mode until 2026-09-02, then core's one bundled plugin (`@vzn/vx/plugins/schedule-history`) until 2026-09-10, when it moved here so core ships no plugin at all.
