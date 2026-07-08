# Resource-aware scheduling — design

> **Status:** SHIPPED (2026-07-08, all three phases — feature, footer
> budget line, `RunRequest.memory` wire). The spec below is the
> implemented contract.
>
> Owner-requested. The model (`exec.resources: { cpus, memory }`, default 0,
> percent-or-number, admission-not-enforcement) is **LOCKED**. This doc makes
> it precise and implementation-ready against the current two-tier
> `ReadyHeap` scheduler.

## What we're solving

Today the scheduler admits a ready task on ONE constraint: the running
count is below `concurrency` (`src/graph/scheduler.ts:389`). Every task
costs exactly one slot. That's wrong for heterogeneous graphs: a 12 GB
linker, a 6-core type-check, and a near-free `lint` each take one slot,
so a run either over-subscribes RAM/cores (OOM, thrash) or under-uses
them behind a too-conservative `--concurrency`.

We add **per-task resource reservations**: a task declares CPU and
memory demand, and the scheduler packs ready tasks so concurrent
reservations never exceed a budget on either axis — 2-D bin-packing
admission layered on the existing count limit. Turbo and Nx have nothing
like it (flat task-count concurrency only); Bazel's local resources are
the precedent.

**Admission control, not enforcement.** vx uses the numbers only to
decide what to co-schedule. It does NOT cgroup-limit, nice, or kill a
task that exceeds its declaration — that stays the job of `exec.timeout`
and the OS. State this everywhere the feature surfaces.

Hot-path constraints:

- The admission check runs in the scheduler's inner loop → the resolved
  cost must be a plain `Map.get`, never a parse. Parse/percent-resolve
  ONCE up front in `run.ts`; budgets computed once per run.
- Every existing config declares nothing → cost 0 → must hit a path
  byte-identical to today (no admission math, no parking, same keys).

## The model (locked, restated precisely)

One new optional object on `ExecConfig` (`src/config.ts`), beside
`timeout` and `retries` — grouped so a future axis (gpu, custom) slots in
without new top-level fields:

```ts
exec: {
  command: 'vitest run integration',
  resources: { cpus: 4, memory: '2GB' },   // or: { cpus: '50%', memory: '25%' }
}
```

| Field                   | Type                           | Default | Meaning                                 |
| ----------------------- | ------------------------------ | ------- | --------------------------------------- |
| `exec.resources.cpus`   | `number \| "<n>%"`             | `0`     | CPU units, or percent of the CPU budget |
| `exec.resources.memory` | `number \| "<size>" \| "<n>%"` | `0`     | bytes, a size string, or percent of RAM |

- `cpus`: a `number` is CPU units (fractional allowed, `0.5`); `"<n>%"`
  is percent of the CPU budget — `cpus: "50%"` on an 8-unit budget → 4.
- `memory`: a `number` is bytes; a size string is `"2GB"` / `"512MB"`
  (K/M/G/T, powers of 1024, the existing `parseSize`); `"<n>%"` is
  percent of the memory budget.
- **Default `0` = reserve nothing, run freely.** A task that declares
  `0` (or omits the field) is NOT gated on that axis — only the existing
  concurrency-count limit applies. Reservations coordinate among tasks
  that opt in. Every current config is byte-identical, in scheduling AND
  in cache keys.

### Budgets (what `%` resolves against; both overridable)

- **CPU budget** = the run's `concurrency`
  (`options.concurrency ?? workspaceConfig?.concurrency ?? core count`,
  `src/orchestrator/run.ts`). `cpus: 1` degrades to old count semantics;
  `cpus: 4` on a budget of 8 means at most two at once.
- **Memory budget** = `os.totalmem()`, overridable with a new
  `--memory <size>` CLI flag + workspace `memory` field.
  - **Container caveat (document prominently):** in a cgroup-limited
    container `os.totalmem()` reports the HOST's RAM, not the limit — a
    `"50%"` reservation can badly over-admit. CI/container users should
    pass `--memory` (or set workspace `memory`) to the real limit.
  - When no task declares memory the axis is a no-op (see the gate).

