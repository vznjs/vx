# `src/orchestrator/plugin-host.ts` — eventSink wiring

## Purpose

Wires each plugin's `eventSink` capability onto the run bus via
`wireForwarder`, so sinks receive the serializable `WireEvent` stream.

## Public surface

- `subscribeEventSinks(plugins, bus, ctx)` → `SubscribedEventSinks`
  (the live sinks + a disposer).
- `teardownPlugins(plugins, sinks, warn)` — end-of-run: each sink's
  `flush()` then each plugin's `teardown()`, each under try/catch and a
  time bound; errors warn, never throw.

## Invariants

- Sink init failures are isolated per plugin (warn + skip).
- Dispose only unsubscribes; teardown is the flush point.
