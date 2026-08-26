# `src/orchestrator/metrics.ts` — analytics query layer

## Purpose

Pure functions over a `bun:sqlite` Database, read by the verbs that ship
today: `vx why` (`whyDidThisRerun`, `cacheKeyDiff`, `explainCacheKey`),
`vx last` (`getRun`, `listRuns`, `listInvocations`, `getInvocation`),
`vx info` (`getCacheStatsSql`, `listProjects`) and the predictive
scheduler's history (`getHistory`).

**Scope, as of 2026-08-26.** This layer used to carry the whole `/v1/*`
query surface for the self-hosted dashboard. That product was removed on
2026-08-23, and on 2026-08-26 the 15 queries that survived it — run
trends, bottlenecks, flakiest tasks, regressions, period comparison,
storage growth, parallelism history, prunable entries, cache
breakdown/savings, recent failures, comparisons, top time burners — went
with it. They had no caller in core or any plugin; only their own tests
referenced them. Core ships the seams and the verbs it actually has, and
anything wanting a dashboard builds it as a plugin over
`Cache.dbHandle()` and the `telemetry` seam.

## Invariants

- The SCHEMA is owned by `src/cache/cache.ts`; this module only reads.
  The drift guard in `tests/metrics.test.ts` runs every exported query
  against a freshly created cache.db, so a schema bump that breaks a
  query fails the core gate.
- No writes, no caching — callers own connection lifetime.
- A status set used in SQL is DERIVED from the predicate
  (`TASK_STATUSES.filter(isCacheHit)`), never retyped. A hand-written
  list is what drifts when a status is added, and
  `tests/status-vocabulary.test.ts` fails if one appears.
- A skip is a task of the run but not an EXECUTION: rates and means go
  through `EXECUTED_RUNS_SQL`, and a keyless row never answers a
  cache-key question.