### Admission (2-D)

A ready task is admitted only when ALL hold:

1. `running-count < concurrency` (unchanged), AND
2. `reservedCpu + cpu ≤ cpuBudget`, AND
3. `reservedMem + mem ≤ memBudget`,

with three encoded rules:

- **Zero never blocks.** A `0` cost is exempt from that axis entirely
  (needs no headroom, reserves none) — the "run freely" law.
- **Highest-priority-first, with backfill.** Pop order stays
  (priority DESC, enqueue-seq ASC). When the head doesn't fit, smaller
  ready tasks behind it may be admitted (backfill) while it waits.
- **Solo-clamp (no deadlock).** A task whose reservation exceeds a whole
  budget can never satisfy rule 2/3; it is admitted alone on that axis
  (when `reserved === 0`). An idle pool always admits at least one ready
  task, so the run can never deadlock.

### Cache key

`cpus`/`memory` are scheduling hints with zero effect on outputs, so
they are **stripped from `hashTaskConfig`** before hashing. Tuning a
reservation never busts a cache. **No `CACHE_VERSION` bump** — see §4.

## Recommendation

Ship the locked model as a 2-D admission gate on the existing two-tier
scheduler: resolved once in `run.ts` into an `id → {cpu, mem}` map that
is **omitted entirely when no task opts in** (the single gate that keeps
every current run byte-identical); backfill via park-within-tick (keeps
the heap O(R log R) and the exact priority + FIFO-among-equals
contract); restores reserve 0; the `resources` object stripped from the
key (a one-key drop — grouping makes the strip trivial). Rejected
alternatives: flat `exec.cpus`/`exec.memory` (owner picked the grouped
object — extensible to a third axis without new top-level fields),
enforcement via cgroups/rlimits (a hint, not a cap), and CPU-only slot
weighting (memory is the axis that actually OOMs CI).

---

## Concrete spec

### 1. Schema (`src/config.ts`)

Add to `ExecConfig` after `retries`, plus an exported `ResourcesConfig`:

```ts
/**
 * Resource RESERVATIONS for admission control (NOT enforcement — vx does
 * not cgroup-limit the task; it only decides what to co-schedule). Each
 * axis defaults to 0 = reserve nothing: the task runs subject only to the
 * concurrency-count limit. A pure scheduling hint — the whole object is
 * stripped from the cache key, so tuning it never invalidates a result.
 */
export interface ResourcesConfig {
  /** CPU units (fractional ok), or a "<n>%" string of the CPU budget
   *  (the run's concurrency). */
  cpus?: number | string
  /** Bytes, a size string ("2GB", "512MB" — powers of 1024), or a "<n>%"
   *  string of the memory budget (os.totalmem() or --memory). */
  memory?: number | string
}

// on ExecConfig:
resources?: ResourcesConfig
```

Type the axes `number | string` (not a template-literal type) so the
loader owns validation with a clear message instead of a cryptic TS error.

### 2. The resolver (new `src/orchestrator/resources.ts`, pure)

Budget-parameterized and pure — unit-testable without a scheduler.

```ts
export interface ResourceCost {
  cpu: number
  mem: number
} // absolute; cpu may be fractional
export const ZERO_COST: ResourceCost = { cpu: 0, mem: 0 }

export function resolveCpu(v: number | string | undefined, cpuBudget: number): number
export function resolveMem(v: number | string | undefined, memBudget: number): number

// Whole graph → id → cost, OMITTING zero-cost tasks: an empty map means
// "no reservations declared" — the gate everything else keys off.
export function resolveResourceCosts(
  nodes: Map<string, TaskNode>,
  cpuBudget: number,
  memBudget: number,
): Map<string, ResourceCost>
```

Rules: `undefined` → 0; `cpus` number → itself; `"<n>%"` →
`(pct / 100) * budget`, kept fractional (rounding is display-only);
`memory` number → bytes; size string → `parseSize`; percent → as cpus.
`resolveResourceCosts` reads each node's `config.exec?.resources` and
inserts an entry only when `cpu > 0 || mem > 0`.

