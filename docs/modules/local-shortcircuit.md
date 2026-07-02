# `src/orchestrator/local-shortcircuit.ts` — restore-ahead classify

## Purpose

The up-front CLASSIFY behind the two-tier scheduler: derive every
stable, cacheable, local-read task's key and probe the local cache
ONCE. Confirmed hits become the RESTORE TIER (ready immediately, low
priority — they backfill idle workers while misses own the pool);
stable misses skip execute's lazy probe; unstable tasks stay dep-gated.

## Public surface

- `startLocalShortCircuit(args)` → `{ preProbed, restoreTier }`.
- `ProbedEntry { hash, hit }` — consumed by execute-task (probe reuse:
  the up-front probes ARE execute's probes, hoisted — no double work).

## Invariants

- Gated by `shouldShortCircuit` (run.ts): local-only cache (NEVER
  LayeredCache — remote runs belong to remote-prefetch), `localRead`
  on, ≥1 dep edge.
- A graph declaring `outputs.workspaceFiles` disables the restore tier
  graph-wide (probe reuse still applies).
- Never throws — degrades to the normal schedule.
- Measured: mixed workload −6.6%; warm all-hit at parity.
