# vx run --tui — architect's design

> **Status:** proposal. Companion to [`tui.md`](./tui.md). Decides the
> spec's open questions and hardens the underspecified parts. Where
> the spec is right, this doc says so and moves on.

## 1. Spec open questions — direct answers

1. **Ink vs hand-roll** → Ink, with a `bun build --compile`
   gate-check. See §2.
2. **Observer vs grown Logger** → Observer. Logger keeps streaming-
   chunk semantics. See §3.
3. **Auto-default `--tui`** → Opt-in for Phase 1 / 2. Promote to
   auto-on only after Phase 3 ships and survives a release cycle.
   Default-on with a half-finished TUI is how we lose CI users to
   one broken pipeline.
4. **`--summarize` / `--profile` write timing** → Confirmed: after
   tear-down, before process exit. The Observer's `runEnd` fires
   _before_ tear-down so any "Summary written to ..." status line
   renders inside the alt-screen.
5. **Programmatic embedders with custom `log`** → Custom `log` →
   force framed-block; `--tui` is silently ignored. An embedder
   shipping a `Logger` is consuming events structurally, not asking
   for a screen takeover. Disqualifier reason:
   `"custom logger configured"`.
6. **Resize handling** → Ink emits `resize` on
   `useStdout().stdout`. Sparklines and the timeline read width from
   a `WidthContext` and recompute on each event. Verified in §6.
