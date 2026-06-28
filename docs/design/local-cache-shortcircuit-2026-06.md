# stable-key local cache short-circuit — design

> **Status:** proposal (2026-06-28)
>
> Author hand-off doc. Implement only after owner review — this touches
> the hottest path (the scheduler + `executeCachedTask`), and a prior
> attempt at a sibling idea (`classify.ts`) regressed warm runs ~57% and
> was reverted. The perf landmine is the whole story here; read §5.

## What we're solving

A cacheable task that is a **confirmed local cache hit** today waits for
its dependencies to finish _running_ before it is probed and restored —
even though its artifact is already on disk and its key does not depend
on what the upstream produces.

The user's example:

```
docs#import  (runs, ~76ms — no cache block, always executes)
   └─ docs#build  (local cache hit — restore ~2ms)
```

`docs#build` does not become `ready` in the scheduler until `docs#import`
finishes (`pending` hits 0 only when every dep completes —
`scheduler.ts:222-225`). So a 2ms restore is gated behind a 76ms run that
it has no data dependency on. The restore could have overlapped the run.
The user: _"it should not wait for compute if it can be restored ASAP —
why does it wait?"_

It waits because **cache lookup lives inside `execute()`**
(`executeCachedTask`, `execute-task.ts:177`), and `execute()` only runs
after the scheduler releases the task, which only happens after all deps
complete. The scheduler treats "restore from cache" and "run a
subprocess" as the same opaque unit of work behind the same `pending`
gate.

### Why the gate is normally correct (and when it isn't)

The dependency gate exists for two real reasons:

1. **Input dependency** — a downstream task whose `cache.inputs.files`
   can match an upstream's `cache.outputs.files` must wait for those
   outputs to exist on disk before its hash is even computable. This is
   the "codegen → consumer" case; the comment at `execute-task.ts:202-207`
   spells it out. For these tasks the key is _preliminary_ until the
   upstream runs — you cannot probe the cache for a key you can't yet
   derive.

2. **Output ordering / cleanliness** — `executeCachedTask` _cleans then
   restores_ the declared outputs (`execute-task.ts:297-302`). If an
   upstream writes to overlapping output paths concurrently, an early
   restore could race.

But for a task whose key is **stable** (provably independent of any
upstream's outputs — exactly the gate `remote-prefetch.ts` already
computes) and which is a **confirmed local hit**, _neither_ reason
applies. Its bytes are derivable now, present now, and land in paths no
running upstream touches. The dependency edge is then purely an
_ordering_ edge with no data behind it — and that's the edge we can
relax.

This is the local-execution analogue of the remote prefetch that already
ships: `remote-prefetch.ts` already overlaps remote-GET latency with
upstream computation for stable-key tasks. This proposal does the same
for the **local restore**, which is the part the user is staring at.

## Access pattern (what actually happens, how often)

Per `vx run`, today, for a stable-key local-hit task `D` with a slow
non-cacheable upstream `U`:

```
t=0     U starts (76ms subprocess)
t=76    U finishes → D.pending hits 0 → D ready
t=76    D execute(): computeTaskHash (memo hit, ~0) → cache.get (~1ms SQL)
        → isOutputsCurrent / restore (~1-2ms)
t=78    D done
```

The 2ms of D-work is serialized after the 76ms of U-work. With the
short-circuit:

```
t=0     U starts; D's key derived + probed in the background
t=~1    D confirmed local hit, key stable → restore now (outputs don't
        overlap U) → D done at t≈3
t=76    U finishes
```

D's wall-time contribution drops from "after U" to "overlapped with U."

### How often does this actually matter? (honest estimate)

The win requires **all** of: (a) a cacheable, stable-key downstream
task; (b) that task being a _local_ hit this run; (c) at least one of its
deps actually _running_ (a miss, a no-cache task, or a slow exec) for
long enough that overlapping the ~2ms restore is observable.

Topologies where this is real:

- **Always-run upstream feeding a cached downstream.** The user's
  case: a non-cacheable `import`/`prepare`/`codegen-without-outputs`
  step that a cached `build` depends on for _ordering_ but not for
  _inputs_. Common in docs/site pipelines and any "prep then build"
  shape. Note: if the upstream declares `cache.outputs.files` in the
  same project, the downstream is **unstable** and excluded — so this is
  specifically the "upstream has side effects we order around but don't
  read into our hashed input set" case.

- **Partial-hit graphs (cold-ish).** Some deps miss and run for real;
  their stable-key cached descendants could restore early instead of
  waiting in line behind the misses. The deeper and wider the graph, the
  more restores pile up behind the first slow layer.

Topologies where it does **not** help (be honest):

