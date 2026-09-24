# Scheduler policy benchmark

The generator is back (item 669): `schedule-policy.ts` simulates
`runGraph`'s exec tier on a virtual clock, ranked by the REAL
`criticalPathPriorities` (`@vzn/vx-schedule-history`) merged over core's
`computeReverseDepCount` by core's `mergePriorities`.
`tests/schedule-policy.test.ts` pins it on hand-computed schedules and
replays its fixtures through the real `runGraph` on a virtual clock (the
same dispatch order, start times and makespan, every policy).

The site's Learn page on scheduling (item 685) runs this module in the
browser: its Gantt charts are `simulate`'s `spans`. So everything the
module reaches at run time stays platform-free. The ranking comes from
`packages/vx/src/graph/priorities.ts` and
`packages/vx-schedule-history/src/critical-path.ts`, which import only
types, and the report below runs only under `import.meta.main`.

```
bun packages/vx-bench/schedule-policy.ts --md [--seeds N]
```

The question (parity row N-M7): should a task with NO history run
first? Nx does so only as a tie-break: its ready queue sorts by the
tasks waiting on each, then by the projects depending on its project,
and only among tasks equal on both does one with no recorded time go
first (`tasks-schedule.ts` `sortScheduledTasks`, spec line 497). The
plugin gives such a task the workspace median. `unknown-first` below
asks the stronger version of Nx's rule, over the whole ranking. Four policies over the same graphs, true durations
(log-normal, median 1 s, clamped to 10 ms–60 s) and history masks, 30
seeds per cell:

- `median` — the plugin today: an unknown task's own duration is the
  workspace median p50.
- `unknown-first` — an unknown task's own duration is one above the
  longest KNOWN remaining critical path (passed as `assume`), so a task
  with an unknown on its path outranks every task without one.
- `count` — no plugin: core's reverse-dependent count.
- `oracle` — every task known: what history can buy at best.

## Verdict (2026-09-23)

`unknown-first` is not adopted. On the realistic masks (5–25 % of the
tasks new to the history) it is faster on average, −0.69 % mean
makespan against `median` (the oracle is −0.82 %), and no cell's MEAN
regresses by more than +0.23 % (mixed-layered 40×50, 5 % unknown). But
single graphs regress by up to +6.15 % inside the realistic masks
(diamond at 25 %, mixed-layered 40×50 at 10 %) and +13.03 % over all
masks (diamond at 75 %): an unknown that turns out SHORT is started
ahead of the known long chain, and the chain finishes last. The mean
gain is a hedge paid for with that tail. The rule set for adoption asked
for a worst regression ≤ 1 % on any cell; the per-seed worst fails it
(the per-cell mean would pass).

At 0 % and 100 % unknown the two policies are identical by construction
(nothing to rank, or everything tied at the same guess).

## Results

