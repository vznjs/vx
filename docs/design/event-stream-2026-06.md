# Run event stream + devframe surfaces

Status: proposal (2026-06-17). Owner-driven: "drive our current terminal
output through devframe; use a separate thread so rendering never blocks
the orchestrator; build a TUI + web devtool as live consumers."

## 1. The idea in one paragraph

The orchestrator stops calling a `Logger` directly. Instead it emits a
**serializable, ordered event stream** describing the run, plus a derived
**shared view-model** (counters, per-task status, worker slots). Every
surface — the existing terminal renderer, a web devtool, a TUI, an MCP
server for the coding agent — is just a _subscriber_ on that one stream.
devframe is the transport + adapter layer that lets one `defineDevframe`
definition fan out to CLI / SPA / embedded overlay / MCP. The terminal
output we have today is demoted from "the thing the orchestrator drives"
to "the default, always-on subscriber." Heavy/interactive surfaces attach
**off-thread**, so a wedged or slow renderer can never stall task exec —
the failure mode that killed the TUI three times.

## 2. Why now, and why this is different from the deleted TUI

We have built a live view of run internals three times and deleted it
every time (see the decision log): the OpenTUI TUI ("still freezing — drop
it"), the `apps/dashboard` Vite+Solid app ("the cache file IS the API"),
and the tagged-union `Observer` event sink (deleted as dead code once its
consumers were gone).

Every one of those failures shares a root cause: **the renderer was
synchronously coupled to the run on the same thread.** The React/Solid
reconciler raced the painter on the thread the orchestrator needed. The
owner's insight reframes the problem — put rendering behind an async
boundary and the orchestrator just _fires events and moves on_. The run
can finish while a consumer is still draining its queue; a frozen consumer
cannot block exec.

So this proposal is not "revive the TUI." It is "build the **event
substrate** the TUI/dashboard/Observer all needed but never had a stable
contract for, make it serializable and off-thread-safe, and make the
terminal logger the first consumer of it." The TUI becomes a _fourth_
subscriber attempted later, on a substrate that structurally cannot
freeze the run.

## 3. Non-negotiable invariants (the terminal output must not regress)

The terminal output is our most-iterated, owner-tuned subsystem. Driving
it through the new stream must be **byte-identical** in every mode. The
event contract is therefore designed backwards from what the renderer
needs to reproduce today's output exactly:

- **Non-TTY / piped / CI** prints plain scrollback to stdout. No server,
  no transport startup cost on this path.
- **`NO_COLOR`**, GitHub Actions `::group::` / `::error::` annotations,
  the `focused`-vs-`broad` flow decided by selection flags, `--output-logs
full|errors-only|none`, the scrollback-vs-live-region split, force-floor
  coalescing — all preserved.
- **Ordering.** Today's output depends on exact ordering between
  `taskStdout` chunks and `taskComplete`, and on the block-separator
  bookkeeping (`lineEmitted` / `streamedSinceBlock`). The terminal
  consumer therefore reads **one FIFO-ordered channel**, never a mix of
  stream + state-patches (cross-channel interleaving would scramble it).
- **Zero added latency on the default path.** The terminal stays an
  _in-process_ subscriber (§7). Off-thread is reserved for the heavy
  interactive surfaces, where the async boundary is the point.

If any of these can't hold, the terminal stays on its current direct path
and devframe is web/MCP-only — the phasing in §9 makes that an explicit
fork, not an accident.

## 4. The event contract

### 4.1 Today's surface, restated as events

The current `Logger` calls map 1:1 to a tagged union — this is the
deleted `ObserverEvent` reborn, but **serializable**:

```ts
type RunEvent =
  | { kind: 'run:start'; run: RunMeta; tasks: TaskView[] }
  | { kind: 'task:start'; taskId: string; atMs: number }
  | { kind: 'task:stdout'; taskId: string; chunk: string }
  | { kind: 'task:stderr'; taskId: string; chunk: string }
  | { kind: 'task:complete'; taskId: string; outcome: OutcomeView }
  | { kind: 'run:status'; line: string } // header/footer/summary/diagnostic lines
  | { kind: 'run:end' }
```

Emit sites are unchanged in _location_ (`run.ts`, `execute-task.ts`) —
only the call target changes from `log.X(node, …)` to `bus.emit({ kind,
… })`.

### 4.2 The crux: ids on the wire, not object graphs

`TaskNode` and `TaskOutcome` cannot cross a thread boundary or an RPC as-is:

- `TaskOutcome.wallclockStartNs/EndNs` are **bigint** — `JSON.stringify`
  THROWS on a bigint outright (the hard, verified blocker; see
  `tests/events.test.ts`). Also a liability for valibot/MCP wire formats.
- `TaskOutcome.node` is a **back-reference to its `TaskNode`**, so each
  event would drag the whole node graph (config + dep nodes) across the
  boundary — structured-clone duplicates it per event.
- `TaskNode` carries the full resolved `config` and dep arrays — large,
  and re-sent on every event if passed by value.

So the wire normalizes:

- **`run:start` carries a one-time task table.** `TaskView[]` is the
  _projection_ of `TaskNode` down to exactly the fields renderers read:
  `{ id, project, task, isGroup, requested, surfaced, persistent,
command }`. Every later event references `taskId` only.
- **`OutcomeView`** is `TaskOutcome` minus `node`, with bigint ns encoded
  as decimal strings (analytics already tolerate a ms fallback; the
  string round-trips losslessly for the Chrome-trace profile).
- The renderer keeps a local `Map<id, TaskView>` rebuilt from
  `run:start`, so `formatFrameOpen(view)` / `formatTaskBlock(view, …)`
  work off the projection.

This is a real but _bounded_ refactor: the framed-output / status-line /
summary formatters currently take `TaskNode`. They are narrowed to take a
structural `TaskView` (the subset they already read). `TaskNode` satisfies
`TaskView` by construction, so the in-process path needs no copy — it
passes the node where a `TaskView` is expected — while the off-thread path
deserializes into the same shape. This is the same module-boundary
discipline the repo already enforces: the wire type is the contract, the
internal graph type is an implementation detail.

### 4.3 Two event classes: lossless vs lossy

Not all events are equal under backpressure (§6):

- **Lossless** — `run:start`, `task:start`, `task:complete`, `run:end`.
  Dropping these corrupts counts and the task table. Never dropped.
- **Lossy** — `task:stdout` / `task:stderr` chunks and periodic
  region-refresh ticks. A consumer that falls behind may **coalesce or
  drop** these (the web live view samples; the terminal already discards
  hit-replay buffers in `broad` mode). Losslessness is decided
  **per-consumer**, not by the producer — the producer stays dumb and
  cheap and emits everything.

## 5. Derived view-model (devframe shared state)

Raw events are the source of truth, but every surface needs the same
_aggregate_: per-task status, the running/done/failed/hit counters, the
worker-slot assignment, the duration spread. Today `defaultLogger`
computes this inline in its closure locals (`done`, `failed`, `slots`,
`spreadSum`, …). We extract that into a pure **reducer**:

```ts
reduce(state: RunState, event: RunEvent): RunState
```

`RunState` is exactly what the live region + final summary already render
(it mirrors the argument to `formatSummarySection` plus the slot array).
This is the reducer the deleted TUI's `state/store.ts` already prototyped —
revived as the single source of derived truth.

devframe's **shared state** (observable, patch-synced, survives
reconnects) holds `RunState`. A web client opening _mid-run_ gets the
current aggregate immediately, then live patches — no replay of the whole
event log. The terminal renderer runs the _same_ reducer locally off the
ordered stream (it needs the FIFO stream anyway for scrollback ordering),
so the two surfaces share one definition of "what the run looks like right
now" without sharing a code path.

