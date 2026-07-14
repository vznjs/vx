# Lookahead / critical-path-aware admission — design

> **Status:** proposal — Phase 1 EXECUTED (see "Phase 1 results" below);
> lookahead (Phase 3) not built, per recommendation.
>
> Owner ask (verbatim, the north star): _"I wonder how we do
> scheduling. Critical path should always be prioritized but we should
> also be smart and predict based on time to not schedule a task that
> would block critical. But also not wait for critical and do nothing."_

Decomposed into three constraints:

1. **Prioritize the critical path.**
2. **Predict on time — don't start a task that delays a soon-ready
   critical task past its slack** (lookahead).
3. **Never idle a worker to "save" it for critical** (work-conserving).

This doc takes the ask seriously, works the scheduling theory against
vx's actual scheduler, and lands on a decisive recommendation. Spoiler
in one line: **(1) is already implemented and near-optimal; (3) is
already a hard invariant; and (3) forecloses the only version of (2)
that could beat what we already do — so the honest recommendation is to
NOT build reservation/lookahead admission, build a scheduler benchmark
instead, and validate promoting the existing time-based priority toward
default-on.** The full lookahead mechanism is specified anyway (Phase 3),
gated behind a measured win.

## What we're solving

The scheduler (`src/graph/scheduler.ts` `runGraph`) is a greedy,
work-conserving, two-tier list scheduler. Every time a worker frees, it
pops the highest-priority admissible ready task and dispatches it; it
never idles a worker while an admissible ready task exists. Priority is
either:

- **default** — `computeReverseDepCount` (`scheduler.ts:220`), the
  structural transitive-reverse-dependent count. Duration-**blind**.
- **opt-in** — `computePredictedPriorities` (`src/orchestrator/predict.ts`),
  each node's **expected remaining critical-path duration** (own p50 +
  `max` over dependents), from local `cache.db` history
  (`LocalHistoryProvider`, `src/orchestrator/history.ts`). Merged as an
  override via `mergePriorities` (`scheduler.ts:661`), enabled by
  `defineWorkspace({ predictive: true })` (`prepare.ts:278`).

The owner's question is whether we can do better than greedy by
**looking ahead**: predicting when a not-yet-ready critical task will
become ready and steering the free worker's choice so that task isn't
blocked — without ever idling.

## Access pattern (what the decision loop actually is)

The decision happens in `tick()` (`scheduler.ts:548`). Per free worker,
per completion event:

```
while (active < concurrency) {
  id = takeFitting()          // pop highest-priority admissible ready task
  if (id === undefined) break // ← the ONLY idle: nothing ready is admissible
  … dispatch execute(node, upstream) …
}
```

- Called on every task completion (`.then`/rejection arm re-invokes
  `tick`) and once at startup. On a 3000-task run that's ~3000 ticks,
  each popping O(log R) from a heap. Any lookahead runs **inside this
  loop** — it must stay cheap (a `Map.get`, not a graph walk per pop),
  exactly like the resource-admission `fits` gate (`scheduler.ts:471`).
- The choice space per free worker is: _which ready task to start._ The
  loop is already strictly work-conserving (the `break` fires only when
  no admissible task exists). So the **only** freedom lookahead has is
  to **reorder among ready tasks** — it cannot idle (constraint 3), and
  it cannot change _what_ runs (correctness).
- Data available cheaply: predicted `dur(t)` per task (history p50 or
  workspace-median fallback, same source `predict.ts` already uses),
  and `remCP(t)` (the predictive priority itself). Data NOT cheaply
  available today: per-running-task predicted finish time, and a
  logical/wall clock in the decision function (the scheduler currently
  makes **no** wall-clock decisions — order is a pure function of
  priorities + graph + completion order; see Invariants).

## The theory, worked against real examples

Two facts frame everything:

- **Work bound.** A work-conserving schedule on `m` workers wastes
  capacity only as _genuine idle_ — moments with fewer admissible ready
  tasks than free workers. Total work / `m` is a hard floor; greedy
  hits it except for idle forced by a thin ready frontier.
- **LPT is the makespan-correct greedy bias.** Longest-processing-time-
  first is within 4/3 of optimal for independent tasks and is what
  Turbo/Nx Agents do. vx's `remCP` priority **is** LPT generalized to a
  DAG (longest remaining chain first). It front-loads the long/critical
  work — the correct bias for makespan.

### Example A — a linear critical chain is never delayed (greedy is optimal)