- **Warm all-hit runs.** If _every_ task is a local hit, deps finish in
  ~2ms each anyway; there is nothing slow to overlap. The restores are
  already imperceptible (~120ms total on a 1090-pkg repo per the
  decision log). **This is the case the prior `classify.ts` attempt
  regressed — and it's the case with zero upside.** The design must add
  _zero_ cost here.

- **Leaf/root tasks with no running deps.** Nothing to overlap.

- **Tasks whose deps are themselves all instant hits.** Same as warm.

**Verdict on scope:** the win is real but **narrow and bounded** — it
shaves the restore time of stable-key hits whose deps run. It is a
_latency_ improvement on mixed graphs, not a throughput improvement on
warm graphs. The engineering cost is concentrated entirely in _not
regressing_ the warm path. That asymmetry (small, narrow win vs. a
proven landmine) drives the recommendation in §7.

## Options considered (briefly)

### A. Pre-scheduling restore pass (chosen — see §Recommendation)

Before `runGraph`, derive stable keys (reusing the run `hashCache`, same
as remote-prefetch), probe the **local** cache for the stable ones,
and for confirmed hits restore them on a bounded pool that runs
concurrently with the main schedule. The scheduler is told these tasks
are _pre-resolved_: it skips `execute()` for them and treats them as
already-finished for the purpose of unblocking dependents. The probe
result is threaded so `execute()` never re-probes.

### B. Relax the `pending` gate for stable-hit tasks