| graph                       |   w | tasks | unknown | ms:median | Δ% unknown-first mean/worst | Δ% count mean/worst | Δ% oracle mean/worst |
| --------------------------- | --: | ----: | ------: | --------: | --------------------------: | ------------------: | -------------------: |
| deep-chain(200)             |   8 |   200 |      0% |    341725 |                 0.00 / 0.00 |         0.00 / 0.00 |          0.00 / 0.00 |
| deep-chain(200)             |   8 |   200 |      5% |    341725 |                 0.00 / 0.00 |         0.00 / 0.00 |          0.00 / 0.00 |
| deep-chain(200)             |   8 |   200 |     10% |    341725 |                 0.00 / 0.00 |         0.00 / 0.00 |          0.00 / 0.00 |
| deep-chain(200)             |   8 |   200 |     25% |    341725 |                 0.00 / 0.00 |         0.00 / 0.00 |          0.00 / 0.00 |
| deep-chain(200)             |   8 |   200 |     50% |    341725 |                 0.00 / 0.00 |         0.00 / 0.00 |          0.00 / 0.00 |
| deep-chain(200)             |   8 |   200 |     75% |    341725 |                 0.00 / 0.00 |         0.00 / 0.00 |          0.00 / 0.00 |
| deep-chain(200)             |   8 |   200 |    100% |    341725 |                 0.00 / 0.00 |         0.00 / 0.00 |          0.00 / 0.00 |
| wide-fan(500)               |   8 |   501 |      0% |    106764 |                 0.00 / 0.00 |      +5.73 / +22.81 |          0.00 / 0.00 |
| wide-fan(500)               |   8 |   501 |      5% |    106765 |               +0.00 / +0.04 |      +5.73 / +22.82 |        -0.00 / +0.03 |
| wide-fan(500)               |   8 |   501 |     10% |    107153 |               -0.32 / +0.05 |      +5.39 / +22.86 |        -0.32 / +0.05 |
| wide-fan(500)               |   8 |   501 |     25% |    107745 |               -0.74 / +0.04 |      +4.83 / +18.09 |        -0.74 / +0.04 |
| wide-fan(500)               |   8 |   501 |     50% |    108206 |               -1.13 / +0.04 |      +4.40 / +18.09 |        -1.14 / +0.02 |
| wide-fan(500)               |   8 |   501 |     75% |    109327 |               -1.68 / +9.57 |      +3.34 / +18.07 |        -2.11 / +0.03 |
| wide-fan(500)               |   8 |   501 |    100% |    112921 |                 0.00 / 0.00 |         0.00 / 0.00 |        -5.23 / -0.86 |
| diamond(200)                |   8 |   202 |      0% |     45890 |                 0.00 / 0.00 |     +11.86 / +36.94 |          0.00 / 0.00 |
| diamond(200)                |   8 |   202 |      5% |     46597 |               -1.41 / +0.05 |     +10.23 / +36.93 |        -1.42 / +0.08 |
| diamond(200)                |   8 |   202 |     10% |     47007 |               -2.01 / +0.10 |      +9.46 / +36.93 |        -2.02 / +0.09 |
| diamond(200)                |   8 |   202 |     25% |     47289 |               -2.29 / +6.15 |      +8.84 / +28.74 |        -2.52 / +0.11 |
| diamond(200)                |   8 |   202 |     50% |     48005 |               -3.20 / +3.13 |      +7.35 / +24.68 |        -3.87 / +0.04 |
| diamond(200)                |   8 |   202 |     75% |     49522 |              -4.27 / +13.03 |      +3.86 / +20.19 |        -6.84 / +0.02 |
| diamond(200)                |   8 |   202 |    100% |     51344 |                 0.00 / 0.00 |         0.00 / 0.00 |       -10.18 / -1.74 |
| work-bound(400/8w)          |   8 |   400 |      0% |     84267 |                 0.00 / 0.00 |      +6.96 / +22.87 |          0.00 / 0.00 |
| work-bound(400/8w)          |   8 |   400 |      5% |     86227 |               -1.85 / +0.05 |      +4.92 / +22.87 |        -1.84 / +0.04 |
| work-bound(400/8w)          |   8 |   400 |     10% |     85898 |               -1.53 / +0.05 |      +5.24 / +22.83 |        -1.53 / +0.06 |
| work-bound(400/8w)          |   8 |   400 |     25% |     85545 |               -1.25 / +0.05 |      +5.49 / +19.99 |        -1.24 / +0.03 |
| work-bound(400/8w)          |   8 |   400 |     50% |     86348 |               -2.05 / +0.08 |      +4.52 / +11.99 |        -2.06 / +0.05 |
| work-bound(400/8w)          |   8 |   400 |     75% |     87320 |               -3.04 / +0.09 |      +3.31 / +11.42 |        -3.16 / +0.01 |
| work-bound(400/8w)          |   8 |   400 |    100% |     90145 |                 0.00 / 0.00 |         0.00 / 0.00 |        -6.26 / -1.31 |
| cp-bound(60chain+300filler) |   4 |   360 |      0% |    152498 |                 0.00 / 0.00 |      +1.89 / +10.03 |          0.00 / 0.00 |
| cp-bound(60chain+300filler) |   4 |   360 |      5% |    152497 |               -0.00 / +0.04 |      +1.89 / +10.06 |        +0.00 / +0.03 |
| cp-bound(60chain+300filler) |   4 |   360 |     10% |    152496 |               +0.00 / +0.03 |      +1.89 / +10.03 |        +0.00 / +0.03 |
| cp-bound(60chain+300filler) |   4 |   360 |     25% |    152630 |               -0.09 / +0.03 |      +1.80 / +10.03 |        -0.08 / +0.04 |
| cp-bound(60chain+300filler) |   4 |   360 |     50% |    152634 |               -0.09 / +0.02 |      +1.80 / +10.04 |        -0.09 / +0.03 |
| cp-bound(60chain+300filler) |   4 |   360 |     75% |    152916 |               -0.26 / +0.02 |      +1.60 / +10.03 |        -0.27 / +0.01 |
| cp-bound(60chain+300filler) |   4 |   360 |    100% |    155377 |                 0.00 / 0.00 |         0.00 / 0.00 |        -1.81 / -0.10 |
| mixed-layered(20x40/8w)     |   8 |   800 |      0% |    167183 |                 0.00 / 0.00 |      +2.56 / +11.63 |          0.00 / 0.00 |
| mixed-layered(20x40/8w)     |   8 |   800 |      5% |    167586 |               -0.23 / +0.05 |      +2.33 / +11.63 |        -0.23 / +0.03 |
| mixed-layered(20x40/8w)     |   8 |   800 |     10% |    167699 |               -0.28 / +0.04 |      +2.26 / +11.62 |        -0.29 / +0.03 |
| mixed-layered(20x40/8w)     |   8 |   800 |     25% |    169231 |               -1.19 / +0.04 |      +1.33 / +11.63 |        -1.19 / +0.04 |
| mixed-layered(20x40/8w)     |   8 |   800 |     50% |    170312 |               -1.30 / +5.51 |       +0.69 / +7.91 |        -1.80 / +0.02 |
| mixed-layered(20x40/8w)     |   8 |   800 |     75% |    170803 |              -0.97 / +12.75 |       +0.39 / +9.37 |        -2.10 / -0.01 |
| mixed-layered(20x40/8w)     |   8 |   800 |    100% |    171264 |                 0.00 / 0.00 |       +0.11 / +1.28 |        -2.34 / -0.28 |
| mixed-layered(30x60/12w)    |  12 |  1800 |      0% |    246910 |                 0.00 / 0.00 |      +2.55 / +10.58 |          0.00 / 0.00 |
| mixed-layered(30x60/12w)    |  12 |  1800 |      5% |    247533 |               -0.25 / +0.01 |      +2.29 / +10.58 |        -0.25 / +0.01 |
| mixed-layered(30x60/12w)    |  12 |  1800 |     10% |    247950 |               -0.40 / +0.01 |      +2.13 / +10.59 |        -0.40 / +0.01 |
| mixed-layered(30x60/12w)    |  12 |  1800 |     25% |    249216 |               -0.77 / +3.61 |      +1.63 / +10.57 |        -0.89 / +0.01 |
| mixed-layered(30x60/12w)    |  12 |  1800 |     50% |    249764 |               -0.71 / +8.24 |      +1.42 / +10.55 |        -1.09 / +0.00 |
| mixed-layered(30x60/12w)    |  12 |  1800 |     75% |    251170 |              -0.76 / +13.00 |       +0.84 / +9.89 |        -1.65 / -0.00 |
| mixed-layered(30x60/12w)    |  12 |  1800 |    100% |    253425 |                 0.00 / 0.00 |       -0.07 / +0.35 |        -2.51 / -0.41 |
| mixed-layered(40x50/16w)    |  16 |  2000 |      0% |    209340 |                 0.00 / 0.00 |      +4.08 / +13.32 |          0.00 / 0.00 |
| mixed-layered(40x50/16w)    |  16 |  2000 |      5% |    210975 |               +0.23 / +5.02 |       +3.29 / +9.66 |        -0.74 / +0.02 |
| mixed-layered(40x50/16w)    |  16 |  2000 |     10% |    213163 |               -0.77 / +6.15 |       +2.30 / +7.72 |        -1.67 / +0.01 |
| mixed-layered(40x50/16w)    |  16 |  2000 |     25% |    215026 |               -1.21 / +3.63 |       +1.40 / +7.51 |        -2.53 / +0.01 |
| mixed-layered(40x50/16w)    |  16 |  2000 |     50% |    215321 |               -0.59 / +9.90 |       +1.26 / +6.03 |        -2.66 / -0.01 |
| mixed-layered(40x50/16w)    |  16 |  2000 |     75% |    216909 |               -0.64 / +9.07 |       +0.50 / +4.71 |        -3.39 / -0.02 |
| mixed-layered(40x50/16w)    |  16 |  2000 |    100% |    217542 |                 0.00 / 0.00 |       +0.19 / +3.09 |        -3.68 / -0.55 |
| monorepo(200pkg/8w)         |   8 |   600 |      0% |    126231 |                 0.00 / 0.00 |      +4.19 / +18.68 |          0.00 / 0.00 |
| monorepo(200pkg/8w)         |   8 |   600 |      5% |    126468 |               -0.17 / +0.02 |      +4.02 / +18.67 |        -0.17 / +0.03 |
| monorepo(200pkg/8w)         |   8 |   600 |     10% |    126630 |               -0.30 / +0.04 |      +3.88 / +18.68 |        -0.30 / +0.04 |
| monorepo(200pkg/8w)         |   8 |   600 |     25% |    128846 |               -1.80 / +0.04 |      +2.22 / +11.08 |        -1.80 / +0.02 |
| monorepo(200pkg/8w)         |   8 |   600 |     50% |    129149 |               -1.96 / +0.04 |      +2.02 / +11.09 |        -1.97 / +0.03 |
| monorepo(200pkg/8w)         |   8 |   600 |     75% |    129679 |               -2.37 / +0.03 |       +1.57 / +7.86 |        -2.39 / +0.02 |
| monorepo(200pkg/8w)         |   8 |   600 |    100% |    131542 |                 0.00 / 0.00 |       -0.01 / +0.63 |        -3.91 / -0.40 |

