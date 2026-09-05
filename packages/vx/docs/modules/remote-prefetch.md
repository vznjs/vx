# `src/orchestrator/remote-prefetch.ts` — background remote GETs

## Purpose

With a `LayeredCache`, remote GET latency would sit on each task's
critical path. This derives every STABLE task's pure-input key up front
(reusing the run's `hashCache` memo — no double hashing) and fires the
remote GETs concurrently before scheduling, so network overlaps
execution. `LayeredCache` ingests hits into local and de-dups against
the lazy read-through: at most ONE remote GET per key.

## Public surface

- `startRemotePrefetch(args)` → `Promise<void>` handle. Fire-and-forget
  for scheduling; `run()` awaits it before `cache.close()` only.

## Invariants

- **Remote-only**: gated on `cache instanceof LayeredCache`; local runs
  never derive keys or probe anything here.
- Stability gate via `deriveStableKeys` — unstable (codegen-consumer)
  tasks stay on the lazy path.
- Never-fail: every path degrades to a miss.
