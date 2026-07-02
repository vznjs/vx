# `src/orchestrator/events.ts` — run event bus + wire contract

## Purpose

`run()` never calls a `Logger` directly: every `log.X(...)` emits a
`RunEvent` through `busLogger` onto an in-process bus; the terminal
renderer is just the always-on subscriber. Web/TUI/MCP surfaces attach
as additional subscribers with zero orchestrator changes.

## Public surface

- `createEventBus()` — synchronous, order-preserving fan-out.
- `busLogger(bus)` — `Logger`-shaped facade that emits events.
- `terminalSubscriber(sink)` — drives a concrete renderer.
- `WireEvent` + `toWireEvent` — the SERIALIZABLE projection (task ids
  instead of node back-refs; bigint ns as decimal strings) used by
  serve delegation, dev sockets, and event sinks.

## Invariants

- Fan-out is synchronous, so terminal output is byte-identical to the
  pre-bus direct-call era.
- Raw `TaskOutcome`s are NOT serializable (bigint + graph back-refs);
  anything crossing a process boundary goes through `toWireEvent`.
