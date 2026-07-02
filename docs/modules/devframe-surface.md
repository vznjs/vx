# `src/orchestrator/devframe-surface.ts` — devframe definition

## Purpose

Exposes a run to devframe hosts as `vx:events` (streaming WireEvent
channel) + `vx:run` (patch-synced `RunState` shared state). The host
adapter (dev server) mounts this definition.

## Invariants

- devframe is a devDependency touched ONLY via type-only imports here;
  hosts dynamic-import the runtime adapter — core `vx run` never gains
  a runtime dep on it.