Make a stable-hit task `ready` immediately (don't wait for deps), still
running through `execute()`. Rejected: it inverts the scheduler's
invariant that `upstream` outcomes exist when `execute(node, upstream)`
is called (`scheduler.ts:239`, `executeCachedTask` reads `args.upstream`
to fold upstream hashes in `computeTaskHash`). The upstream outcomes
would be absent. We'd have to fabricate them — and we'd still re-probe
inside `execute()`. More invasive to the scheduler's core loop than A,
for no benefit. A keeps the scheduler's invariant intact by _removing_
short-circuited nodes from the schedule entirely.

### C. Separate restore "lane" with its own worker budget

A second pool dedicated to restores, parallel to the exec pool.
Rejected as over-engineering: the restore work is tiny (~2ms of mostly
I/O) and bounded by the number of stable hits; folding it into the same
bounded background pump as remote-prefetch (option A) is simpler and the
budget question is moot at this work size. If profiling ever shows
restore contention, revisit — but designing for it now violates "don't
design for hypothetical future requirements."

### D. Do nothing / document

Genuinely on the table given §7. The win is narrow; the risk is the
hottest path. Listed honestly as the fallback.

## Recommendation

Build **Option A**, gated and structured to be _provably free_ on the
warm and local-only paths, and shipped as a **phased** change whose
first slice is the smallest correct thing. Mirror `remote-prefetch.ts`
almost exactly — it has already solved the hard sub-problems (stable-key
gate, key-derivation reuse, bounded pool, fire-and-forget lifecycle,
never-fail).

The core idea in one sentence: **a stable-key task that the cache
confirms is a local hit is removed from the scheduler and restored on a
background pool, with its probe result handed to nobody-re-probes — and
every other task behaves exactly as today.**

## Concrete spec

### New module: `src/orchestrator/local-shortcircuit.ts`

Modeled on `remote-prefetch.ts`. Exposes one entry point:

```ts
export interface ShortCircuitArgs {
  nodes: Map<string, TaskNode>
  cache: CacheLayer
  workspaceRoot: string
  workspaceFingerprint: string
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
  cachePolicy: CachePolicy
  concurrency: number
}

export interface ShortCircuit {
  /**
   * Tasks resolved AHEAD of scheduling: a stable key, a confirmed
   * local hit, restored (or confirmed up-to-date) on the background
   * pool. Keyed by task id. The orchestrator passes these to runGraph
   * as PRE-RESOLVED so the scheduler skips execute() and uses them to
   * unblock dependents.
   */
  resolved: Map<string, TaskOutcome>
  /** Await before cache.close() — the restore pump may still be running. */
  done: Promise<void>
}

export function startLocalShortCircuit(args: ShortCircuitArgs): ShortCircuit
```

The function:

1. **Returns immediately** with an empty `resolved` and a settled `done`
   when the short-circuit cannot help — _this is the warm-path / opt-out
   guard, see §gating_. The decision must be cheap (a flag check), not a
   pass over the graph.

2. Otherwise derives stable keys **exactly** as `deriveStableKeys` in
   `remote-prefetch.ts` does — same `topoOrder`, same `synthUpstream`,
   same `dependsOnSiblingOutputs` instability rule, same `hashCache`
   reuse. _Factor `deriveStableKeys` + its helpers out of
   `remote-prefetch.ts` into a shared file_ (e.g.
   `src/orchestrator/stable-keys.ts`) so the two callers cannot drift.
   This is a prerequisite refactor, behavior-preserving.

3. For each stable, cache-enabled, **local-read-enabled** task, probe
   `cache.get(hash, ctx)` and run the _same_ skip-restore /
   clean+restore logic that `executeCachedTask` runs on a hit. On a
   confirmed hit, restore (or confirm up-to-date), build the `TaskOutcome`
   (status `cache-hit`, `restored` flag, `durationMs` = restore time,
   `wallclockStartNs/EndNs` anchored to `runStartHrTimeNs`), and put it
   in `resolved`. A **miss** is left out entirely — that task stays in
   the normal schedule and behaves identically to today.

4. Restores run on a **bounded pump** (`Math.min(concurrency, n)`),
   fire-and-forget from the caller's perspective; the caller awaits
   `done` before `cache.close()` (same lifecycle contract as
   `prefetchDone` in `run.ts:608`).

### The do-less requirement: how `execute()` avoids re-probing

This is the crux — the prior `classify.ts` regression was _entirely_
"probe twice." Two ways to satisfy "no second pass," in order of
preference:

**Preferred (Phase 1): remove short-circuited tasks from `execute()`
entirely.** The orchestrator passes `resolved` to `runGraph`. The
scheduler, for any node in `resolved`, **never calls `execute()`** — it
treats the node as already-finished: emit `onStart` (optional — see
ordering §) + `onFinish(resolved.get(id))`, and unblock dependents via
the existing `finishOne` machinery. Because `execute()` is never called
for these nodes, there is _no_ second probe by construction. The restore
already happened in the background; the scheduler just records the
outcome. This is strictly _less_ work than today (one probe + one restore
instead of one probe + one restore, but overlapped) and **zero** extra
work for non-short-circuited tasks.

The scheduler change is small and additive:

```ts
// in runGraph, ScheduleOptions gains:
preResolved?: ReadonlyMap<string, TaskOutcome>

// in tick(), before active++/execute():
const pre = preResolved?.get(id)
if (pre) { onStart?.(node); finishOne(id, pre); continue }
```

`finishOne` already unblocks dependents and calls `onFinish`. The
`failedDep` skip check (`scheduler.ts:240`) still runs _before_ this — so
a short-circuited task whose dep failed is handled by §skipped (which we
deliberately bypass — see correctness §).

**Why not thread the probe result into `executeCachedTask` instead?**
That's the "execute reuses the classification probe" path the decision
log suggested. It's _more_ invasive: `executeCachedTask` would need an
optional `preProbed?: { hit: CacheEntry; skipRestore: boolean }` arg, and
every branch (clean, restore, mark-git-changed, replay stdout, build
outcome) would need to handle "already restored in the background."
Removing the node from the schedule (preferred path) sidesteps all of it
— the restore _and_ outcome construction happen in one place
(`local-shortcircuit.ts`), reusing extracted helpers from
`executeCachedTask`. Phase 1 takes the preferred path. The `preProbed`
threading is only needed if we ever want partial overlap (probe early,
restore in `execute()`), which we don't.

### Wiring in `run.ts`

After `markSurfacedDeps` / counts, before `runGraph` (alongside the
existing `startRemotePrefetch` block at `run.ts:286-300`):

```ts
let shortCircuit: ShortCircuit = { resolved: new Map(), done: Promise.resolve() }
if (shouldShortCircuit(options, nodes, policy)) {
  shortCircuit = startLocalShortCircuit({ ...args, cachePolicy: policy, concurrency })
}
```

Pass `preResolved: shortCircuit.resolved` into `runGraph`. Await
`shortCircuit.done` next to `await prefetchDone` (`run.ts:608`) before
`cache.close()`.

Note the **timing constraint**: `resolved` must be populated _before_
`runGraph` reaches each short-circuited node. Because a stable-key hit's
deps are (by the stability gate) either upstreams whose outputs it
doesn't read, its restore does not depend on the schedule's progress —
but the _scheduler_ must see the entry when it gets to that node. Two
sub-options:

- **1a (simplest, recommended first slice):** `await` the probe phase
  (key derivation + `cache.get` for all stable tasks) but **not** the
  restores, before calling `runGraph`. Populate `resolved` synchronously
  with the _decision_ (hit + which to restore); kick the restores off in
  the background; the scheduler skips those nodes immediately. The probe
  phase is the same `cache.get` SQL the tasks would do anyway, just
  hoisted — but **only for stable, cacheable, local-read tasks, and only
  when the short-circuit is active** (see gating). The restore I/O
  overlaps execution. Risk: the probe phase adds a small pre-schedule
  latency. Bounded by stable-task count; measured in §5.

- **1b (more overlap, more complexity):** don't await the probe phase;
  let the scheduler race the background resolver. Requires the scheduler
  to _also_ handle "node became ready before its `resolved` entry
  landed" — i.e. a node could reach `tick()` and not yet be in
  `resolved`, then run normally (correct but loses the win for that
  node), OR we hold it. This introduces a race and a "did we win?"
  nondeterminism. **Rejected for Phase 1** — start with 1a's
  deterministic await; revisit only if the probe-phase latency is
  measurable.

### Gating (`shouldShortCircuit`) — the perf firewall

The function returns `false` (no-op, byte-identical to today) unless
**all** hold:

- `policy.localRead` is true (a `--no-cache` / `--force` /
  `--cache=local:` run reads nothing locally → nothing to short-circuit;
  see §--no-cache).
- The graph has at least one task with a dep — a flat graph has no
  ordering edges to relax.

Deliberately **not** gated on `LayeredCache`: unlike remote-prefetch,
this is a _local_ optimization and applies to local-only runs (the
common `vx run` case). That is the whole point — the user's repro is
local-only.

**The warm-path question.** A warm all-hit run _would_ qualify under the
above (it has deps, local reads on). To keep it free we must ensure the
probe phase is not _additional_ work. It isn't, under 1a, _if_ we accept
one subtlety: on a warm all-hit run, the short-circuit probes + restores
**every** stable task ahead of the schedule, and the schedule then does
_nothing_ (every node is pre-resolved). So total work = N probes + N
restores, same as today, just reordered and parallelized. The risk is
_not_ double work (there is none — `execute()` is skipped); the risk is
**losing the lazy-resolution ordering** that the current code relies on
for same-project codegen tasks. The stability gate prevents that
(unstable tasks are never short-circuited and resolve lazily as today).

The one _measurable_ risk in the warm case is the bounded-pool overhead

- the upfront key-derivation pass being on the critical path instead of
  amortized across the schedule. **This is exactly what §5 measures, and
  the kill-switch in §7 (a `defineWorkspace` opt-in for Phase 1) caps the
  blast radius.**

### Files touched

- `src/orchestrator/stable-keys.ts` — **new**, extracted from
  `remote-prefetch.ts` (`deriveStableKeys`, `synthUpstream`,
  `dependsOnSiblingOutputs`, `topoOrder`). Behavior-preserving refactor.
- `src/orchestrator/remote-prefetch.ts` — import the extracted helpers.
- `src/orchestrator/local-shortcircuit.ts` — **new**, the resolver.
- `src/orchestrator/execute-task.ts` — extract the hit-handling block
  (`execute-task.ts:240-346`: skip-restore determination + clean +
  restore + git-change marking + outcome build) into an exported helper
  `restoreHit(args, hash, hit): Promise<TaskOutcome>` that both
  `executeCachedTask` and `local-shortcircuit.ts` call. **No behavior
  change** to `executeCachedTask` — pure extraction.
- `src/graph/scheduler.ts` — add `preResolved?` to `ScheduleOptions` +
  the four-line skip in `tick()`.
- `src/orchestrator/run.ts` — wire `startLocalShortCircuit`, pass
  `preResolved`, await `done`.

### Versioning

**No `CACHE_VERSION` bump, no `SCHEMA_VERSION` bump.** This changes only
_when_ a local probe/restore fires, never the key derivation
(`computeTaskHash` / `Cache.key` are untouched) nor the artifact bytes.
The decision log's invariant ("purely about WHEN the local probe/restore
fires") holds by construction. No wire/on-disk format changes, so no
sentinel to bump.

## Correctness analysis

### The output-cleaning race

`executeCachedTask` cleans then restores declared outputs
(`execute-task.ts:297-302`). If a still-running upstream writes to paths
this task's restore touches, an early restore could:

- restore D's outputs, then U overwrites them (D's restored bytes lost), or
- D's clean wipes a path U is mid-write to.