Split of responsibilities:

- **Stream (one-way channel)** → scrollback lines, raw stdout/stderr,
  lifecycle. Ordered, FIFO. The terminal renderer's input.
- **Shared state** → the derived `RunState` aggregate. The web/TUI's
  reactive input. Patch-synced, reconnect-safe.

## 6. Threading + backpressure

The contract that makes "separate thread" actually safe:

1. **Emit is fire-and-forget and never blocks the producer.** `bus.emit`
   enqueues into a **bounded** ring and returns. It does not await a
   consumer, ever.
2. **Backpressure points at the consumer, never the producer.** When a
   consumer's queue is full, _lossy_ events are coalesced/dropped on the
   **consumer side**; _lossless_ events are kept (the lossless set is
   small and bounded by task count, so it can't blow memory). The run
   never waits. This is the rule force-floor coalescing already
   embodies — generalized to the channel.
3. **Reduction is cheap; rendering is not.** The expensive work is ANSI
   formatting + the writer's region diffing (we added force-floor
   _because_ 3270 tasks × redraws = 6.7 MB of output). The reducer
   (counters, slot assignment) is trivial. So the thing worth moving
   off-thread is **format + write**, not reduce.
4. **The live-region ticker lives with the renderer.** The 100 ms elapsed
   ticker moves to the render side, fully decoupled from exec.

