# `src/orchestrator/events.ts` — run event bus + wire contract

## Purpose

`run()` never calls a `Logger` directly: every `log.X(...)` emits a
`RunEvent` through `busLogger` onto an in-process bus; the terminal
renderer is just the always-on subscriber. An embedder attaches as
another subscriber with no orchestrator change (`@vzn/vx-mcp` reads run
history, not the bus). A bus handed in through `RunOptions.bus` keeps
the embedder's subscribers across runs; what each run adds to it, the
run removes on its way out (`orchestrator.md`).

## Public surface

- `createEventBus()` — synchronous, order-preserving fan-out.
- `busLogger(bus)` — `Logger`-shaped facade that emits events.
- `terminalSubscriber(sink)` — drives a concrete renderer.
- `WireEvent` + `toWireEvent` — the SERIALIZABLE projection (task ids
  instead of node back-refs; bigint ns as decimal strings), and
  `wireForwarder(send)`, the subscriber that pushes every event through
  it. Exported for an embedder that carries a run across a process
  boundary; nothing in core consumes it (the telemetry records in
  `telemetry.ts` are a separate projection).
- `TaskView` / `OutcomeView` with `projectNode` / `projectOutcome` — the
  wire's task and outcome shapes; `RunStartInfo` is the run's.
- The outcome vocabulary, one copy for every surface: `outcomeWord`
  (`success` / `restored-local` / `restored-remote` / `up-to-date` /
  `failed` / `skipped`), `outcomeLabel` (the word with a failure's
  reason or a skip's blocker), `failedLabel`, `skippedLabel` and
  `skippedReason`. The frame footer, the run report, the terminal
  summary and `--summarize` all read these.

## Invariants

- Fan-out is synchronous, so terminal output is byte-identical to the
  pre-bus direct-call era.
- Raw `TaskOutcome`s are NOT serializable (bigint + graph back-refs);
  anything crossing a process boundary goes through `toWireEvent`.