**Boundary fix — move `parseSize` to `util`.** It lives in
`src/cli/cache.ts`, and `orchestrator` cannot import `cli`
(`tests/module-boundaries.test.ts`). Move it to `src/util/index.ts` (a
leaf everyone may import) and re-export from `cli/cache.ts` so callers
and tests are unchanged. Note `parseSize` accepts integer sizes only —
`"1.5GB"` is `null` and the loader rejects it.

### 3. Loader validation (`src/workspace/project-loader.ts`)

In `validateProjectConfig`, right after the `retries` check. Form only —
no budget needed. `exec.resources` must be a plain object with ONLY the
known keys (`cpus`, `memory`) — reject unknown keys, mirroring how the
`sandbox` block is validated against a field allowlist. Then per axis:

- `cpus`: number → finite and `>= 0`; string → must match
  `/^\d+(\.\d+)?%$/` (reject `"%"`, sizes like `"2GB"`, garbage);
  anything else → error.
- `memory`: number → integer `>= 0`; string → a valid percent OR a
  `parseSize`-accepted size (reject `"%"`, `"5X"`, `"1.5GB"`); anything
  else → error.

Messages mirror the existing style:
`${where}.exec.resources.cpus must be a non-negative number or a "<n>%" string`,
`${where}.exec.resources.memory must be a non-negative integer (bytes), a size string like "512MB", or a "<n>%" string`,
`${where}.exec.resources has unknown field "gpu"`.

`persistent` + reservation is allowed and HONORED for the task's whole
lifetime — a dev server genuinely holds its RAM. (Trivially switchable in
`costOf` if it ever starves short tasks.)

### 4. Cache-key stripping (`src/orchestrator/task-hash.ts`)

`hashTaskConfig` hashes `JSON.stringify(cfg)` behind a WeakMap memo.
Project the config before hashing:

```ts
function hashableConfig(cfg: TaskConfig): unknown {
  // Fast path: nothing to strip → cfg unchanged → byte-identical bytes.
  if (cfg.exec?.resources === undefined) return cfg
  const { resources, ...execRest } = cfg.exec
  return { ...cfg, exec: execRest }
}
```

(The grouped object pays off here: the strip is a single-key drop.)

