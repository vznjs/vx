# DTE planner: one model, one objective (2026-11)

Status: shipped, 2026-11-19. Code: `packages/vx-dte/src/plan/engine.ts`.

## Why

`@vzn/vx-dte` placed and sized a run with about 9,000 lines of greedy
rules (best-fit, holds, soon-holds, packing, a play, a flexible fallback)
and about twenty constants that each carried a guess about the world
(`UNKNOWN_MS`, `HEDGE`, `RISK`, `CHAIN_TIMES`, `OVERBOOK`, `LANES`,
`PIN_WAIT_MS`, the 5% margin, hold counts). Each rule fixed one measured
run; together they moved each other (#5325, reverted by #5326). The
`scheduler` option exposed four layers of them.

The engine replaces all of it with one model: a forecast, one objective,
one plan that every choice comes from. The live run and the sim drive the
same engine (`plan/planner.ts`), event by event.

## The model

**The machine.** A worker's tasks share its cores. While their cores fit,
each runs at its own pace; past them each runs at `cores / Σ cores`. A
new worker costs its warm-up of held cores. A task fills a worker before
another is asked: a 10-core task facing one free core asks a worker, and
two small tasks share a busy one rather than pay a warm-up. A task wider
than every worker, ready now, may run on the whole cores free now, as
many times as long as it is short of its cores, when that ends sooner
than the worker whole later. A worker measuring more load than its tasks'
history says spreads the excess over its unmeasured tasks, else over all.

**Joins.** A size's warm-up is the mean of this run's joins, else
history's. Workers asked together join one after another, as a CI queue
lets them in: each a spread after the one of its size asked before it
(the spread this run's batches showed, else history's). A worker past
when it was due is queued, and no more of its size is asked meanwhile.

**The forecast.** A task's time is history's mean, scaled by how this
run's finished tasks compared to history, with its spread. A running
task's rest is the lognormal residual of what it has run. One backward
pass, with Clark's moments of a maximum (1961), gives each task its tail
to the run's end and the end's mean and variance. A task history never
measured counts for `unmeasured` cores, else the measured tasks' mean,
and takes the censored mean of every time seen: the measured tasks', the
unmeasured that ended, and each unmeasured still running past that mean
counted as ended at what it has run (the fixed point
`m = (Σ ended + Σ ran > m) / (#ended + #(ran > m))`). The first to end
are the short ones; they alone would say every unmeasured task is short
(a09 with a third unmeasured: 152 s, 135 s with the censored mean).
A running task short of the mean says nothing yet: counted in, two
0.35 s tasks ended and one 0.2 s into its run read 0.47 s, and a
worker was asked for nothing. While no task's time is known at
all, no idle worker leaves: the forecast has nothing to judge by.

**The objective,** compared in order, no weights: the run's expected
end, then the core-time workers are held (warm-ups included), then fewer
workers. Lateness is `E[max(path, end)] − E[end]`, so a choice that only
spends slack costs nothing.

**The plan** (`plan3`). Each task, least slack first, is inserted where
it adds least expected lateness, then least held time: a joined worker's
free room, a wait for room there, or a new worker asked one warm-up
before the task needs it. Two prices keep it honest under spread:

- A task's expected start past running tasks of uncertain end is the
  Clark mean over the ones it waits for, not their means; its own
  upstream's end counts once, as its ready time, not again as its
  worker's occupant.
- A filler placed before a task whose ready time has spread pays the
  expected lateness its overrun adds to that task.

When every open time is a fact (measured, no spread), restarts draw each
start within its slack and keep the best plan by the objective: up to 16
tries a decide, fewer as tasks grow (1,600 placements in all), the same
draws each decide. The order that won is tried first at the next decide
while it still beats the plain one, so the search carries through the
run: 64 fresh tries a decide planned the same and took sims 3 to 7 times
as long. Under spread a draw judged on means loses, so it does not run.

Idle workers no forecast task needs leave. Leaving is judged by the same
objective: the plan without the worker against the plan with it.

**Big graphs** (`plan4`). Past 10,000 open tasks one forward, event-driven
list schedule with backfill plans instead: each worker's next task the
one with the longest tail that fits now, workers asked when a task's
latest start comes with no room.

## The constants

None is a guess about the world. `BIG` (10,000), `RESTARTS` (16) and
`RESTART_BUDGET` (1,600) bound the solver's own time. Protocol timers
(`STALL_MS`, `RELEND_MS`, `BATCH_BYTES`) stay. `SHAPES` and
`MEMORY_PER_CORE` list the machines `advise` may suggest.

## Judged

On the sim, against the planner it replaces (families: random, dense,
layered, wide, trap; 10 seeds each, 40 for unmeasured):

| Fixture                       | Old                         | New                         |
| ----------------------------- | --------------------------- | --------------------------- |
| blog a09 (end / core-s)       | 120.5 s / 4,623             | 120.5 s / 4,587             |
| exact families, cost vs ideal | 1.10–1.24                   | 1.08–1.19, all on time      |
| varied warm-ups               | 117 s late / 1.197          | 14 s late / 1.203           |
| a third unmeasured, % late    | 2.0 / 2.7 / 5.9 / 7.1 / 3.3 | 1.8 / 1.6 / 2.1 / 2.7 / 0.3 |
| noise, % late                 | 3.3 / 5.4 / 1.5 / 5.3 / 6.8 | 2.6 / 0.4 / 0.2 / 3.8 / 1.5 |
| d36eed9, 30 join orders       | 165.7 s                     | 148.2 s                     |
| a09, a third unmeasured       | 135.4 s                     | 134.7 s                     |

Where it holds more: with a third of the tasks unmeasured, compute is
1–11% above the old planner's on random, layered and wide graphs, and
0.5% with varied warm-ups: the price of fewer late runs, wall time first.

A million tasks: 0.3 s to build the engine and 2.0 s for the first
decide, on the container these were judged on.

After merge: three clean main runs against the three before, wall time
and compute. If either is worse, revert.