`m=2`. Critical `P(3)→C(20)`; non-critical leaf `N(12)`. Both roots
ready at `t=0`. `remCP`: `P=23`, `C=20`, `N=12`.

```
Greedy:  w1: P(0–3)  C(3–23)          makespan 23  = critical path
         w2: N(0–12) idle(12–23)
```

`C` grabbed `w1` the instant `P` freed it. A linear critical chain only
ever needs **one** worker, and under any work-conserving schedule that
worker is free the moment the predecessor finishes (each critical task
unblocks the next). **Non-critical work can never delay a linear
critical chain.** No lookahead can improve `t=23`.

### Example B — the owner's imagined case (short head, long non-crit, last worker)

`m=2`. `w1` running `W(8)`. Free `w2` at `t=0`, ready `{H(2), N(8)}`;
`H→T(10)` (critical). `remCP`: `H=12 > N=8` — greedy-predictive picks
`H`.

```
Greedy:  w1: W(0–8)  N(8–16)          makespan 16 = optimal
         w2: H(0–2)  T(2–12)  idle
```

`T` got `w2` at `t=2` the instant `H` freed it. Again optimal; the
critical-path priority already dispatches the head first, and the tail
inherits a freed worker. Lookahead adds nothing.

### Example C — where a real CHOICE exists, lookahead reorders, and it DOES NOT help

`m=2`. Critical fork `H(2)→{T1(10), T2(10)}→J(2)`; non-critical
`N(10)`, `S(2)`. Roots `{H, N, S}`, `remCP`: `H=14`, `N=10`, `S=2`.

```
Greedy:      w1: H(0–2)  T1(2–12)  J(12–14)  S(22–24)   makespan 22
             w2: N(0–10) T2(10–20)  idle(20–22)          ↑ N hidden under T2's delay
Lookahead:   w1: H(0–2)  T1(2–12)  J(12–14)  …            makespan 22
(prefer S)   w2: S(0–2)  T2(2–12)  … then N(14–24)?       also 22 (work bound)
```

Both hit 22 — it's the work bound. Reordering the non-critical filler
doesn't change the makespan because the filler has to run _somewhere_.

### Example D — lookahead REGRESSES makespan (Graham anomaly)

This is the decisive one. `m=2`. Symmetric critical fork
`H(2)→{A(10)→A2(10), B(10)→B2(10)}`; non-critical `N(10)`, `S(2)`.
Roots `{H, N, S}`, `remCP`: `H=22`, `N=10`, `S=2`.

**Greedy** (`H` and `N` are top-2 priority at `t=0`; `S` waits):

```
w1: H(0–2)  A(2–12)   A2(12–22)  S(22–24)
w2: N(0–10) B(10–20)  B2(20–30)
                              makespan = 30
```

**Lookahead** ("`H` finishes at t=2 releasing A+B, a 2-worker fork —
free a worker by preferring the short `S(2)` over `N(10)` on w2"):

```
w1: H(0–2)  A(2–12)   A2(12–22)
w2: S(0–2)  B(2–12)   B2(12–22)   N(22–32)
                              makespan = 32   ← WORSE by dur(N)−dur(S)
```

Greedy's 30 is **optimal** (lower bounds: work 54/2 = 27, CP 22; the
only sub-30 packings require running the two 20-chains fully parallel,
which strands `N` as a pure 10-unit tail → 32). Greedy accidentally
_hides_ `N` under the B-chain's delay; lookahead exposes it.

**Why this happens, stated generally:** the owner's lookahead is a
**short-first (SPT) bias** — "prefer short tasks so a worker frees for
critical." SPT is the classic _bad_ bias for makespan. `remCP`'s
**long-first (LPT) bias** is the correct one. Preferring short tasks to
pre-free a worker delays long non-critical work to the tail, where it no
longer overlaps anything. **Lookahead optimizes critical-task _start
latency_ at the cost of _makespan_.** That is a real trade, not a free
lunch — and often a _losing_ one.

### Could lookahead ever win?

Only for a **latency** objective (get the critical / requested output
out ASAP, accepting a longer total run), and even then `remCP` already
dispatches a critical task the instant it is ready and a worker is free
— it waits only behind _equal-or-higher_ `remCP` tasks, i.e. other
critical work, which is correct. Lookahead could start a critical task
marginally earlier only by delaying other work (extending makespan). We
were unable to construct a realistic graph where work-conserving
lookahead reliably improves makespan over greedy-`remCP`; the failure to
find one, plus Example D, is the core evidence.

## Options considered