**When can an upstream write where a stable-key downstream restores?**

The stability gate (`dependsOnSiblingOutputs`) already excludes a task if
a **same-project** upstream declares `cache.outputs.files`, or if the
task reads `inputs.workspaceFiles` and any upstream declares
`outputs.workspaceFiles`. Project boundaries are hard
(`docs/architecture.md` principle 6): a project's project-relative
outputs land only in its own dir, and another project's globs never
reach in. So:

- **Same-project upstream with declared outputs** → already excluded
  (unstable). The exact case where an upstream could write into D's
  project dir is gated out.
- **Cross-project upstream** → its project-relative outputs land in
  _its_ dir, never D's. D's project-relative outputs land in D's dir.
  No overlap by the boundary rule.
- **Workspace-outputs (the no-boundary escape hatch)** → root-anchored
  outputs _can_ land anywhere. The gate already marks a task unstable if
  it reads `workspaceFiles` and an upstream writes `workspaceFiles`. But
  there's a residual case the _remote_ prefetch tolerates because remote
  prefetch never writes to the project tree — it only ingests bytes into
  the local cache DB. **Our short-circuit DOES write to the tree
  (restore).** So we need one _extra_ guard the remote path doesn't:

  > **A task is short-circuit-eligible only if no upstream (any project)
  > declares `cache.outputs.workspaceFiles` whose static prefix could
  > overlap this task's restore targets** (its `outputs.files` under its
  > project dir, or its own `outputs.workspaceFiles`).

  The cheap conservative version: **exclude any task from short-circuit
  if ANY task in the graph declares `outputs.workspaceFiles`.** Workspace
  outputs are the documented bad-practice escape hatch; they're rare; a
  blanket exclusion is safe and simple. Refine later only if a real
  workspace hits it. (The stability gate already handles the common
  cases; this is belt-and-suspenders for the boundary-ignoring hatch.)

