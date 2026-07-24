# `src/orchestrator/metrics.ts` — analytics query layer

## Purpose

Pure functions over a `bun:sqlite` Database — every aggregate the
dashboard, `/v1/*` routes (the self-hosted service), and `vx mcp` read:
run history, task rankings, cache stats, hit-rate splits, invocations,
`whyDidThisRerun`, `cacheKeyDiff`, `compareRuns`.

## Invariants

- The SCHEMA is owned by `src/cache/cache.ts`; this module only reads.
  The drift guard in `tests/metrics.test.ts` runs every exported query
  against a freshly created cache.db, so a schema bump that breaks a
  query fails the core gate — not the dashboard at runtime.
- No writes, no caching — callers own connection lifetime.