30 seeds per cell; Δ% is makespan against `median` (negative = faster), mean and
worst (largest) over the seeds.

- realistic masks (5–25 % unknown), mean of the cell means: unknown-first -0.69 %, oracle -0.82 %, count +3.51 %
- unknown-first, worst cell mean over ALL cells: +0.23 %; worst single seed: +13.03 %

## Record (2026-07)

The record the first generator left, before the plugin existed: the
duration-blind default against the then-core predictive mode.

Kept as the record behind the "lookahead / idle-insertion scheduling"
entry under Rejected in `CLAUDE.md`. Its generator (`schedule-policy.ts`)
was removed on 2026-09-09: it imported core's `orchestrator/predict.js`,
which left with the predictive mode on 2026-09-02, and had not run since.

Generated by `bun bench/schedule-policy.ts --md` (then). Compares the makespan +
requested-output latency of the duration-blind default priority (`count` =
`computeReverseDepCount`) vs the time-based predictive priority (`remCP` =
`mergePriorities(count, computePredictedPriorities)`), via a deterministic
discrete-event simulation of `runGraph`'s greedy exec-tier list policy.
Negative Δ = predictive is faster.

```
Scheduler policy benchmark — makespan + requested-output latency
(negative Δ = remCP/predictive is FASTER than the duration-blind default)

graph                        w   tasks  ms:count  ms:remCP  Δms%  Δms%cold  lat:count  lat:remCP  Δlat%
---------------------------  --  -----  --------  --------  ----  --------  ---------  ---------  -----
deep-chain(200)              8   200    10000     10000     0.0   0.0       10000      10000      0.0
wide-fan(500)                8   501    2560      2560      0.0   0.0       2560       2560       0.0
diamond(200)                 8   202    810       810       0.0   0.0       810        810        0.0
graham-anomaly(D)            2   7      30        30        0.0   0.0       30         30         0.0
work-bound(400/8w)           8   400    1250      1250      0.0   0.0       1250       1250       0.0
cp-bound(60chain+300filler)  4   360    6000      6000      0.0   0.0       6000       6000       0.0
mixed-layered(20x40/8w)      8   800    20916     20420     -2.4  +0.9      20916      20417      -2.4
mixed-layered(30x60/12w)     12  1800   35523     35045     -1.3  -0.2      35523      35044      -1.3
mixed-layered(40x50/16w)     16  2000   25335     24737     -2.4  +0.1      25335      24726      -2.4

mixed-duration makespan Δ (mean): -2.0%  ← the Phase-2 signal
worst makespan regression across ALL shapes: 0.0%
```