**Conclusion:** with (a) the existing stability gate and (b) the extra
"no `outputs.workspaceFiles` in the graph" exclusion, no running upstream
can write where a short-circuited task restores. The race is precluded,
not merely unlikely. This must be covered by a test (codegen-into-shared
case → not short-circuited; cross-project → short-circuited, no race).

This also relies on the single-run safety reasoning already documented:
within one `vx run` the scheduler is the only writer, and
content-addressing means a restored hit is correct for its input hash
regardless of concurrent activity it doesn't overlap (see
`docs/design/execution-service-2026-06.md` §3 on continue-and-supersede
— "stale is a label, not a correctness problem"). The cross-run /
`vx serve` concurrent-output story (output RW-locks) is **out of scope**
here exactly as it is for the rest of `vx run` today.

### Skipped-on-dep-failure (the subtle one)

Today: if an upstream fails, `scheduler.ts:240-243` marks every dependent
`skipped` (status `skipped`, not run). A short-circuited task is restored
_before_ its dep's outcome is known — so it would be reported `cache-hit`
even if its dep later fails.

**Is that correct?** Decompose:

1. **Is the restored artifact valid?** Yes, unconditionally. The key
   folds the upstream's _input_ hash (pure-input transitive hashing —
   `upstream.ts`, the v22 model), never the upstream's _success_ or
   _output_. A cached hit for key K means "for this exact input
   fingerprint, here is the recorded output." The upstream _failing this
   run_ does not change D's input fingerprint (the inputs are the same
   files/config/env that produced the cached entry). So D's cached output
   is genuinely the correct output for D's inputs. Restoring it is not
   wrong.

2. **Does vx's contract expect the dependent to be skipped?** Today's
   contract is "if a dep fails, don't _run_ the dependent" — because
   running it might consume the dep's (missing/broken) output, or because
   continuing is pointless when an upstream is broken. The _intent_ is
   "don't do downstream work on a broken upstream."

These two pull in opposite directions. The honest analysis:

- A stable-key hit's correctness does **not** depend on the dep
  succeeding (point 1). The cached bytes are valid.
- But **reporting** `cache-hit` for a task whose dep failed changes
  user-visible behavior: today the user sees `skipped`; with the
  short-circuit they'd see `cache-hit`. That's a _semantic_ change to
  what a failed run looks like, even though it's arguably _more_ correct
  (the task's result really is cached and valid).
- Worse: there's a **timing nondeterminism** if we don't pin it. Whether
  D shows `skipped` or `cache-hit` would depend on whether the
  short-circuit resolved D before or after U failed — exactly the kind of
  flaky, schedule-dependent output we must never ship.

**Decision (recommended):** **Short-circuit only resolves the restore;
it does not pre-empt the skip semantics. The short-circuited task's
outcome is committed to the scheduler the moment the schedule reaches its
node — and at that point the existing `failedDep` check still runs
first.**

Concretely, in the scheduler's `tick()`, order matters:

```ts
const upstream = node.deps.map((d) => outcomes.get(d) as TaskOutcome)
const failedDep = upstream.find((u) => u.status === 'failed' || u.status === 'skipped')
if (failedDep) {
  finishOne(id, { ...skipped })
  continue
} // unchanged, runs FIRST
const pre = preResolved?.get(id)
if (pre) {
  onStart?.(node)
  finishOne(id, pre)
  continue
} // new, runs AFTER
```

Because the scheduler only reaches D _after_ all D's deps have completed
(D is still in the normal `pending`/`ready` flow for _scheduling
order_ — we do NOT relax that; we only skip `execute()`), the
`failedDep` check sees the real dep outcomes. So:

- **Dep failed** → D is reported `skipped`, identical to today. The
  background restore _already wrote D's outputs to disk_ — a minor
  wasted I/O, and a tree-state question: D's outputs are now present
  even though D is "skipped." This is acceptable and arguably fine (the
  outputs are valid), but to be byte-faithful to today's "skipped =
  nothing happened" we should **not restore D's outputs if any dep could
  fail** — OR accept that a skipped-but-restored task leaves valid bytes.
  **Recommendation:** keep it simple — the restore is harmless (valid
  bytes), and a failed run is already an error state the user is
  debugging. Document it. (If the owner wants strict parity, Phase 2 can
  defer the _restore_ until the scheduler confirms no dep failed, keeping
  only the _probe_ early — but that loses most of the overlap win and
  adds the `preProbed` threading we avoided.)

- **Dep succeeded** → D is reported `cache-hit`, restore already done,
  overlapped. The win.

**This decision keeps the failure-path output deterministic and
identical to today.** The short-circuit is a pure latency optimization on
the _success_ path; it never changes what a failed run reports.

Crucially, this means we **keep D in the normal scheduling order** (its
`pending` still counts down as deps finish) and only skip the
`execute()` _subprocess/probe_ — the restore having been hoisted. The
"don't wait for compute" win comes from the restore overlapping the deps'
runtime, while the _reporting_ still happens in dependency order. The
user's 76ms→overlap win is preserved (the restore I/O overlaps U's run);
D's _outcome line_ still prints after U's, which is fine — the work was
done early.