- **Option 1 — Reservation/slack lookahead (the literal ask).** Track
  predicted finish per running task; when a free worker's top ready task
  would occupy it past a soon-ready critical task's slack, prefer a
  shorter ready task that fits the slack (never idle). _Rejected as
  default:_ Example D shows it regresses makespan; it optimizes a
  different objective (start-latency) than the one users feel
  (makespan); it introduces wall-clock/predicted-time into the decision
  function, breaking the tested determinism invariant; and it is
  provably non-monotone (Graham anomaly — a "better" local choice can
  worsen the global result), so it cannot be shipped default-on safely.
  Specified in full below (Phase 3) so it is implementable if a measured
  need ever appears.
- **Option 2 — Idle-insertion lookahead (hold a worker for critical).**
  The only lookahead with real theoretical teeth (non-work-conserving
  schedules can beat every list order). **Forbidden by constraint 3** —
  the owner explicitly rejects idling. Not designed.
- **Option 3 — Tie-break-only slack refinement.** Use slack/duration
  info to break _equal-priority_ ties only. Provably cannot regress
  relative to the priority order (it only orders within a tie), but ties
  are rare once real durations exist, so it almost never fires.
  Near-zero value; not worth the code.
- **Option 4 (RECOMMENDED) — Don't add lookahead. Build a scheduler
  benchmark and validate promoting time-based priority toward
  default-on.** The largest _real_ available win is that MOST runs never
  use time-based priority at all (`predictive` is opt-in and needs
  history); the default `computeReverseDepCount` is duration-blind and
  genuinely mis-orders mixed-duration graphs (it front-loads a task that
  unblocks _many short_ tasks over one that unblocks a _single long_
  chain). Closing that gap beats any lookahead, at a fraction of the
  risk.

## Recommendation

**Do not build reservation/lookahead admission (Options 1 and 2).** The
owner's constraint (3) removes idle-insertion, and the remaining
work-conserving reordering is already handled near-optimally by the
critical-path (`remCP`) priority — with lookahead adding no reliable
makespan win and a demonstrated regression (Example D) plus a
determinism/testing cost.

**Build Option 4 in two phases:**

- **Phase 1 — a scheduler policy benchmark** (`bench/schedule-policy.ts`)
  that replays synthetic + captured-real graph shapes through `runGraph`
  under competing priority maps and reports makespan + critical-task
  latency. This is the missing instrument: every future scheduling claim
  (including any lookahead) becomes measurable instead of argued. Low
  risk (bench-only, no `src/` change), high leverage.
- **Phase 2 — validate `predictive: true` for default-on** using Phase 1
  on real graphs. Time-based `remCP` strictly dominates duration-blind
  count on mixed-duration DAGs; if the benchmark confirms a wall-time win
  with no regression, flip the default (cold/no-history runs stay
  byte-identical — see below).

**Phase 3 — the lookahead mechanism itself — ships ONLY if Phase 1
reveals a residual latency gap the owner explicitly wants to trade
makespan for.** It is fully specified below so that decision is a
build-or-not, not a design-from-scratch. Default prior: it will not pay
off; keep it opt-in and off.

---

## The lookahead mechanism (Phase 3 — specified, gated on a measured win)

Provided at implementation precision so it can be built if measured
worthwhile. It is an **opt-in, no-op-without-data, work-conserving
reorder** of the ready set — never an idle.

### Precompute (once per run, only when duration data exists)

Reuse `predict.ts`'s duration source. In `prepare.ts`, alongside
`computePredictedPriorities`, produce:

- `dur: Map<id, number>` — predicted ms per task (history p50, else
  workspace-median fallback; restore-tier ids → 0). Exposed from a
  refactored `predict.ts` that already computes these internally.
- `remCP: Map<id, number>` — the existing predictive priority.
- `cpLen` — the graph critical-path length = `max(remCP over roots)`.
- A task is **critical-ish** iff `remCP(id) ≥ CRIT_FRACTION * cpLen`
  (default `CRIT_FRACTION = 0.9`). This is a graded set, not a single
  chain — a fork's siblings both count. Thread these to `runGraph`
  behind ONE new optional field so the empty case is byte-identical:

```ts
// ScheduleOptions (scheduler.ts), all optional:
lookahead?: {
  dur: ReadonlyMap<string, number>      // predicted ms; absent id ⇒ unknown
  remCP: ReadonlyMap<string, number>
  cpLen: number
  critFraction?: number                 // default 0.9
}
```

Absent `lookahead` ⇒ the current code path, unchanged.

