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

Today `@vzn/vx-dte` places and sizes a run with about 9,000 lines of
greedy rules (best-fit, holds, soon-holds, packing, a play, a flexible
fallback). Each rule fixed one measured run. About twenty constants carry
a guess about the world (table below). They interact, so a fix for one run
moves another (#5325, reverted by #5326).

## The model

### What is learned, never assumed

Every input is a distribution learned from history. Before a fact has been
seen once, its prior is the next wider level where it has: same task id,
then same script in the workspace, then the workspace.

| Symbol   | Meaning                                             | Learned from                                                                  |
| -------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `T_i`    | task `i`'s duration, alone, on a worker of speed 1  | per-run `aloneMs` rows (vx-history)                                           |
| `c_i`    | cores `i` keeps busy                                | `cpuMs / aloneMs` of the same rows                                            |
| `m_i`    | `i`'s peak memory                                   | the same rows                                                                 |
| `W_s`    | warm-up of a worker of size `s`                     | the run's and past runs' joins (`learned.warmUps`, `joins`)                   |
| `v_w`    | speed of worker `w`                                 | prior: the size's past speeds; posterior: each task it ends (took ÷ expected) |
| `g_p(L)` | slowdown on platform `p` at load `L` = Σ`c` ÷ cores | rows' `cpuShare` against their load                                           |

`g` starts as processor sharing, `g(L) = max(1, L)`: work is conserved,
time is stretched. The rows say how far real machines are from it (four
shards a 4-core worker ran 1.45x alone on main, 2026-11-13), and the fit
replaces the starting form.

### One machine

A worker of `C` cores runs a set `S` of tasks. Each runs at rate
`v_w / g(Σ_{j∈S} c_j / C)`. Memory is a hard limit, as an out-of-memory
kill is a failure, not a slowdown.

There are no core bookings, rounding, floors or over-booking factors. A
task takes room in proportion to what it uses. Putting it on a busy worker
costs time, not compute. A new worker costs `W_s × C_s` of idle compute.

### One objective

The objective has two parts, compared in order, with no weights:

1. The least expected end of the run, `E[makespan]`.
2. Of choices with an equal end, the least expected compute, `E[Σ_w C_w × (leave_w − ask_w)]`.

"Equal" needs no tolerance. Every choice is scored on the same sampled
scenarios (common random numbers). A choice that does not touch the
critical path ends the run at the same time in every sample, so ties are
exact.

### One decision rule

At each event (a task ready or ended, a worker joined, a plan timer), the
choices are:

- place a ready task on a joined worker,
- leave it to wait,
- ask a worker of a size,
- let an idle worker go.

Each choice is scored by rollout (Bertsekas and Castañon, 1999). Draw `N`
scenarios of `T`, `W`, `v` from the learned distributions, finish the run
in each with the same rule applied greedily, then compare the objective
means. This is sample average approximation (Kleywegt, Shapiro and
Homem-de-Mello, 2002). `N` is the most samples the plan's time budget
allows (≤ 1.5 s, a product requirement, not a guess). The run's own
`tests/sim.ts` already finishes a run this way. The rollout is that sim
over samples.

### What follows from it, with no rule of its own

- Two 1.25-core shards on a 2-core Mac: sharing stretches both, while a
  third Mac costs its warm-up and ends no sooner.
- A 20-core task on a busy 10-core worker runs there while that ends the
  run sooner than waiting or a new worker would.
- A 10-core task facing one free core asks a worker: squeezed in, it is
  the run's end.
- Workers fill before another is asked: a new worker never lowers the end
  while a joined one can take the task in time.
- Wait for the worker holding an upstream's files, or make them again: the
  rollout compares both (replaces `PIN_WAIT_MS`).
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
| `HEDGE` 0.15, `RISK` 2, `CHAIN_TIMES` 3    | guesses at overruns                | samples of `T`                                 |
| `LANES` 4                                  | room in quarter cores              | continuous load                                |
| `MIN_CORES` 1, `bookedCores`, `wholeCores` | bookings rounded                   | `c_i` and `g`                                  |
| `OVERBOOK` 1.5, `LEARN_MS`                 | how far bookings may stretch       | `g`                                            |
| `OTHER_WEIGHT` 0.25                        | smoothing of a worker's other load | the posterior of `v`                           |
| `PIN_WAIT_MS` 10 s                         | wait vs make again                 | the rollout                                    |
| hold counts (`4 × workers + 8`)            | room kept for tasks to come        | the rollout                                    |

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

1. **Learned inputs.** `W_s`, the prior for unseen tasks, `v_w` and `g`
   from history, behind today's rules. Removes `UNKNOWN_MS`,
   `WARM_UP_MS`, `SLOWDOWN_MS` and `OTHER_WEIGHT`.
2. **One machine.** The live dispatch, the sim and the play share the load
   model. Removes bookings, rounding, `OVERBOOK`, `LANES` and the flexible
   fallback of #5375.
3. **Rollout placement.** Placement and holds by rollout. Removes
   best-fit, soon-holds, `HEDGE`, `RISK`, `CHAIN_TIMES` and `PIN_WAIT_MS`.
4. **Rollout asks.** Worker asks and releases by the same rollout. Removes
   the packing's deadline seeks and the play.

Risk: rollout cost on large graphs (10,000 tasks). Each step measures plan
time on the largest sim family. If a full rollout does not fit the budget,
it rolls out a horizon short enough to fit and bounds the rest, with the
horizon measured against full rollouts on the sim, not chosen.