> **Re-read of the win:** D's restore happens at t≈1 (background,
> overlapped with U). D's outcome is _recorded_ at t=76 when the schedule
> reaches it. So the user-visible _latency_ win is "the restore I/O
> didn't serialize after U's run" — on a single D it's ~2ms saved; on a
> wide layer of many stable hits behind one slow miss, it's
> `sum(restore times)` saved (they all overlapped the miss instead of
> queuing behind it on the worker pool). **That** is where the win
> compounds: the restores don't consume exec-pool worker slots behind
> the slow tasks. This reframes the win as "restores no longer compete
> with execs for the concurrency budget," which is more valuable than the
> single-task example suggests and is the strongest argument for
> building it.

### Ordering / logger implications

The focused-flow live framing assumes one requested task owns the
terminal between its `┌─`/`└─` brackets (`logger.ts:289-291`,
`streamsLive`). A short-circuited task:

- If it's a **dependency** (not requested/surfaced) → it never streamed
  live anyway; its outcome flows through `taskComplete` → a quiet-hit
  one-liner or silence (broad/focused-dep). Resolving it early but
  _reporting_ it in schedule order (per the skipped-decision above) means
  the logger sees `taskComplete(D, cache-hit)` at the same point in the
  sequence it would today. **No logger change.**

- If it's the **requested** task itself (focused, single) → today it
  gets a live frame (`taskStart` opens, hit replay streams, `taskComplete`
  closes). We must preserve that. Two choices: (i) **don't short-circuit
  requested/surfaced focused tasks** — they're the thing the user is
  watching; the overlap win on the _requested_ task is marginal (it's
  usually the leaf) and the framing is load-bearing. Recommended:
  **exclude `node.requested || node.surfaced` from short-circuit.** This
  keeps the entire focused-live-frame path byte-identical and removes a
  whole class of ordering risk. The win is on the _dependency_ layers
  anyway (the user's `docs#build` is a dep of nothing requested in the
  repro? — actually it's the requested one; see note).

  > **Note on the repro:** in the user's example `docs#build` is the
  > requested task and `docs#import` its dep. If we exclude requested
  > tasks, the repro's _specific_ task isn't short-circuited. BUT the
  > restore-vs-run overlap the user wants still needs handling. Resolution:
  > exclude requested tasks from short-circuit **only in focused-live
  > mode with a single requested task** (where the frame is load-bearing);
  > in broad/CI/multi-requested modes the requested task buffers into an
  > atomic block (`logger.ts:447-481`) and _can_ be short-circuited
  > safely. For the single-focused repro, the honest answer is the win is
  > ~2ms on the one task and the live frame matters more — so we accept
  > the frame. If the user's real pain is a _wide_ set of cached builds
  > behind a prep step (`vx run build --all` style, broad mode), that's
  > broad mode and fully short-circuited. **Clarify the real workload
  > with the owner before Phase 1** — it determines whether the
  > single-focused exclusion costs the user their win.

- `onStart?(node)` for a pre-resolved node: emitting it drives the live
  status region's worker-slot bookkeeping. Since the node never occupies
  a worker slot (no `execute()`), we should **not** call `onStart` for
  pre-resolved nodes (it would allocate then immediately free a slot).
  Just `finishOne` → `onFinish` → `taskComplete`. The status region's
  counters update via `taskComplete` as normal.

### Interaction with `--no-cache` / `--force` / `--frozen`

- **`--no-cache`** (`policy` all false): `localRead` false →
  `shouldShortCircuit` returns false → no-op. Identical to today (tasks
  re-execute).
- **`--force`** (reads off, writes on): `localRead` false → no-op. Tasks
  re-execute and refresh the cache, as today. Correct — `--force` _means_
  "re-run everything," short-circuiting a restore would defeat it.
- **`--cache=local:r` / `local:rw`**: `localRead` true → eligible. A
  read-only local policy short-circuits hits (correct — restore is a
  read).
- **`--frozen`**: orthogonal. Frozen loads configs from the lock; key
  derivation is identical; short-circuit operates on the resulting graph
  unchanged.

### LayeredCache vs local-only `Cache` — gating, and unification with remote prefetch

Remote prefetch is gated on `cache instanceof LayeredCache`
(`run.ts:287`) and never touches local. This short-circuit is the
**inverse**: it's local-first and runs for _both_ local-only and layered
caches. The two compose cleanly:

- **Local-only run:** remote-prefetch is skipped (no LayeredCache);
  short-circuit derives stable keys, probes local, restores hits early.
  This is the user's case.
- **Layered run:** remote-prefetch already fires (warming local from
  remote in the background); short-circuit's local probe will then find
  entries remote-prefetch ingested. **Ordering matters:** if
  short-circuit probes _before_ remote-prefetch has ingested, it sees a
  local miss and leaves the task in the schedule (correct — lazy
  read-through in `execute()` still resolves it via the LayeredCache's
  inflight de-dup). So a stable task that's only a _remote_ hit won't be
  short-circuited (it'll resolve through `execute()`'s `cache.get`, which
  awaits the in-flight remote prefetch — exactly today's behavior). That's
  fine: the remote case is already overlapped by remote-prefetch.
  Short-circuit's added value is purely the _local_ hit's restore.

  **Should we unify?** Both modules derive the same stable keys (the
  extracted `deriveStableKeys`). It's tempting to merge into one
  "prefetch + short-circuit" pass. **Recommendation: keep them separate
  modules but share the stable-key derivation.** They have different
  gates (LayeredCache vs always), different actions (ingest-to-local vs
  restore-to-tree), different correctness envelopes (remote never writes
  the tree; local does — hence the extra workspace-outputs guard). One
  shared `stable-keys.ts`, two thin callers. Merging the _derivation_
  removes the drift risk the decision log cares about; merging the
  _actions_ would entangle two different correctness stories.

## Benchmark / measurement plan (guards the prior 57% regression)

The non-negotiable: **prove the warm and local-only-no-win paths are not
slower.** Use the existing `bench/compare.ts` harness shape (it already
generates a 1090-pkg layered repo and measures fresh / warm-no-restore /
warm-restore at a pinned concurrency).

Add a new bench scenario file `bench/shortcircuit.ts` (or extend
`compare.ts`) measuring **A/B with the feature on vs off** (the kill
switch from §7 makes A/B a one-flag flip — measure the _same binary_
both ways to isolate the change):

1. **Warm all-hit (the landmine).** 1090 pkgs, all tasks cacheable, run
   twice, measure the second run's wall time. **Acceptance: median(on)
   ≤ median(off) + noise (≤2%).** This is the case `classify.ts`
   regressed 57%; it is the gate. Run ≥9 reps, report median + p90.
   _Sub-measurement:_ time the pre-schedule probe phase in isolation
   (instrument `startLocalShortCircuit`'s derivation+probe vs restore) to
   confirm the upfront pass isn't on the critical path more than the
   amortized lazy probes it replaces.

2. **Warm-restore all-hit.** Outputs deleted, all hits, run. Tests the
   restore pump under full load (every task restores). **Acceptance:
   ≤ off + 2%**, ideally faster (restores parallelize across the pool
   instead of serializing through the schedule).

3. **The target case — slow upstream, cached downstream.** A generated
   shape: a non-cacheable `prep` task (`sleep 0.5`) that each cached
   `build` depends on (ordering only, no shared outputs). Measure
   wall time. **Acceptance: median(on) < median(off)** — this is the win;
   if it doesn't show here, the feature isn't worth it. Expect the win to
   scale with the _width_ of the cached layer behind the slow prep (many
   restores overlapping one slow run).

4. **Mixed partial-hit (cold-ish).** Half the deps miss and run
   (`BUILD_SLEEP=1`), half their stable-key descendants hit. Measure.
   **Acceptance: ≤ off** (no regression) and ideally faster (descendant
   restores overlap the misses).

5. **Local-only flat graph (no deps).** Confirms `shouldShortCircuit`
   short-circuits-out cheaply — **≤ off + noise**.

6. **`--no-cache` / `--force`.** Confirm byte-identical timing to off
   (the gate returns false).

Also: a **correctness** test matrix in `tests/` (not bench), pinning:
codegen-into-shared-project dep → not short-circuited (no race);
cross-project stable hit → short-circuited, outputs correct;
dep-failure → short-circuited task reports `skipped` (deterministic,
identical to today); workspace-outputs present → short-circuit disabled
graph-wide; requested single-focused task → frame byte-identical.

Profile with `bun --cpu-prof` on scenario 1 and confirm there is **no
second `cache.get` / `loadOutputFilesBatch` / stat pass** per task — the
exact signature of the `classify.ts` regression.

## What's out of scope

- **Cross-run / `vx serve` concurrent-output safety** (output RW-locks,
  global scheduler). Same out-of-scope boundary as the rest of `vx run`.
  See `docs/design/execution-service-2026-06.md`.
- **Threading the probe into `executeCachedTask` (`preProbed`)** — the
  preferred Phase 1 design removes the node from `execute()` entirely, so
  this is unnecessary. Only revisit for a probe-early/restore-late
  variant, which we reject.
- **Short-circuiting the _requested single-focused_ task** — its live
  frame is load-bearing; excluded (see ordering §). Pending the owner
  clarifying whether the real workload is broad (fully covered) or
  single-focused (the frame wins).
- **Workspace-outputs-aware fine-grained overlap detection** — Phase 1
  disables short-circuit graph-wide if any task declares
  `outputs.workspaceFiles`. Fine-grained prefix-overlap analysis is a
  later refinement only if a real workspace needs it.
- **Unifying remote-prefetch and short-circuit into one action pass** —
  share derivation only; keep actions separate.
- **`--dry`/`--graph` / `plan.ts`** — planning already predicts hits
  upfront and doesn't execute; no short-circuit needed there.

## Open questions

1. **What is the user's real workload?** Single-focused `vx run build`
   (where the requested task is the hit, frame is load-bearing — the
   win is ~2ms on one task) or broad `vx run build --all` (wide cached
   layer behind a prep step — the real, compounding win)? This
   determines whether the single-focused exclusion costs them the win.
   **Resolve before Phase 1.** If it's the former, the honest answer may
   be "the live frame matters more than 2ms" → lean toward §7's
   do-nothing.
2. **Strict skipped parity vs. harmless restore?** When a dep fails,
   should a short-circuited task's already-restored outputs be left on
   disk (valid bytes, but the task shows `skipped`)? Recommended: leave
   them, document. Owner may want strict "skipped = nothing touched."
3. **Kill-switch shape.** `defineWorkspace({ shortCircuit: false })`
   opt-out (default on) vs. opt-in for Phase 1? Given the landmine,
   recommend **opt-in for Phase 1** (`shortCircuit: true`), flip to
   default-on once benches prove warm parity across a few real repos.

## Why this is the right move (if we build it)

- **Reuses proven machinery.** The stable-key gate, key-derivation
  reuse, bounded pool, and never-fail lifecycle are _already shipped_ in
  `remote-prefetch.ts`. We extract and re-point, we don't invent.
- **Provably free on the warm path by construction** — the short-circuit
  _removes_ nodes from `execute()` rather than adding a second probe, so
  there is no double-work (the exact failure mode that killed
  `classify.ts`). The only residual risk is upfront-pass scheduling,
  which the bench gate (§5 scenario 1) directly measures and the
  opt-in kill-switch contains.
- **No CACHE_VERSION / SCHEMA bump** — purely changes _when_ the local
  probe/restore fires; key + bytes untouched. Zero user-facing cache
  churn.
- **The compounding win is real on mixed graphs** — restores stop
  competing with execs for worker slots behind slow tasks; the win
  scales with the width of cached layers behind misses, not just the
  single-task example.
- **Failure-path output stays deterministic and identical** — the skip
  semantics run before the pre-resolved skip in the scheduler, so a
  failed run reports exactly as today.

## Honest counter-argument (read before approving)

The single-task win is ~2ms and the user's specific repro is a _focused
single requested task_ whose live frame we'd rather not disturb. The
big win (wide cached layers behind a slow prep) is a less common shape,
and a warm all-hit run — the most common repeated `vx run` — gets **zero
upside** and is the exact case a prior attempt regressed badly. The risk
is concentrated entirely in the hottest path.

If the owner's workload is predominantly warm all-hit or single-focused,
the defensible decision is **D (do nothing)** — or ship Phase 1 strictly
opt-in (`defineWorkspace({ shortCircuit: true })`) so only workspaces
with the slow-prep shape pay any attention to it, and the default path
is byte-identical to today. That is the recommended risk posture:
**build Option A, ship it opt-in, prove warm parity, then consider
default-on.**