Where each surface runs:

| Surface            | Thread            | Why                                           |
| ------------------ | ----------------- | --------------------------------------------- |
| Terminal (default) | in-process (main) | full fidelity, zero added latency, status quo |
| Web devtool        | off-thread/remote | browser is the renderer; can't freeze exec    |
| TUI                | off-thread        | the renderer that froze us 3×; isolate it     |
| MCP server         | off-thread/remote | agent-facing; long-lived                      |

The terminal staying in-process is deliberate: routing every stdout byte
(a failing build can dump MBs) through a structured-clone thread hop costs
copies for zero benefit on the path that's already fast and already on
main. The async boundary is spent where it pays — the interactive
surfaces. If profiling later shows main-thread _render_ cost matters on
huge runs, the terminal's format+write can move to a worker that posts
**pre-formatted byte frames** back to main (main just blits them in order,
preserving the single-writer cursor invariant) — but that's an
evidence-gated optimization, not v1.

## 7. Driving today's terminal output through devframe

Concretely, `defaultLogger` is refactored into a **devframe stream
adapter**:

- It subscribes to the `RunEvent` stream from `defineDevframe` instead of
  exposing `Logger` methods the orchestrator calls.
- Internally it is _the same code_ — the buffers, the separator
  bookkeeping, the `OutputView` mode switch, the writer — driven by a
  `switch (event.kind)` instead of by method dispatch. Each `Logger`
  method body becomes one `case`.
- It reads `TaskView` (§4.2) instead of `TaskNode`; the formatters are
  narrowed to match.

The orchestrator's `RunOptions.log?: Logger` seam stays for embedders and
tests (a custom logger is just an in-process subscriber that bypasses
devframe). The default CLI path constructs the devframe definition, attaches
the terminal adapter as its always-on in-process subscriber, and — when
`vx run --ui` / `--tui` (or an env opt-in) is set — _additionally_ boots
the off-thread web/TUI/MCP adapter from the **same** definition. No
selection flag, no UI attached: behaviourally identical to today.

## 8. How devframe maps

| devframe primitive          | vx usage                                                       |
| --------------------------- | -------------------------------------------------------------- |
| `defineDevframe`            | one definition: the run's stream + shared state + agent funcs  |
| Streaming channel (one-way) | the `RunEvent` stream → terminal/web/TUI                       |
| Shared state (patch-synced) | derived `RunState` → reconnect-safe web/TUI rendering          |
| CLI adapter                 | (optional) interactive CLI surface over the same defn          |
| SPA / embedded adapter      | the web devtool                                                |
| MCP server adapter          | agent-facing: `getRunState`, `tailTask(id)`, `whyDidThisRerun` |
| birpc + valibot             | the wire — validates `RunEvent` / `RunState` at the boundary   |

Note the philosophy tension to decide explicitly (§10): valibot validates
**our own internal events**, which cuts against "trust internal code,
validate only at boundaries." The honest framing: a thread/process/RPC hop
_is_ a boundary, so validating there is consistent — but we should validate
**once at the deserialization edge**, not re-validate in-process emits.

## 9. Phasing (each phase ships complete; no half-built flags)

1a. **Event bus + wire contract (SHIPPED 2026-06-17).** `src/orchestrator/
    events.ts`: the in-process `RunEvent` bus (`createEventBus`), a