### Runtime state added to `runGraph`

- `startedAt: Map<id, number>` — logical dispatch time (see below) per
  running task.
- A **logical clock** `clock`, NOT `performance.now()`. `clock` advances
  to the predicted-finish of whichever running task the scheduler models
  as completing next. Using a logical clock (predicted durations) rather
  than wall-clock keeps the decision function a **pure function of
  inputs** — essential for determinism and test pinning (see Invariants;
  this is the single most important design constraint and the reason the
  literal "use `performance.now()`" version is rejected).
- `predFinish(runningId) = startedAt(runningId) + dur(runningId)`
  (in logical time). Unknown `dur` ⇒ `+∞` (an unpredictable task never
  counts as "about to free a worker" — fail safe toward greedy).

### Slack, defined

For a **next-ready** critical-ish task `C` (every dep is finished or
currently running):

```
ready(C)  = max over C's running deps of predFinish(dep)   // when C can start
slack(C)  = ready(C) − clock                               // ≥ 0; time until C is ready
```

`freeAt` for the choice at hand: the free worker is free **now**
(`clock`). Starting a ready task `L` occupies it until `clock + dur(L)`.

### The admission rule (replaces `takeFitting`'s pop when `lookahead` is set)

Applied **only among tasks that already pass `willSkip`/`fits`** (so it
composes cleanly with resource admission and fail-fast; see below). Let
`top` = the highest-priority admissible ready task.

1. **If `top` is critical-ish → dispatch `top`.** (Constraint 1: critical
   path always wins outright. No lookahead against it.)
2. **If no next-ready critical-ish task `C` has `slack(C) < dur(top)` →
   dispatch `top`.** Starting `top` cannot make any imminent critical
   task wait for _this_ worker, so greedy is fine.
