# DTE planner: one model, learned inputs (2026-11)

Status: proposed, 2026-11-18. Owner: DTE stream.

## Why

M, 2026-11-18:

- "We always utilize 100%, then start another... Don't split into two just
  because there is one core or half a core."
- "If you're gonna spawn a new machine, 30 seconds of a startup, that's
  already 2 minutes on a 4-core worker that you are wasting."
- "I don't want our algorithm to be a bunch of if rules."
- "I don't want any magic numbers in the algorithm. All the numbers are
  assumptions... It should do forecasting, statistic, probabilistic."
- "We need the least complexity to achieve maximum gains... gather as less
  as possible and as compact as possible... we should use math."

Today `@vzn/vx-dte` places and sizes a run with about 9,000 lines of
greedy rules (best-fit, holds, soon-holds, packing, a play, a flexible
fallback). Each rule fixed one measured run. About twenty constants carry
a guess about the world (table below). They interact, so a fix for one run
moves another (#5325, reverted by #5326).

## The model

### What is learned, never assumed

Every input is learned from history, and history keeps the least that
answers: for each quantity, its count, mean and sum of squared deviations
(Welford's running moments). That is three numbers, updated in place, and
no raw series. Before a fact has been seen once, its prior is the next
wider level where it has: same task id, then same script in the
workspace, then the workspace.

| Symbol | Meaning                                | Kept as           | From rows vx already writes        |
| ------ | -------------------------------------- | ----------------- | ---------------------------------- |
| `T_i`  | task `i`'s duration, alone, at speed 1 | moments           | `aloneMs`                          |
| `p_i`  | cores `i` keeps busy, on average       | moments           | `cpuMs / aloneMs`                  |
| `s_i`  | how much of `i` is serial              | one fitted number | runs of `i` at other `cpuShare`    |
| `m_i`  | peak memory                            | max               | `peakRssBytes`                     |
| `W_s`  | warm-up of a worker of size `s`        | moments           | joins                              |
| `v_w`  | speed of worker `w`                    | moments, this run | each task it ends: took ÷ expected |

No new measurement is needed. `s_i` is why one average is not enough. A
task of 10 minutes at 5 cores on average takes between 10 minutes (only
its serial part ran long) and 20 (all of it ran on 5 cores) on 2.5 cores.
Runs of the same task at a lower `cpuShare` say where in that range it
sits. Until one has, it sits halfway, as the mean of an unknown position.

### One machine

A worker of `C` cores runs a set `S` of tasks. While `Σ p_j ≤ C`, each
runs at its own pace. Past it, CPU is shared (processor sharing): each
gets `C / Σ p_j` of what it asks, and its time stretches on the parallel
part only, by `s_i`. Memory is a hard limit, as an out-of-memory kill is
a failure, not a slowdown.

There are no core bookings, rounding, floors or over-booking factors.
Putting a task on a busy worker costs time, not compute. A new worker
costs `W_s × C_s` of idle compute.

### One forecast

From the moments, one forward pass over the graph gives each task's
expected finish and its variance. A task's finish is the latest of its
upstreams' plus its own time. The latest of several is taken with Clark's
moments of the maximum of normals (1961), the standard way PERT sums
uncertain paths. One backward pass gives each task's latest finish that
does not move the run's expected end: its slack. Both passes are linear
in the graph and repaired locally as events arrive, so a plan of millions
of tasks stays under a second.

### One objective

Two parts, compared in order, with no weights:

1. The least expected end of the run.
2. Of choices with the same expected end, the least compute,
   `Σ_w C_w × (leave_w − ask_w)`.

"The same end" needs no tolerance. A choice that stretches only tasks
with slack to absorb it leaves the forecast's end where it was.

### One decision rule

At each event (a task ready or ended, a worker joined), each ready task
in order of its slack (least first) takes the choice with the best
objective among:

- each joined worker, with the stretch it puts on itself and on the
  tasks already there,
- waiting for the first worker that frees enough,
- a new worker of each size the run may still ask,

and a worker no task will take before a new one could join leaves.

### What follows from it, with no rule of its own

- Two 1.25-core shards on a 2-core Mac: sharing stretches both within
  their slack, while a third Mac costs its warm-up and ends no sooner.
- A 20-core task on a busy 10-core worker runs there while that ends the
  run sooner than waiting or a new worker would.
- A 10-core task facing one free core asks a worker: squeezed in, it is
  the run's end.
- Workers fill before another is asked: a new worker never lowers the end
  while a joined one can take the task in time.
- Wait for the worker holding an upstream's files, or make them again: two
  choices of the same rule (replaces `PIN_WAIT_MS`).
- Keep an idle worker or let it go: its expected next use against a new
  one's warm-up (replaces "two warm-ups").

## The constants

Assumptions about the world, to be removed:

| Constant                                   | Today                              | Replaced by                                    |
| ------------------------------------------ | ---------------------------------- | ---------------------------------------------- |
| `UNKNOWN_MS` 30 s                          | a guess for unseen tasks           | the prior over `T`                             |
| `WARM_UP_MS` 20 s                          | a guess before a join              | `W_s`                                          |
| `MARGIN_MS`, `MARGIN`                      | slack a plan may end late          | the objective (no slack)                       |
| `SLOWDOWN_MS`                              | history before slowdown speaks     | the posterior of `v` (weak data counts little) |
| `HEDGE` 0.15, `RISK` 2, `CHAIN_TIMES` 3    | guesses at overruns                | the variance of `T`                            |
| `LANES` 4                                  | room in quarter cores              | continuous load                                |
| `MIN_CORES` 1, `bookedCores`, `wholeCores` | bookings rounded                   | `p_i`, `s_i` and sharing                       |
| `OVERBOOK` 1.5, `LEARN_MS`                 | how far bookings may stretch       | sharing                                        |
| `OTHER_WEIGHT` 0.25                        | smoothing of a worker's other load | the posterior of `v`                           |
| `PIN_WAIT_MS` 10 s                         | wait vs make again                 | the decision rule                              |
| hold counts (`4 × workers + 8`)            | room kept for tasks to come        | slack                                          |

These stay, as they bound the solver's own work and say nothing about the
world: `SAMPLE`, `KEPT`, `CLASSES`, `RESTARTS`, `SEEKS`,
`MAX_JUMP_KINDS`, `BLOCK`, and `PLAN_GAP` (the planner's share of the CPU).
Protocol timers stay: `STALL_MS`, `RELEND_MS`, `BATCH_BYTES`. `SHAPES` and
`MEMORY_PER_CORE` list the machines `advise` may suggest. They describe the
offer, not the run.

## Judging

Each step is judged before its PR, and again after it merges:

- Sim, from real runs' fixtures (d36eed9 and three more main runs), with
  real task times (`ran`) against what history knew (`known`), 20 join
  orders each. Report the median and worst end, and the median compute.
  A step merges only if no median or worst gets worse.
- `tests/sim-theory.test.ts` graph families, against the CP-SAT optimum
  (dte-optimum-gap, 2026-11-11).
- Three clean main runs after merge, wall time and compute against the
  three before it. If either gets worse, revert.

## Steps

1. **Learned inputs.** Moments of `T`, `p`, `W`, the prior for unseen
   tasks, `v_w` and `s_i`, from rows vx writes already, behind today's
   rules. Removes `UNKNOWN_MS`, `WARM_UP_MS`, `SLOWDOWN_MS` and
   `OTHER_WEIGHT`.
2. **One machine.** The live dispatch, the sim and the play share the
   sharing model. Removes bookings, rounding, `OVERBOOK`, `LANES` and the
   flexible fallback of #5375.
3. **One forecast and rule for placing.** Removes best-fit, holds,
   soon-holds, `HEDGE`, `RISK`, `CHAIN_TIMES` and `PIN_WAIT_MS`.
4. **The same rule for asking and letting go of workers.** Removes the
   packing's deadline seeks and the play.

Each step deletes more code than it adds. Plan time is measured on the
largest sim family at every step and must not grow.