`Logger`-shaped `busLogger` facade, the `terminalSubscriber` that
drives the concrete renderer, and the serializable projections
(`TaskView` / `OutcomeView` / `projectNode` / `projectOutcome` /
`WireEvent` / `toWireEvent`). `run.ts` now threads `busLogger` as its
`log`, so every existing `log.X(...)` call flows through the bus to
the renderer. **Output byte-identical — all 805 tests green, zero new
deps.** The renderer is untouched (still reads `TaskNode`); the wire
projections are the forward-looking contract for off-thread consumers,
landed with unit tests (`tests/events.test.ts`).

1b. **Reducer + formatter narrowing (DEFERRED).** The `reduce` /
`RunState` extraction and narrowing the formatters from `TaskNode` to
`TaskView` were intentionally NOT done yet: in Phase 1a the terminal
renderer is in-process and reads the live node directly, so neither
has a consumer. Building them now would be exactly the speculative
no-consumer surface this repo deletes. They land with the first
off-thread surface (Phase 3), which is what forces a serializable
view-model and `TaskView`-only rendering.

2. **devframe transport, in-process.** Wrap the stream/state in
   `defineDevframe`; terminal adapter subscribes through it. Still one
   thread. Proves the wire contract serializes (the cycle/bigint fixes
   from §4.2 are real here).
3. **Off-thread web devtool.** First _new_ surface: the SPA adapter on a
   worker/server, rendering `RunState` reactively. Behind `vx run --ui`.
   This is devframe's sweet spot (browser renders; transport done for us).
4. **MCP surface.** Agent-facing functions over the same definition — the
   most on-thesis surface for an agent-owned project.
5. **TUI (optional, later).** Only once 1–4 are stable. The substrate now
   structurally cannot freeze the run; the remaining risk is purely the
   ANSI _painter quality_ (the OpenTUI leakiness, "no screens for tasks
   without logs") — a separate bet, not blocked on this design.

## 10. Risks, non-goals, open questions

- **Dep weight.** birpc + valibot land in the tree. We went 304 → 19
  packages on purpose. Mitigation: Phase 1 adds _zero_ deps; devframe deps
  only enter at Phase 2, and only on the `--ui`/MCP paths, never the
  default `vx run`. **Open: is devframe's dep closure acceptable for a
  pre-alpha that prizes minimalism?** Measure it before Phase 2.
- **devframe maturity.** It is itself early. We are coupling new surfaces
  (not the default path) to a young framework — the inverse of the OpenTUI
  mistake only if the terminal never depends on it. The Phase-1 substrate
  is devframe-agnostic precisely so a devframe pivot costs us one adapter,
  not the logger.
- **Validation philosophy.** §8 — validate once at the deserialization
  edge, not on in-process emits. Needs a written rule so we don't sprinkle
  valibot through the hot path.
- **stdout volume cross-thread.** Resolved by keeping the terminal
  in-process (§6); revisit only with profiling evidence.
- **Non-goal:** replacing the terminal renderer's _look_. This is plumbing;
  the glyph grid / meters / frames are untouched.
- **Non-goal:** a persistent historical event log. The `runs` table in
  `cache.db` already records run history; this stream is live-only.

## 11. Files

Phase 1a (shipped):

- `src/orchestrator/events.ts` (new) — `RunEvent`, `createEventBus`,
  `busLogger`, `terminalSubscriber`, and the wire contract (`TaskView`,
  `OutcomeView`, `projectNode`, `projectOutcome`, `WireEvent`,
  `toWireEvent`).
- `src/orchestrator/run.ts` — constructs the bus, subscribes the renderer
  via `terminalSubscriber`, threads `busLogger` as `log`. The rest of
  `run()` and `execute-task.ts` are untouched: they call `log.*` exactly
  as before, now hitting the facade.
- `tests/events.test.ts` (new) — bus fan-out/ordering, busLogger↔
  terminalSubscriber equivalence (byte-identical drive-through), and the
  serialization crux (raw bigint outcome throws on `JSON.stringify`, the
  projection round-trips). The existing output suites remain the
  byte-identical acceptance gate.

Phase 1b+ (deferred, see §9): `run-state.ts` (`RunState` + `reduce`),
formatter narrowing to `TaskView`, and the `defaultLogger` switch-on-event
refactor — all land when an off-thread surface first needs them.
