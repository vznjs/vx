# `src/orchestrator/wire-render.ts` — WireEvent → Logger adapter

## Purpose

The inverse of `wireForwarder`: reconstructs node-shaped objects from a
`WireEvent` stream and drives a normal `Logger`, so a DELEGATED run
renders byte-identically to a local one. The terminal renderer stays
untouched — this file is the whole adapter.

## Invariants

- `task:start` carries the full `TaskView`; the renderer's state is
  rebuilt incrementally (no upfront table).
- The post-run:end summary footer (`run:status` lines) is forwarded —
  delegated runs keep their footer.