**Why no `CACHE_VERSION` bump:** a task declaring no `resources` takes
the fast path and stringifies exactly as today. A task that declares one
is by definition new (the field didn't exist), so there's no prior key
to preserve. Aside: `timeout`/`retries` are NOT stripped today (their
keys are "distinct by design" per the decision log); retro-stripping
them would bump `CACHE_VERSION` — deliberately out of scope.

### 5. Scheduler admission (`src/graph/scheduler.ts`)

The load-bearing part. Current structure: `ReadyHeap` max-heaps,
`execReady` / `restoreReady` tiers, the `active` counter, `takeReady`,
and `while (active < concurrency && …)`.

#### 5a. `ScheduleOptions` additions

```ts
/** Resolved per-task reservations. Absent id ⇒ zero cost. Undefined/empty
 *  ⇒ no reservations declared: byte-identical legacy path. */
resourceCosts?: ReadonlyMap<string, ResourceCost>
/** CPU budget. Defaults to `concurrency`. */
cpuBudget?: number
/** Memory budget. Defaults to Infinity (axis off). */
memBudget?: number
```

`ResourceCost` is declared structurally in `graph/scheduler.ts` (like
`VerifyVerdict` — graph can't import orchestrator) and re-exported via
`graph/index.ts`; `orchestrator/resources.ts` imports it from graph
(an allowed edge).

#### 5b. `ReadyHeap` — two O(1)/O(log R) additions

Backfill must not corrupt FIFO-among-equals; the seq enforces that
contract, so a repushed element keeps its ORIGINAL seq:

```ts
push(id: string, seq: number = this.next++): void  // sift-up unchanged
peekSeq(): number { return this.seq[0] ?? -1 }     // capture before pop
```

#### 5c. Backfill via park-within-tick

Naive pop-aside-and-repush per `takeReady` call would rescan the same
too-big head repeatedly and mint fresh seqs. Instead exploit an
invariant:

> Within one synchronous `tick()`, `reserved` only INCREASES (release
> happens in the async `.then`/`.catch`, which calls a fresh `tick()`).
> A task that fails `fits` now cannot become admissible later in the
> SAME tick.

So park a non-fitting executor for the rest of the tick and repush all
parked ids — with original seqs — at tick end. Each task pops at most
once per tick → O(R log R), exact ordering preserved.

**Only the exec heap can park.** Restore-tier tasks cost `ZERO_COST` by
construction (5f), so `fits` is always true for them — a restore never
parks, and no `parkedRestore` list exists.

#### 5d. Counters, `fits`, and skip-safety

```ts
const costs = options.resourceCosts
const resourcesActive = costs !== undefined && costs.size > 0
const cpuBudget = options.cpuBudget ?? concurrency
const memBudget = options.memBudget ?? Infinity
let reservedCpu = 0
let reservedMem = 0

// Restore-tier tasks cost ZERO regardless of declaration (5f).
const costOf = (id: string): ResourceCost =>
  restoreTier?.has(id) ? ZERO_COST : (costs?.get(id) ?? ZERO_COST)

// Zero never blocks; within-budget reserves; over-budget solo-clamps.
const fitsAxis = (cost: number, reserved: number, budget: number): boolean =>
  cost === 0 ? true : cost <= budget ? reserved + cost <= budget : reserved === 0

const fits = (id: string): boolean => {
  const c = costOf(id)
  return fitsAxis(c.cpu, reservedCpu, cpuBudget) && fitsAxis(c.mem, reservedMem, memBudget)
}
```

**Skip-safety (critical).** A task destined to SKIP (fail-fast, or a
failed/skipped dep with `continueMode !== 'always'`) executes nothing
and must never be parked — else a big-but-doomed task parks forever and
the run hangs. Extract ONE predicate and use it in BOTH the parker and
the tick loop's skip branch (one implementation, no drift):

```ts
const willSkip = (id: string): boolean => {
  if (failFastTripped) return true
  if (restoreTier?.has(id)) return false // restores bypass the dep check
  if (continueMode === 'always') return false
  const node = nodes.get(id)!
  return node.deps.some((d) => {
    const u = outcomes.get(d)
    return u?.status === 'failed' || u?.status === 'skipped'
  })
}
```

#### 5e. The new tick loop (sketch)

```ts
const tick = (): void => {
  if (resolved) return
  const parked: Array<[string, number]> = [] // exec tier only; local to this tick

  // Highest-priority admissible task: exec tier first (misses own the
  // pool), then restore tier (0-cost, never parks). A would-SKIP task
  // returns immediately (free); a non-fitting executor parks.
  const takeFitting = (): string | undefined => {
    while (execReady.size > 0) {
      const seq = execReady.peekSeq()
      const id = execReady.pop()!
      if (!resourcesActive || willSkip(id) || fits(id)) return id
      parked.push([id, seq])
    }
    return restoreReady.pop()
  }

  while (active < concurrency) {
    const id = takeFitting()
    if (id === undefined) break // nothing ready fits right now
    const node = nodes.get(id) as TaskNode
    const upstream = node.deps.map((d) => outcomes.get(d) as TaskOutcome)

    // Skip path — the SAME willSkip the parker used; free, no reserve.
    if (willSkip(id)) {
      finishOne(id, { node, status: 'skipped', exitCode: 1, durationMs: 0 })
      continue
    }

    // Will execute → reserve; capture the cost for a symmetric release.
    active++
    const c = costOf(id)
    reservedCpu += c.cpu
    reservedMem += c.mem
    onStart?.(node)
    execute(node, upstream)
      .then((outcome) => {
        active--
        reservedCpu -= c.cpu
        reservedMem -= c.mem
        finishOne(id, outcome)
        tick()
      })
      .catch((err) => {
        /* failed outcome as today */ active--
        reservedCpu -= c.cpu
        reservedMem -= c.mem
        finishOne(id, outcome)
        tick()
      })
  }

  // Repush parked ids with ORIGINAL seqs — exact FIFO preserved.
  for (const [id, seq] of parked) execReady.push(id, seq)

  if (outcomes.size === nodes.size && active === 0) {
    resolved = true
    resolve(outcomes)
  }
}
```

Properties:

- **Default-0 == today.** `resourcesActive` false → `takeFitting`
  short-circuits before `willSkip`/`fits`, never parks, returns exactly
  what old `takeReady` returned. Byte-identical path.
- **Release re-drives admission.** `reserved` drops in the completion
  callbacks, which already call `tick()` — parked tasks re-check
  immediately. No polling.
- **No deadlock.** `active === 0` ⇒ both reserved counters are 0 ⇒
  `fitsAxis` admits any ready task (within-budget or solo-clamped).
- **Exec still owns the pool.** Restores are reached only when no exec
  task is admissible — the two-tier "misses first, restores backfill"
  contract holds (and improves: a blocked-on-resources exec frontier now
  lets restores backfill instead of idling).

#### 5f. Restore tier reserves 0

A restore-tier task is a confirmed local cache hit: its "execution" is a
cheap tar extract, not the task's real work. `costOf` short-circuits it
to `ZERO_COST`, so it fits unconditionally and never holds budget
against a real executor. No change in `local-shortcircuit.ts` or
`execute-task.ts` — the declared cost lives on the config; the scheduler
decides when it counts.

### 6. Wiring (`src/orchestrator/run.ts`)

```ts
const cpuBudget = concurrency
const memBudget = options.memory ?? os.totalmem() // import os from 'node:os'
const resourceCosts = resolveResourceCosts(nodes, cpuBudget, memBudget)
// …thread into runGraph:
...(resourceCosts.size > 0 ? { resourceCosts, cpuBudget, memBudget } : {}),
```

Passing the three fields ONLY when the map is non-empty is the single
gate keeping every current run byte-identical. `os.totalmem()` runs once
per run.

### 7. Display (Phase 2 — one static line)

Keep the worker slots untouched. When (and only when) the cost map is
non-empty, add ONE static budget row to the footer `info` section
(`formatSummarySection`, `src/orchestrator/summary.ts`) via two new
optional `RunContext` fields:

```
  info      8 workers · local cache · cpu budget 8 · mem budget 16.0 GB
```

Memory formatted by a tiny local `formatBytes` in `summary.ts` (the
orchestrator must not import `cli/format.ts` — module boundary). No live
reserved-sum, no cost-map threading into the logger — deliberately
minimal; a live gauge can come later if the static line proves too
quiet.

### 8. Wire / delegation

Per-task `cpus`/`memory` need **no** wire field: a delegated run
re-loads and re-evaluates every project config server-side, so
reservations are recomputed where the tasks execute. The only addition
is the run-level `--memory` override (an explicit user cap that should
be authoritative wherever the run executes, like `concurrency`/`timeout`):

- `RunOptions.memory?: number` (resolved bytes; per-run knob, never
  folded into a key).
- `RunRequest.memory?: number` + one line in each protocol mapper.

The default budget (`os.totalmem()`) resolves on the executing side —
the correct machine's RAM — and an explicit `--memory` wins end-to-end.

### 9. CLI (`src/cli/run.ts`, `help.ts`)

- `--memory <size>` / `--memory=<size>`, modeled on `--timeout`: value
  through `parseSize` (now in `util`); `null` → `--memory must be a size
like 8GB or 512MB`; missing value → error. `RunArgs.memory` →
  `resolveRunOptions` sets `opts.memory`.
- Help: the flag, the container caveat, and a note that reservations are
  declared per task in config (`exec.resources`), not via CLI flags.

## Test list (the implementation contract)

**Resolver — `tests/resources.test.ts` (new):**
`resolveCpu`: `8`→8; `"50%"`@8→4; `"150%"`@8→12 (solo-clamp territory);
`"12.5%"` fractional; `undefined`/`0`→0. `resolveMem`: bytes, `"2GB"`,
`"512MB"`, `"50%"`@16 GiB, `undefined`→0. `resolveResourceCosts` returns
an EMPTY map when nothing declares.

**Loader — `tests/project-loader.test.ts`:**
accept `cpus: 2 | "50%" | 0.5`, `memory: 1024 | "512MB" | "25%"`;
reject `cpus: -1 | NaN | "%" | "2GB"`, `memory: -1 | "5X" | "1.5GB" | "%"`.

**Key stability — `tests/task-hash.test.ts` / `cache.test.ts`:**
no-declaration config hashes byte-identically (fast-path pin); a config
hashes the SAME with/without `cpus`/`memory`, and changing them doesn't
change the hash.

**Scheduler — `tests/scheduler.test.ts`:**

- undefined/empty `resourceCosts` ⇒ order byte-identical (legacy pin;
  existing suite must pass unchanged).
- CPU axis: two `cpus:4` @ budget 8 run concurrently; two `cpus:5`
  serialize. Memory axis analogous.
- Combined: fits-CPU-but-not-memory waits until memory frees.
- Backfill: running `cpus:6`, head `cpus:4` parks, lower-priority
  `cpus:2` admits.
- Solo-clamp / no-deadlock: `cpus:16` @ 8 runs alone from idle; a
  `cpus:1` waits while a `cpus:0` runs alongside; an all-`cpus:16`
  graph completes one-at-a-time.
- Skip-safety: a too-big task whose dep failed SKIPS (doesn't park
  forever); run terminates.
- Restore tier reserves 0: a restore declaring `cpus:8` admits alongside
  a running `cpus:8` executor.
- FIFO-among-equals: equal-priority fitting tasks admit in enqueue order
  even after a sibling parked and repushed (original-seq pin).

**CLI / wire — `tests/cli.test.ts` + protocol round-trip:**
`--memory 8GB` / `=512MB` → bytes; missing/invalid → error;
`optionsToRequest`/`requestToOptions` round-trip `memory`.

## File touch list

`src/config.ts` · `src/util/index.ts` (+`cli/cache.ts` re-export) ·
`src/orchestrator/resources.ts` (new) · `src/workspace/project-loader.ts` ·
`src/orchestrator/task-hash.ts` · `src/graph/scheduler.ts` (+`graph/index.ts`
re-export) · `src/orchestrator/run.ts` · `src/orchestrator/options.ts` ·
`src/orchestrator/protocol.ts` · `src/cli/{run,help}.ts` ·
`src/orchestrator/summary.ts` (Phase 2) · docs (`schema.md`, `cli.md`,
`caching.md`) · tests as listed.

## Phasing (each independently shippable)

1. **Phase 1 — the feature (local runs):** schema + loader + resolver +
   `parseSize` move + key strip + scheduler admission + `run.ts` wiring +
   `--memory` + tests.
2. **Phase 2 — display:** the gated static budget line.
3. **Phase 3 — delegation:** `RunRequest.memory` + mappers.

## Non-goals

- Hard enforcement (cgroups / rlimits / `nice`) — hints only.
- GPU / custom resources — only `cpus` and `memory` ship. The grouped
  `exec.resources` object is exactly where a third axis would land later
  (a new key + a third admission axis), but none ships now — the loader
  rejects unknown keys.
- Core affinity / pinning / NUMA; load-aware probing beyond the
  concurrency default.
- Retro-stripping `timeout`/`retries` from the key (needs a
  `CACHE_VERSION` bump; deferred).

## Decided (previously open)

- **Persistent tasks honor their reservation** for their lifetime (a dev
  server genuinely holds RAM); switchable in `costOf` if it starves
  short tasks.
- **Phase-2 display is the static budget line only** — no live
  reserved-sum threading into the logger.
- **Two load-bearing details for the implementer:** (1) the `parseSize`
  move to `util` (module boundary), and (2) skip-safety — `takeFitting`
  must return a would-skip task without a fit check, or a too-big doomed
  task parks forever and the run hangs.