3. **Otherwise** (`top` is non-critical AND would occupy this worker past
   some imminent critical `C`'s ready time) — check whether `C` would
   actually be **starved**: count workers predicted free at `ready(C)`
   _if we dispatch `top` now_. If ≥ the number of critical children
   becoming ready at `ready(C)`, `C` is not starved → **dispatch `top`**
   (greedy; freeing a worker is unnecessary). If `C` _would_ be starved,
   look for an alternative admissible ready task `S` with
   `dur(S) ≤ slack(C)`:
   - **If such `S` exists → dispatch `S`** instead of `top` (it fills the
     slack and frees this worker exactly when `C` needs it).
   - **If no such `S` exists → dispatch `top` anyway.** (Constraint 3:
     never idle. If nothing fits the slack, running `top` beats stalling.)

Rule 3 is the _entire_ owner ask, bounded: it only ever prefers a
shorter ready task over a longer one, never idles, never overrides a
critical task, and never fires without duration data. It is exactly the
SPT-flavored reorder that Example D shows can regress makespan — which is
why it is opt-in and benchmark-gated, and why rule 1/2 keep it from ever
touching the critical path itself.

### No-data / no-op guarantee (hard requirement)

- `lookahead` field absent (cold cache, no history, `predictive` off) ⇒
  `takeFitting` runs the current code verbatim ⇒ **byte-identical
  schedule.** This is the gate, mirroring `resourceCosts.size > 0` in
  `run.ts:385,540`.
- `lookahead` present but a task's `dur` is unknown ⇒ its `predFinish`
  is `+∞`, so it never registers as "about to free a worker" and rule 3
  never prefers around it — the scheduler degrades toward greedy per
  missing task, not globally.
- Flat graph (no forks, no deps) ⇒ no next-ready critical task ever has
  `slack < dur(top)` in a way that starves (there is no fork needing >1
  worker) ⇒ rule 2 short-circuits ⇒ greedy order. Pinned by test.

### Opt-in vs default

Ride the **existing `predictive: true`** flag (it already gates the
duration data and the whole history load in `prepare.ts:278`). Add a
sub-flag so lookahead can be A/B'd independently of time-based priority:
`defineWorkspace({ predictive: true, lookahead: true })` (default
`lookahead: false`). Lookahead **requires** `predictive` (it needs the
same durations); declaring `lookahead` without `predictive` is a loader
warning that it is inert. Never default-on until Phase 1 shows a win.

## Correctness invariants (all preserved)

- **Dependency ordering** — untouched; lookahead only reorders the
  _ready_ set (tasks whose deps are already satisfied). Deps still gate
  readiness via `pending`/`dependents` (`scheduler.ts:387`).
- **Failed-dep skip / fail-fast** — lookahead runs **after** the
  `willSkip` filter (`scheduler.ts:537`); a would-skip task is never a
  lookahead candidate (it is finished free, exactly as today), so a
  doomed long task can neither be "preferred" nor block a slot.
- **Restore-tier bypass** — restore-tier ids have `dur = 0` and are
  never critical-ish; they stay the low-priority backfill tier
  (`scheduler.ts:563` restore pop is unchanged). Lookahead touches only
  `execReady`.
- **Resource admission** — lookahead chooses only among tasks that pass
  `fits` (`scheduler.ts:471`); the park-within-tick mechanism
  (`scheduler.ts:556,649`) is unchanged. If nothing fits, we still park,
  not idle-for-critical.
- **No deadlock / no starvation** — rule 3's fallback always dispatches
  `top` when no slack-fitting `S` exists, so a worker with ready work
  never stalls; `active` always advances while admissible work remains.
- **Determinism (the load-bearing one)** — the current schedule order is
  a pure function of `(priorities, graph, completion order)`; the
  existing 2000-trial randomized differential test
  (`tests/scheduler.test.ts` precedent, and the perf-guard suite) relies
  on this. The logical-clock design keeps the decision a pure function of
  `(priorities, graph, dur, completion order)` — no `performance.now()`
  in any branch — so a given `(graph, dur, execute-timing)` yields ONE
  order, pinnable. **A wall-clock variant would break this and is
  explicitly rejected.**

## Test plan

Follows the existing `tests/scheduler.test.ts` style (manual completion
gates via `gates()`, `onStart` order capture) so behavior is pinned
without timing flakiness.

**No-op / no-regression (must pass first — these are the safety net):**

- `lookahead` absent ⇒ every existing scheduler test passes unchanged
  (the legacy-path pin, like the `resourceCosts` empty-map test at
  `scheduler.test.ts:794`).
- Flat graph (independent roots) + full `dur` data ⇒ order identical to
  greedy-`remCP` (rule 2 short-circuits; no fork to starve).
- Unknown `dur` for the top task ⇒ greedy (rule 2, `+∞` finish).
- **Graham-anomaly guard (Example D encoded):** assert the makespan/order
  and _document_ that lookahead trades makespan for critical latency here
  — the test exists to make the trade visible and intentional, not to
  claim a win.

**Behavioral (the win, if any):**

- Fork-starvation case with a short alternative present: lookahead
  dispatches the short `S`, freeing a worker so both fork children start
  at `ready(C)` (assert `onStart` order + that the critical fork children
  start together).
- Fork-starvation with NO slack-fitting alternative: lookahead dispatches
  `top` anyway (never idles — assert a worker is never idle while ready
  work exists).
- Critical `top` is never deferred: a critical-ish ready task is
  dispatched immediately even when a shorter non-critical task exists
  (rule 1).

**Determinism:** a fixed `(graph, dur)` with a fixed `execute` gate
schedule produces a single deterministic `onStart` order across repeated
runs (extend the existing differential-test harness with a `dur` map).

**Benchmark (Phase 1, the real deliverable):** `bench/schedule-policy.ts`
replays a matrix of graph shapes (deep chains, wide fans, diamonds,
symmetric forks, mixed-duration, work-bound vs CP-bound) under {count,
`remCP`, `remCP`+lookahead} and reports makespan + requested-task latency
per policy. This is what turns "should we?" into a number.

## Phase 1 results (executed 2026-07-14)

`bench/schedule-policy.ts` (committed; `bun bench/schedule-policy.ts --md`
regenerates `bench/schedule-policy.md`) replays 9 graph shapes through a
deterministic discrete-event simulation of `runGraph`'s greedy exec-tier
list policy, self-validated against three hand-computed makespans (a chain,
a work-bound fan, and Example D = 30). It compares three priority maps built
from the REAL functions: `count` (the duration-blind default), `remCP`
(predictive with warm history), and `remCP-cold` (predictive with EMPTY
history — exactly what a cold-cache `predictive: true` run produces).

Findings (makespan Δ vs `count`; negative = faster):

- **Structured shapes tie exactly** — deep chain, wide fan, diamond, the
  Graham anomaly, work-bound, cp-bound all show **0.0%** for both `remCP`
  and `remCP-cold`. The critical-path priority provably can't reorder these
  (a chain needs one worker; a fan/work-bound is work-bound; Example D's
  greedy-`remCP` is already optimal at 30).
- **Warm predictive wins on realistic mixed-duration DAGs** — `-1.3%` to
  `-2.4%` makespan (mean **−2.0%**) AND the same on requested-output
  latency, across 800–2000-node bimodal-duration layered graphs. This is
  the Phase-2 signal: time-based priority strictly dominates the
  duration-blind count when real durations exist.
- **BUT cold predictive can REGRESS** — `remCP-cold` shows **+0.1% to
  +0.9%** on the same mixed graphs. With no history the uniform-duration
  fallback collapses to critical-path DEPTH, which is a _worse_ heuristic
  than reverse-dep-count on some shapes. So predictive is NOT a free no-op
  on a cold cache — it's a small net loss there.

**Phase-2 conclusion (corrected by the measurement): do NOT flip
`predictive` unconditionally default-on.** The safe, win-only form is
**default-on only when history is present** (warm) — keep the count-based
priority on a cold cache (first run / cleared cache), which the benchmark
shows ties exactly. That captures the −2% warm win with provably zero cold
regression. Open cost question before shipping the flip: loading history on
every run adds one batched `runs`-table query at `prepareRun` — must be
measured against the "performance is king" bar (the reverted 2026-06
upfront-classification regressed warm runs, so a new per-run read on the
default path needs its own A/B). Phase 2 is therefore its own careful
increment, not a drive-by default change.

## Phasing

1. **Phase 1 — scheduler benchmark** (`bench/`, no `src/` change). Ship
   this regardless; it is the instrument for every later claim. **DONE.**
2. **Phase 2 — validate + (if it wins) default-on `predictive`.** The
   real, low-risk scheduling win. Cold/no-history runs unchanged.
3. **Phase 3 — the lookahead mechanism** (opt-in `lookahead: true`,
   spec above). Build **only** if Phase 1 shows a residual latency gap
   the owner wants to trade makespan for. Prior: skip it.

## What's out of scope

- **Idle-insertion / non-work-conserving scheduling** — forbidden by
  constraint 3; the only lookahead with theoretical teeth, off the table
  by owner rule.
- **The distributed/cloud `taskDurationHints` path** — this doc is the
  LOCAL in-process scheduler only. The trust-scoped cross-dev hint
  (decision log 2026-07-14) is a separate mechanism; nothing here touches
  it.
- **Changing the cache key, artifact format, or wire protocols** —
  scheduling is a pure ordering concern; no `CACHE_VERSION`/`SCHEMA`/
  telemetry/`DIST_PROTOCOL` bump anywhere in this proposal.
- **Speculative pre-warming / bandit retry** — separate `predictive`
  phases (predictive-execution-2026-06.md §C-D), unaffected.
- **A local `runs` branch column** — the local history is single-user
  and transient; branch-scoping it is a core-schema bump deliberately
  not in scope (matches the deferred follow-on in the 2026-07-14 log).

## Open questions

- **Is there ANY graph shape where work-conserving lookahead reliably
  beats greedy-`remCP` on makespan?** We could not construct one; Phase 1
  is how we would find out empirically before writing Phase 3.
- **Does the owner actually want makespan or critical-latency?** If the
  true objective is "requested output out ASAP, total run time
  secondary," lookahead's trade (Example D) is acceptable and Phase 3
  becomes worth it. This should be confirmed explicitly before Phase 3.
- **`CRIT_FRACTION` calibration** (0.9?) — only relevant if Phase 3
  proceeds; a Phase 1 sweep sets it.

## Why this is the right move (3–5 bullets)

- **The owner's own constraint resolves the tension in favor of "just
  prioritize critical path well."** Forbidding idle (3) removes the only
  lookahead that can beat greedy; what remains is reordering, which
  critical-path priority already does near-optimally.
- **We proved lookahead can regress** (Example D, a clean Graham
  anomaly) — the naive "prefer short to free a worker for critical" is an
  SPT bias, and SPT is the classically _bad_ makespan bias. Shipping it
  default-on would be a footgun.
- **The biggest real win is elsewhere and cheaper:** most runs use the
  duration-blind default; getting time-based critical-path priority onto
  more runs (Phase 2) beats any lookahead at a fraction of the risk.
- **It protects a tested invariant:** the schedule order is a pure
  function of priorities + graph today; a benchmark + logical-clock
  design keeps it pinnable, whereas a wall-clock lookahead would make the
  scheduler non-deterministic and untestable.
- **Nothing is lost:** the lookahead mechanism is fully specified and
  gated behind a measurement, so if a real latency need ever surfaces
  it's a build decision, not a research project.
