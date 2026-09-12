# Resource reservations learned from history (2026-09)

**Status: shipped 2026-09-12 — core has an `admit` stage and no notion of resources; `@vzn/vx-schedule-history` learns each task's reservation from what its past executions used and packs them. Step 2, the producing execution's usage carried on the cache artifact, shipped the same day.**

## Why

`exec.resources` was the one config field a developer could not write
well. The number a task needs is a property of its inputs and the
machine, it changes with every dependency bump, and nobody measures it —
so the field was either absent (every task admitted freely, the OOM
killer the only backstop: n8n at four workers on a 13.3 GiB cgroup,
2026-09-11) or a guess that was true once.

Every execution already records what it used: the runner reads the
child's `resourceUsage()` — CPU time and peak RSS — into the `runs`
table beside the duration. The owner's direction (2026-09-12): let the
scheduling history supply the reservation; then, on the first cut, "the
concept of resources should be only in history schedule — why should
core know it". So core does not.

## What core keeps

One seam. `VxPlugin.admit(task, ctx)` is asked at every local dispatch,
after the count gate, with `ctx.running` (the tasks executing on this
machine right now, in dispatch order) and `ctx.concurrency`. `false`
holds the task until something finishes, when it is asked again. The
rules, all in `plugin-host.buildAdmission` and `graph/scheduler`:

- synchronous and cheap — it runs inside the dispatch loop, many times
  a run;
- fail-open — a throw is reported once (`plugin '<name>' failed in
admit: …; admitting every task from here on`) and the plugin admits
  from then on; a policy never breaks a run;
- restore-tier hits and tasks on an executor pool hold nothing on this
  machine and are never asked or counted;
- with several answering plugins, all must admit;
- a skipping task (a failed dependency) never waits on admission;
- with no plugin answering, the scheduler's dispatch is byte-identical
  to before the stage existed — no set is maintained, no closure runs.

Gone from core, in the same change: `exec.resources` (and its
validation, its `ResourcesConfig` type, its `vx show` row), `--memory`,
`RunOptions.memory`, `TaskPlacement.resources`, the scheduler's
per-axis costs and budgets, the summary footer's budgets,
`orchestrator/resources.ts`. `hashableConfig` strips only `exec.remote`
now; a config that declared `resources` is refused as an unknown field,
never silently hashed as if it had not been written. No `CACHE_VERSION`
bump: a config without the field stringified identically before, and
one with it cannot load now.

`TaskHistory` gains `maxPeakRssBytes` and `maxCpuParallelism` (cpu time
over wall time) over the same window as the durations, from successful
executions only: a hit reports nothing, and a failure's usage is not
what the task needs to succeed. That is a query the history module
already owned, not a concept.

## What the plugin does

`@vzn/vx-schedule-history` reads the history once per run, in
`schedule` (the read it already made for durations), and derives each
task's reservation:

- memory: the largest peak RSS in the window × `headroom` (1.25),
  rounded UP to 64 MB; omitted under one step, since a 20 MB task is not
  worth packing. Maximum, not mean: the two errors are asymmetric —
  over-reserving loses some parallelism, under-reserving meets the OOM
  killer.
- cpus: the most parallelism any execution showed, rounded to a whole
  core; omitted at one, since a worker slot already is one core.
- decay: the window is by run count (`window`, 20), so a task whose
  usage dropped after a refactor loses its old reservation after twenty
  runs, and a one-off spike ages out the same way.
- `reservations` in the plugin's options declares a task's numbers by
  hand — a first run, a task whose peak the runner cannot see — and a
  declaration wins over a learned one.
- a task with neither reserves nothing and is admitted freely, exactly
  as with no plugin.

Its `admit` hook packs them: a task is admitted while the reservations
of everything in `ctx.running` plus its own fit the budgets — cores are
`ctx.concurrency`, memory is the plugin's `memory` option (MB) or this
machine's total — and a task over a whole budget runs alone, admitted
only when nothing else runs, which an idle machine always reaches. The
`memory` option exists because `os.totalmem()` in a cgroup-limited
container reports the host's RAM.

## Step 2: the usage rides the artifact

A fresh CI runner has no history, and that is where the budget bites.
The producing execution's `cpuMs` and `peakRssBytes` join the
artifact's own sidecar (`.vx-meta.json`, an optional `exec` field), so:

- every wire ships them for free — Turbo's `/v8/artifacts`, Nx's
  `/v1/cache`, REAPI's CAS all move the bytes verbatim, and the
  `RemoteCacheLayer` seam does not change;
- save and ingest index them on the `entries` row from the artifact
  (`cpu_ms`, `peak_rss_bytes`; `SCHEMA_VERSION` v26), the way the
  output rows already come from the sidecar — one source on both paths;
- a hit surfaces them on its outcome as `storedCpuMs` /
  `storedPeakRssBytes`, the split `storedDurationMs` already draws:
  what the hit skipped, never what it spent, so `--summarize` and the
  event stream name a remote worker's peak under its own key;
- the history reader takes them from a hit row's entry (a primary-key
  join, hit rows only), so the plugin's next run on that machine has a
  reservation. No "observed elsewhere" row is written: the entry IS the
  record, and a row copied from it would be a second copy to keep true.

No `CACHE_VERSION` bump: the container is unchanged and an artifact
without the field reads as before. The ingest side is the untrusted
boundary: a foreign sidecar's usage is taken only as plain non-negative
numbers. Pinned: pack → scan round trip and the boundary
(`archive-security.test.ts`), the entry built from the artifact on save
and on ingest alike (`cache.test.ts`), a hit row's usage from its entry
and a pruned entry contributing nothing (`history.test.ts`), and end to
end through the stub remote layer: a run with its `.vx` wiped restores
from the remote, the hit carries the first run's peak RSS as
`storedPeakRssBytes` and none as its own, and the history reader over
the fresh cache reports it (`orchestrator-remote.test.ts`). Measured on
the 1,000-project bench, compiled binaries interleaved: warm no-op 12
reps min 134 / med 140 ms before vs 137 / 142 after; `--force` 6 reps
min 1840 / med 1862 vs 1760 / 1792 — a tie inside the spread.

## Rejected

- The first cut: keep `exec.resources` in core and let the plugin fill
  it from history in a `graph` hook. Core then carried a config field
  nobody could write, a CLI flag for its budget, a scheduler that packed
  two axes, a footer line and a placement field, all for one plugin —
  a branch for one consumer is the seam being too narrow.
- A new return shape for `schedule` (`{ priorities, reservations }`):
  the reservations are asked about per dispatch, not once; a per-run map
  would need core to keep packing them, which is the concept it should
  not have.
- Inferring the reservation into the config file: the file would lie
  the moment the code changes, and "no inferred inputs" applies to
  reservations too. Showing an observed number is fine; writing it is not.
- Syncing the history database as an artifact: no natural key,
  append-only per machine, and merging it is where the bugs would live.

## Tests

- `tests/scheduler.test.ts` (`admit`): serialize vs concurrent under one
  policy, same-tick visibility of a just-started task, backfill of an
  uncharged task, the solo rule, skip never waits, restore-tier and
  pooled tasks never asked, FIFO among the held, no policy byte-identical.
- `tests/plugin-pipeline.test.ts` (`admit stage`): a vetoing plugin
  serializes two tasks a control run overlaps; the context a plugin sees
  (`running`, `concurrency`), in order; a throwing policy is reported
  once and admits from then on.
- `tests/history.test.ts`: the maxima come from successful executions in
  the window; a failed row's usage and a hit's zeros are ignored; a task
  that never reported answers undefined.
- `@vzn/vx-schedule-history/tests/resource-estimates.test.ts`: rounding,
  headroom, the two thresholds, declared-wins, the packing rule.
- `schedule-history-e2e.test.ts`: two ~200 MB tasks under
  `memory: 512` and two workers overlap on the first run and serialize
  on the second — the differential is the overlap.

## Cost

Nothing on the plain warm path: with no plugin answering `admit` the
scheduler keeps no running set and calls no closure, and the two SQL
maxima run only when the plugin is declared, inside the history read it
already makes. Measured on the 1,000-project bench, compiled binaries
interleaved, one workspace per arm: warm no-op 24 reps min 135 / med
144 ms on both arms; `--force` (every task executes) 6 reps min 1753 /
med 1859 ms before vs 1800 / 1846 after — a tie inside the spread.