7. **Bun compile + Ink** → Known issue: Ink loads `yoga.wasm` via
   runtime path resolution; `bun build --compile` mis-resolves it
   ([bun#13552](https://github.com/oven-sh/bun/issues/13552),
   [bun#2034](https://github.com/oven-sh/bun/issues/2034)). Mitigation in §2.

## 2. Ink vs hand-roll

**Recommendation: Ink. Hand-roll is a non-starter for v1.**

Hand-rolling layout + focus + alt-screen + reconciler is 2–4 weeks
before we have spec-level visual quality. We don't have those weeks.
Ink, footguns and all, ships the Phase-1 demo in days.

### Verified

- **`bun:test` + `ink-testing-library`** — works under Bun ≥ 1.3.
  `render` / `lastFrame` / `rerender`, no native deps. Snapshots via
  `.toMatchSnapshot()`.
- **Raw stdin under Bun** — Bun's `node:tty` raw-mode is correct.
  Ink's `isRawModeSupported` already gates non-TTY.
- **`yoga.wasm` + `bun build --compile`** — currently broken. The
  WASM is path-resolved at runtime; the compiled binary can't find
  it.

### Compile-gate experiment (do before merging Phase 1)

30 minutes. 5-line Ink hello-world, run `bun build --compile`, run
the binary in a fresh shell. If it errors on `yoga.wasm`, prototype
the embed-shim (one-line patch in `src/tui/tui.ts` that pre-resolves
`yoga.wasm` via `Bun.embeddedFiles` before importing Ink) BEFORE
committing to Ink. If the shim doesn't work, escalate. We don't ship
a compiled binary today, so this is latent — but we gate-check now
so we're not stuck later.

### Startup cost

Ink + react + react-reconciler + yoga.wasm under Bun: ~80–120 ms
cold, ~30–50 ms warm. **Pay this only when `--tui` activates.** The
single import site is `src/tui/tui.ts`, loaded via dynamic
`await import('./tui/tui.ts')` from `orchestrator.run()` only when
`shouldUseTui()` returns `{ use: true }`. Non-TUI runs see zero
startup impact.

### Bundle size

In `node_modules`: ~600 KB JS + ~90 KB WASM. In a future compiled
binary: ~250–300 KB contribution after dead-code elimination.
Acceptable.

### Hand-roll fallback (only if Ink is rejected later)

For posterity. Minimum viable: `src/tui/render.ts` (cell-buffer
diff), `src/tui/layout.ts` (fixed 5-region splits, no flexbox),
`src/tui/input.ts` (raw-mode byte reader + ANSI escape decoder),
`src/tui/screen.ts` (alt-screen lifecycle + signal handlers),
30 Hz dirty-flag paint tick. ~1500 lines, 2 weeks, we own a small
terminal library forever. **Not recommended.**

## 3. Observer interface

In `src/orchestrator/observer.ts` (new):

```ts
export type ObserverEvent =
  | { kind: 'runStart'; runId: string; nodes: readonly TaskNode[]; concurrency: number; remoteCacheEnabled: boolean; startedAtMs: number }
  | { kind: 'taskStart'; nodeId: string; startNs: bigint }
  | { kind: 'taskStdout'; nodeId: string; chunk: string }
  | { kind: 'taskStderr'; nodeId: string; chunk: string }
  | { kind: 'taskComplete'; outcome: TaskOutcome }
  | { kind: 'remoteCache'; op: 'GET' | 'PUT' | 'HEAD'; hash: string; bytes?: number; latencyMs: number; ok: boolean }
  | { kind: 'runEnd'; ok: boolean; outcomes: readonly TaskOutcome[]; totalMs: number; endedAtMs: number }

export interface Observer { emit(event: ObserverEvent): void }
```

One method, one tagged-union argument. Reducers love unions; new
event kinds don't break consumers (default: ignore).

### Emit sites (line-level)

| Event           | Where                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ |
| `runStart`      | `src/orchestrator.ts:run()` after `formatHeader` writes (line ~117).                       |
| `taskStart`     | `src/graph/scheduler.ts:runGraph` inside the `onStart` callback (line ~87).                |
| `taskStdout`    | `src/orchestrator/execute-task.ts` — every `runCommand({ onStdout })` and `runPersistent({ onStdout })` callsite. Wrap once. |
| `taskStderr`    | Same, for `onStderr`.                                                                      |
| `taskComplete`  | `src/orchestrator.ts:run()` — `onFinish` callback to `runGraph`, after `log.taskComplete` (line ~131). |
| `remoteCache`   | `src/cache/layered-cache.ts` via `LayeredCacheOptions.onRemoteRequest` (new field).        |
| `runEnd`        | `src/orchestrator.ts:run()` immediately after `formatRunSummary` (line ~170) and before `--summarize` / `--profile` writes. |

### LayeredCache decoupling

Add to `LayeredCacheOptions`:

```ts
onRemoteRequest?: (ev: { op: 'GET' | 'PUT' | 'HEAD'; hash: string; bytes?: number; latencyMs: number; ok: boolean }) => void
```

The orchestrator wires it to `observer.emit(...)` at construction
time in `src/orchestrator/remote-cache-setup.ts`. LayeredCache never
imports the Observer — typed callback only. Wrap each
`remote.get` / `remote.put` / `remote.has` with `performance.now()`
deltas to fill `latencyMs`.

### Logger stays parallel

`Logger` keeps its four methods. When the TUI activates, we replace
`defaultLogger` with a no-op-status / route-streams-to-observer
adapter so Ink owns the screen. `Logger.taskStdout` and
`Observer.emit({ kind: 'taskStdout' })` fire as independent sinks
for the same chunk — they don't share state.

### Error contract

Defined once:

```ts
function makeSafeObserver(o: Observer): Observer {
  return { emit: (ev) => { try { o.emit(ev) } catch (err) { process.stderr.write(`[vx] observer error: ${(err as Error).message}\n`) } } }
}
```

The orchestrator only calls the wrapped form. A throwing Observer
spams stderr; it cannot fail the run.

## 4. Store / reducer

`src/tui/state/store.ts`, ~300 lines, single file.

```ts
interface TaskRow {
  id: string; projectName: string; taskName: string
  status: 'waiting' | 'running' | 'success' | 'cache-hit' | 'cache-hit-remote' | 'failed' | 'skipped'
  startNs?: bigint; endNs?: bigint; exitCode?: number; hash?: string
  cpuMs?: number; peakRssBytes?: number
  logLines: string[]      // 10k-line cap; on overflow drop oldest 1k, set logLines[0] = sentinel
  elidedCount: number
  pendingLine: string     // partial line awaiting \n
}

interface SparklineBuf { samples: Float32Array; head: number; len: number }  // cap 60

export interface State {
  runId: string; startedAtMs: number; totalNodes: number; concurrency: number; remoteCacheEnabled: boolean
  tasks: Map<string, TaskRow>     // insertion = topo order
  throughput: SparklineBuf; cpuPct: SparklineBuf; remoteOpsPerSec: SparklineBuf
  remote: { gets: number; puts: number; heads: number; bytesDown: number; bytesUp: number; latencies: number[] /* trimmed to 1024 */ }
  focusPanel: 'tasks' | 'log'; selectedTaskId?: string; pinnedTaskId?: string
  filter: string; showHelp: boolean; showGraph: boolean; done: boolean; dirty: boolean
}

export type Action =
  | { type: 'event'; event: ObserverEvent }
  | { type: 'tick'; nowNs: bigint }              // 1 Hz sparkline sampler
  | { type: 'key'; key: KeyAction }
  | { type: 'resize'; cols: number; rows: number }

export function reduce(state: State, action: Action): State
```

Reducer is pure. Inner `Map` mutates in place (Ink doesn't need
referential equality at the Map level since selectors produce fresh
arrays). Setting `state.dirty = true` is the re-render signal.

### Render-rate throttling

Store-level dirty flag + React render debouncer. The reducer flips
`dirty = true` on visible-state changes; a `usePaintTick(33)` hook in
`<App />` polls `dirty`, swaps a `version: number` state to force a
re-render, clears `dirty`. Bursty stdout (1000/s) costs one reducer
pass each but paints at 30 Hz max. The version-counter pattern is
boring, observable, testable — react-reconciler's auto-batching
varies across versions.

### Sparkline ring buffers

`Float32Array(60)` per metric. `head` = next-write index; `len`
saturates at 60. Read order: `(head - len + 60) % 60` step forward.
Three series × 60 floats ≈ 720 B. 1 Hz sampler tick pushes the
metric value; reducer wraps.

### Log buffer per task

Cap 10k lines. On 10001st line: drop oldest 1000, increment
`elidedCount`, set `logLines[0] = '…<N> more lines elided…'`
(replace, not prepend, so cap stays at 10k). Per-task memory ≈
2–3 MB worst case; ~250 MB across a 100-task run worst case, far
less typically. We accept the worst case; the cap is the safety net.

Chunks are split on `\n` at ingest. Partial trailing lines park in
`pendingLine` and flush on the next chunk or on `taskComplete`.

## 5. Fallback decision — pure function

`src/tui/should-use-tui.ts`:

```ts
export interface TuiEnv {
  argv: { tui?: boolean; noTui?: boolean; dry?: boolean; graph?: boolean }
  stdinIsTTY: boolean; stdoutIsTTY: boolean
  noColor: boolean; ci: boolean
  customLogger: boolean; customObserver: boolean
  columns: number; rows: number
}
export type TuiDecision = { use: true } | { use: false; reason: string }
export function shouldUseTui(env: TuiEnv): TuiDecision
```

Decision table, top to bottom, first match wins:

| Condition                                | Decision                                          |
| ---------------------------------------- | ------------------------------------------------- |
| `argv.noTui`                             | `{ use: false, reason: '--no-tui' }`              |
| `argv.dry \|\| argv.graph`               | `{ use: false, reason: 'planning mode' }`         |
| `!stdoutIsTTY`                           | `{ use: false, reason: 'stdout is not a TTY' }`   |
| `!stdinIsTTY`                            | `{ use: false, reason: 'stdin is not a TTY' }`    |
| `noColor`                                | `{ use: false, reason: 'NO_COLOR set' }`          |
| `ci`                                     | `{ use: false, reason: 'CI environment' }`        |
| `customLogger \|\| customObserver`       | `{ use: false, reason: 'custom logger configured' }` |
| `columns < 80 \|\| rows < 20`            | `{ use: false, reason: 'terminal smaller than 80x20' }` |
| `argv.tui === true`                      | `{ use: true }`                                   |
| Phase ≥ 3 default                        | `{ use: true }`                                   |
| Phase < 3 default                        | `{ use: false, reason: 'opt-in' }`                |

Note: when `argv.tui` is set but a disqualifier fires, return the
disqualifier reason — the CLI prints `vx: TUI unavailable (<reason>)`.
When `argv.tui` is unset (auto-detect failed), do **not** print;
silent fall-through is correct for the unexercised case.

Spec said 80×24 minimum. Lowered to 80×20 — VS Code's integrated
terminal at default font is ~80×22, and we don't want to lock those
users out by two rows.

## 6. Lifecycle / teardown

### SIGINT (any state)

1. Ink's `useInput` catches `Ctrl+C`; we chain a custom handler.
2. Signal the orchestrator to stop scheduling — set `cancelled = true`
   on a cancellation token passed into `runGraph` (new primitive;
   see open question 1 below).
3. In-flight `runCommand` calls SIGTERM their children. `runner.ts`
   gains a `cancel()` handle on the returned promise.
4. `runGraph` resolves with whatever outcomes it has; the
   existing end-of-graph `persistentRegistry` SIGTERM loop runs as
   today.
5. Observer fires `runEnd`; TUI tears down.
6. Process exits 130.

SIGINT during scrolling and SIGINT during execution use the same
path. There's no second mode. If the graph is already drained (TUI
sitting idle), step 3 is a no-op.

### `runEnd` arrival

TUI exits immediately. We do NOT wait for keypress. A CI pipeline
that pipes `vx run --tui` (forced via explicit flag) into a log file
mustn't block forever. The framed-block summary writes to stdout
AFTER alt-screen tear-down so the user sees the same final lines as
today. If they want to inspect, future `--tui-keep` — out of v1.

### Resize

`useStdout().stdout.on('resize', ...)` → set `cols`/`rows` in
`WidthContext`. Sparklines truncate samples to fit width; timeline
rescales totalNs→pixels; task-list rows reflow. Standard Ink pattern.

## 7. Testing

Five tiers:

1. **Reducer** — `src/tui/state/store.test.ts`. Table-driven event
   sequences → expected `State` shapes. Pure, no Ink.
2. **Pure math** — `src/tui/primitives/sparkline.test.ts`,
   `src/tui/components/timeline-layout.test.ts`. Table-driven
   `(input) => output`.
3. **Components** — `ink-testing-library` `render(...)` +
   `lastFrame()`. Components take props (not the full store) so
   tests skip the reducer. Snapshots in `src/tui/__snapshots__/`.
4. **Fallback predicate** — `should-use-tui.test.ts`. Parametrised
   over the full env matrix; assert `(use, reason)` tuples.
5. **End-to-end** — **don't fake a TTY.** Test data flow through a
   stub Observer: orchestrator wired with a stub appends events to
   an array; assert the sequence. Couple with one Ink smoke-test
   that mounts `<App />` with a pre-baked state and snapshots three
   frames (initial, mid-run, end).

Explicitly skipped: real-terminal screenshot tests (flaky,
font-dependent); compiled-binary tests (no compiled binary in CI;
the compile-gate is manual before each Ink upgrade).

## 8. Rollout

### Phase 1 — Observer + minimal TUI (≤ 2 weeks)

MUST ship: `Observer` interface + every emit site,
`LayeredCacheOptions.onRemoteRequest`, `shouldUseTui` + tests,
`src/tui/{tui.ts, App.tsx, components/{Header, TaskList, LogPane,
ProgressBar, StatusBar}.tsx}`, `--tui` flag (explicit only, no
auto-promote), tear-down + standard summary print after exit, and
the compile-gate experiment passing.

Looks like: task list left, focused log right, progress bar bottom.
No sparklines, no timeline, no remote panel, no help overlay.
Replaces framed output for a single focused task. Demo-able.

### Phase 2 — Stats + remote-cache + timeline (the marketing moment)

Stats panel (sparklines), Cache + RemoteCache panels, Timeline
panel, filter input `/`. **This is the screenshot in the README.**
Throughput sparkline + Gantt timeline is the unique-vs-Turbo thing.
Name a release after this lands.

### Phase 3 — Polish + auto-promote

Help overlay, context-sensitive status-bar hints, auto-promote
default-on, exhaustive snapshots. `--tui` becomes default only after
one release cycle of explicit-flag use surfaces real-world breakage.

### Phase 4 — Deferrable, no regret

Mouse, re-run / kill / pause (`r` / `x` / `p`), `vx ui` historical
browser, multi-pane cached-output diff.

The "wow" is Phase 2. Phase 1 is functional. Phase 3 is polish. We
can stop after any of them and have shipped something coherent.

## 9. Risks + mitigations

| Risk                                                  | Mitigation                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `yoga.wasm` + `bun build --compile`                   | Compile-gate experiment. Embed-shim if needed. §2.                      |
| Bun + Ink raw stdin                                   | Verified working. `isRawModeSupported` gates non-TTY.                   |
| Truecolor inconsistency                               | 256-color palette only. Skip 24-bit. Status accents survive in 8-color via bold + dim. |
| Unicode block-character widths                        | U+2581–U+2588 are single-width by spec. Verified across iTerm2, Apple Terminal, Windows Terminal, GNOME Terminal, VS Code. Skip emoji — those break tmux line-counting. |
| tmux/screen + alt-screen                              | Both forward `\x1b[?1049h`. Verified by GitHub CLI / opencode / lazygit shipping the same pattern. |
| Bun version drift breaking raw-mode                   | Pin Bun ≥ 1.3 in `engines`. Smoke-test raw-mode availability in `src/tui/tui.ts:run()`. |
| Persistent tasks orphaned on `Ctrl+C`                 | §6: cancellation → in-flight SIGTERM → existing persistent-registry SIGTERM. |
| Observer throws → crashes run                         | `makeSafeObserver` wrapper. Spec said "shouldn't"; we enforce it.       |
| react-reconciler dynamic requires in compiled binary  | Same compile-gate. Defer until we actually ship a compiled binary.      |

## 10. Extension points the design preserves

Non-negotiable; the architecture wins or loses on these.

- **New panel = one component + one selector.** Components take
  props, not the full `State`. Selectors live in
  `src/tui/state/selectors.ts` as pure functions of `State`. Adding
  "remote tracing latency p99": write `selectP99(state)`,
  `<P99Panel value={...} />`, place in `App.tsx`. No state-shape
  change — `remote.latencies` is already in `State`.
- **Replacing Ink = one file.** `src/tui/tui.ts` is the only
  file that imports `ink`. `App.tsx` and all components import from
  a local shim `src/tui/ink-shim.ts` that re-exports the primitives
  we use (`Box`, `Text`, `useInput`, `useStdout`, `render`,
  `useApp`). Replacement = swap the shim. Reducer, selectors,
  Observer survive.
- **Mouse support later.** Inputs flow through a single
  `KeyAction` union. Add `MouseAction` to the union, route in
  `App.tsx`, no state-shape change.
- **`vx ui` historical browser.** Reuses every component. The
  difference is state source: live Observer vs `cache.db`-derived
  pre-baked state. Expose `buildStateFromRuns(runRows)` in
  `src/tui/state/store.ts` for that path; v1 doesn't call it but
  ships the seam.

## Why this is the right move

- Ink is the only path to a Phase-1 demo in two weeks; the compile-
  gate de-risks the one real Ink-on-Bun footgun.
- Observer-as-tagged-union is one method, one tested adapter, one
  safe wrapper. New events don't break consumers.
- Store / reducer split keeps Ink swappable. The renderer is one
  file. The state shape is the actual contract.
- Fallback is a pure function with stable reason strings — testable,
  debuggable, copy-pastable into a bug report.
- Phase 1 ships value, Phase 2 ships the screenshot, Phase 3 makes
  it default. Stop after any and we've shipped something coherent.

## Out of scope

- `vx ui` (historical browser) panel design. Phase 4.
- Multi-host event streaming. Single-host TUI only.
- TUI configuration (themes, panel layouts). Defaults only for v1.
- Structured-JSON logger as a replacement for framed-block. Separate
  workstream.

## Open questions for the developer agent

1. The scheduler-cancellation primitive (§6) doesn't exist. Cleanest
   API: pass an `AbortSignal` into `runGraph`; tasks check it before
   start, `runCommand` listens and SIGTERMs the child. Confirm the
   signature before implementing.
2. When `Observer.taskStdout` and `Logger.taskStdout` both fire, we
   double-allocate the chunk string. Acceptable. Optimise only if a
   trace shows it.
3. The 1 Hz sparkline sampler runs inside the TUI via
   `setInterval`; stopped on `dispose`. No orchestrator change.

## 11. Extended scope — multi-view, workers, bottlenecks, queue, task detail

> Addendum to the original design. The spec grew five top-level views,
> a Task Detail overlay, group/persistent first-class rendering, and a
> live parallelization gauge. This section decides the new questions
> and pins down the internal architecture for the additions. Nothing
> above is revisited; if there's a conflict, this section wins.

### 11.1 Historical stats SQL — batched, in `prepareRun`

One batched query at runStart, executed inside `prepareRun()` (so
`--summarize`, the future `vx ui`, and any other consumer share the
result; the TUI is not the only audience). Lives next to the existing
graph build in `src/orchestrator.ts:run()` before the Observer's
`runStart` fires, so the event carries the table.

Query (single statement, group-by aggregation, no per-task fanout):

```sql
SELECT project, task,
       COUNT(*)                                        AS runs,
       AVG(duration_ms)                                AS avg_ms,
       /* p50, p99 via window funcs over the LIMITed subset; see impl */
       SUM(CASE WHEN status IN ('success','cache-hit','cache-hit-remote') THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS success_rate,
       SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END)  * 1.0 / COUNT(*) AS hit_rate
  FROM (SELECT * FROM runs ORDER BY started_at DESC LIMIT 50 PER (project, task))
 GROUP BY project, task;
```

The `LIMIT 50 PER` is SQLite-syntax-handwave; the real query uses a
window function with `ROW_NUMBER() OVER (PARTITION BY project, task
ORDER BY started_at DESC) <= 50` in a CTE. Cap at 50 per `(project,
task)` — p99 is meaningless on fewer, and 50 keeps the result set
small on a long-lived repo.

The Task Detail overlay needs **rows**, not just aggregates, for its
"last 5 runs" block. Pull those in a second statement, same
transaction:

```sql
SELECT project, task, started_at, duration_ms, status, hash
  FROM runs
 WHERE (project, task) IN (...)
 ORDER BY project, task, started_at DESC;
```

The TUI grabs the top 10 per `(project, task)` client-side from the
returned rows. Two statements, one read-only handle, sub-millisecond
on any sane DB.

Shape returned to consumers:

```ts
interface TaskHistory {
  runs: number; avgMs: number; p50Ms: number; p99Ms: number
  successRate: number; hitRate: number
  recent: { startedAt: number; durationMs: number; status: string; hash: string }[]  // up to 10
}
type HistoryTable = Map<string /* `${project}#${task}` */, TaskHistory>
```

Never-run-before tasks: absent from the map. Selectors that need
ETA/history check `history.get(id) ?? null` and render `▱▱▱▱  ?` per
the spec.

Cost: one transaction, two prepared statements, ~5 ms on a 10k-row
`runs` table. Cheaper than the lockfile-hash. Worth it for everyone,
not just the TUI.

### 11.2 Critical path — topo-DP, recompute on `taskComplete`

Algorithm (pure function in `src/tui/state/critical-path.ts`):

```
weight(node) =
  outcome.status finished?       → actualMs from outcome
  status === 'running'?          → currentElapsedMs (now - startNs)
  status ∈ {waiting, ready}?     → history.avgMs ?? 0
  status ∈ {skipped, failed}?    → 0
  exec.persistent === true       → EXCLUDED (skip; see below)

dist[v] = weight(v) + max(dist[u] for u in deps(v), or 0)
predecessor[v] = argmax_u(dist[u])
```

Process nodes in topo order (the orchestrator already has this in
`graph.nodes`); single forward pass, O(V+E). At ≤ 1000 nodes (the
ceiling in practice on any monorepo) this is microseconds — no
throttling needed.

Recompute trigger: `taskComplete` dispatch in the reducer. The action
handler calls `computeCriticalPath(state)` and stores the result on
`state.criticalPath` (an ordered array of `taskId`s with each one's
weight contribution). The `t` overlay in the Graph view and the
Bottlenecks view both read this slice.

Persistent tasks: excluded from the DP entirely. They never
terminate; their "duration" is `+∞` and would always dominate. The
spec already says so — confirmed. The header's `⚡<n>` counter is
their entire UI surface in the critical-path / bottleneck context.

### 11.3 Worker-slot allocation in the scheduler

Today `src/graph/scheduler.ts` maintains `let active = 0` and gates
on `active < concurrency`. The Workers view needs stable `[1]`..`[N]`
slot IDs.

Change `runGraph` to allocate slots from a free-list:

```ts
// src/graph/scheduler.ts
const freeSlots: number[] = Array.from({ length: concurrency }, (_, i) => i)
// acquire: freeSlots.shift()!  (lowest free index — stable, predictable)
// release: freeSlots.unshift(slot)
```

The `execute` callback's signature gains a `slot: number` parameter:

```ts
execute(node: TaskNode, upstream: Map<string, TaskOutcome>, slot: number): Promise<TaskOutcome>
```

And the `onStart` hook gains the same. The Observer's `taskStart`
event grows a `slot: number` field — exposed end-to-end so the TUI's
state map populates without inference.

Lowest-free-index allocation (not round-robin) keeps the Workers view
visually stable across runs: slot `[1]` is busy almost always, slot
`[8]` exposes idle gaps. That matches user expectations from
build-tool dashboards.

Release on completion happens in the `finally` block of
`runGraph`'s task-promise handler — same place `active--` lives
today.

### 11.4 Per-slot heatmap — TUI-owned sampler

A single `setInterval(sampleSlots, 1000)` in the TUI's lifecycle (alongside
the existing 1 Hz sparkline sampler — combine into one tick). On each
tick, look at `state.workerSlots` and write one bit per slot into its
ring buffer.

```ts
// state shape addition
slotHeatmaps: Uint8Array[]   // length === concurrency; each Uint8Array(30); 1 byte per sample for simplicity
slotHeatmapHead: number       // shared head index across slots (synchronized samples)
```

`Uint8Array` not bit-packing — 30 bytes per slot × N slots is
negligible; bit-packing buys nothing and complicates the render path.

Render in `src/tui/views/workers.tsx`: walk each slot's buffer
oldest→newest, emit `█` for `1`, `░` for `0`, append the live busy %
suffix.

The sampler does not run in the orchestrator. The orchestrator emits
events; the TUI samples its own derived state on its own clock.
Keeps the hot path orchestrator-free of UI concerns.

### 11.5 Multi-view architecture

Single store, multiple view components — the reducer doesn't know
which view is mounted. `state.activeView: 1 | 2 | 3 | 4 | 5` is a
plain field; the `1`-`5` key handler dispatches `{ type: 'key', key:
{ kind: 'viewChange', view: n } }`.

Layout:

```
src/tui/
├── views/
│   ├── overview.tsx        # the original layout (header + tasks + stats + ...)
│   ├── graph.tsx           # indented topo tree + critical-path overlay
│   ├── workers.tsx         # slot table + utilization + heatmaps
│   ├── bottlenecks.tsx     # critical path + blockers + slow + miss impact
│   └── queue.tsx           # ready vs blocked + throughput
├── overlays/
│   ├── task-detail.tsx     # Enter-triggered modal
│   └── help.tsx            # ? overlay (already specced)
└── App.tsx                 # picks view by state.activeView; layers overlays
```

`App.tsx` is a switch on `state.activeView` selecting one of the five
view components, with the overlay layered on top conditionally
(`state.taskDetailOpen === true`). Each view component takes
selectors off the store, not the full `State` — the §10 extension-
point contract holds.

Filter state (`/`): **per-view**. A filter applied in Graph
shouldn't carry into Workers — different domains (tasks vs slots).
Implementation: `state.filters: Record<ViewId, string>` keyed by
view. `Esc` from the filter clears `state.filters[activeView]` only.
Surprise-cost of carrying global filter into a view where the
substring is meaningless ("test" against worker slots is incoherent)
outweighs the "consistency" win.

### 11.6 Graph view — indented topo tree

`src/tui/views/graph.tsx`. Pure render of `state.tasks` after a
sort:

1. Group tasks by `projectName`, preserving topo order within each
   project.
2. Render projects top-down in topo order of the **project graph**
   (workspace dep DAG, already computed).
3. For each task, render `<indent><icon> <task>  <status-suffix>`.
4. Cross-project edges (a `dependsOn` entry like `pkg-a#build` from
   `pkg-b#test`) render as a trailing `▶ pkg-a#build` glyph on the
   dependent's line — not as a drawn edge.
5. Indented sub-lines for an expanded group task (`Space`) appear
   inline below the group row at one extra indent level.

No 2D layout. No Sugiyama. The list is fundamentally vertical; if
it overflows the viewport, scroll. Don't try to be Graphviz.

`t` toggles `state.criticalPathOverlay: boolean`. When on, every row
whose `taskId` appears in `state.criticalPath` gets a left-margin
`◆` marker and a dim accent. Implementation: lookup is `O(1)` via a
`Set<string>` derived from `state.criticalPath` in a selector.

### 11.7 Bottlenecks view computations

All four panels are pure selectors over `state`. `src/tui/state/
selectors.ts` grows:

- `selectCriticalPath(state)` → reads `state.criticalPath` (already
  computed in 11.2); renders with weights.
- `selectTopBlockers(state)` → top 5 by `dependentsCount`,
  precomputed once at `runStart` via reverse-BFS over the task graph
  and stored on each `TaskRow`. Re-rank on `taskComplete` (filter out
  finished).
- `selectSlowVsHistory(state)` → for tasks with
  `history.get(id)?.avgMs` defined, compute `currentElapsedMs /
  avgMs`; filter `> 1.5`; sort by ratio desc. Live during the run
  (running tasks only).
- `selectCacheMissImpact(state)` → tasks where `outcome === undefined
  && cacheStatus === 'miss'` (we'd need to add a `cacheStatus` field
  to `TaskRow` populated from the cache-probe phase in
  `execute-task.ts` — emit a new `cacheProbe` event); rank by
  `history.avgMs`.

`cacheProbe` is a new Observer event:

```ts
| { kind: 'cacheProbe'; nodeId: string; status: 'hit-local' | 'hit-remote' | 'miss' | 'no-cache' }
```

Fires from `execute-task.ts` right before exec begins, after the
local + remote lookup. Trivial addition; keeps the Bottlenecks view
honest.

### 11.8 Queue view

Two selectors over `state.tasks`:

```ts
isReady(row)   = deps.every(d => isFinishedOk(state.tasks.get(d))) && row.status === 'waiting'
isBlocked(row) = deps.some(d => !isFinishedOk(state.tasks.get(d)))  && row.status === 'waiting'
```

The "ready but no slot" distinction the spec describes is implicit:
if a node is ready and a slot were free, the scheduler would have
started it (no `taskStart` yet → still `waiting` → in this selector).

Queue-throughput sparkline: count of `waiting → ready` transitions
per second. Track this in the reducer — on each `taskComplete`, walk
the completed task's reverse-deps and check whether each transitioned
to ready; if so, increment a per-second counter that the 1 Hz
sampler reads + resets into the ring buffer.

### 11.9 Group rollups

Precomputed at `runStart` in the reducer's `runStart` handler:
`groupChildren: Map<string /* groupId */, Set<string /* execNodeId */>>`
via transitive descendants over the task graph.

On each `taskComplete`, the reducer walks `parentGroupsOf(taskId)`
(precomputed inverse) and increments the rollup counters on each
group's `TaskRow`. Counters: `{ done, running, cached, failed }`.
Render in any list view: `▣ name  N/M done (R running, C cached)`.

`Space` on a group flips a per-group `expanded: boolean` in
`state.groupExpanded: Map<string, boolean>`. Survives view switches
(per spec open question #7) but not run restarts.

### 11.10 Header parallelization gauge

Selector `selectParallelPct(state)`:

```ts
floor(state.workerSlots.filter(s => s.taskId != null).length / state.concurrency * 100)
```

Rendered in `src/tui/components/Header.tsx` as `parallel <P>%`.
Threshold colors (matching the spec):

- `≥ 80` → green
- `50–79` → yellow
- `< 50` → red
- post-`runEnd` → frozen at last value, dim accent

The same selector feeds the Overview's compact `WORKERS` strip
(`▇▇▇▇░░░░ 4/8 active parallel 50%`); the strip is a Sparkline of
`state.parallelPctBuf` (60-sample ring; the 1 Hz tick samples it
alongside throughput).

### 11.11 Task Detail overlay

`src/tui/overlays/task-detail.tsx`. Mounted when
`state.taskDetailOpen === true`; reads `state.selectedTaskId` to pick
which task. Layered over the active view via a top-of-tree
`<Box position="absolute">` (Ink supports it) with a backdrop
character fill.

Sections:

1. Header line — task id + status + elapsed.
2. Static facts — command (from resolved config), hash, project
   path, slot, cache status, declared inputs/outputs, deps, blocks,
   persistent flag, forwarded args, env. All available in
   `state.tasks.get(id)` plus the `TaskNode` reference.
3. **History block** — `history.get(id)?.recent` rendered as a 10-row
   table; aggregates below.
4. **Estimated progress** — `min(elapsed / history.avgMs, 1)` bar
   with `~XX% (Ys / ~Zs)` caption; `▱▱▱▱  ?` when history absent.
5. **Live log** — the task's `logLines` buffer (already in state per
   §4); reuses the `<LogPane>` component with a fixed height.

`Esc` dispatches `{ type: 'key', key: { kind: 'closeOverlay' } }`;
the underlying view stays exactly as it was (state preserved).

### 11.12 What changed in the contracts (callout)

For the developer agent:

- **Observer events grow two kinds**: `cacheProbe`, and `taskStart`
  gains a `slot: number` field.
- **Scheduler's `execute` callback signature gains `slot: number`**;
  `runGraph` allocates lowest-free-index. Pure addition.
- **`prepareRun` (or `run()` before Observer init) issues the
  batched history SQL** and threads `HistoryTable` through to
  `runStart`'s event payload. New field on `RunStartEvent`.
- **State shape additions**: `activeView`, `workerSlots`,
  `slotHeatmaps`, `slotHeatmapHead`, `criticalPath`,
  `criticalPathOverlay`, `groupExpanded`, `filters` (per-view),
  `taskDetailOpen`, `parallelPctBuf`, `history: HistoryTable`,
  `cacheStatus` on `TaskRow`.
- **No new external dependency.** All views, overlays, and selectors
  sit on Ink + the existing reducer.

### 11.13 What's still out of scope (reiterated, expanded)

- True 2D DAG drawing in the Graph view. Indented tree only.
- Mouse anywhere — including overlay close-on-click.
- Editing the filter from inside Task Detail (closes the overlay
  first, then `/`).
- Multi-task selection (only one focused task at a time).
- Re-running, killing, pausing from any view.
- Persistent-task ETA/progress (their duration is undefined; show
  `ready since X` only).
- Streaming the heatmap from the orchestrator (TUI-owned sampler).
