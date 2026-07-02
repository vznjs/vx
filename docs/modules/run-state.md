# `src/orchestrator/run-state.ts` — reduced run aggregate

## Purpose

The derived view-model for non-terminal surfaces: `reduce(state, event)`
folds raw `RunEvent`s into the same counters/per-task statuses the
terminal renders inline, so a web/TUI/MCP surface renders reactively
from one place. Used by the devframe surface's `vx:run` shared state.

## Invariants

- Pure reducer; the terminal keeps its own inline counters
  (byte-identical output, untouched).
