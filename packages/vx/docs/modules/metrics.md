# `src/orchestrator/metrics.ts` — run-history queries

## Purpose

Pure functions over the run-history tables (`runs`, `invocations`,
`entries`, `entry_inputs`) — one canonical home for every aggregate,
so `vx last`, `vx why`, and any out-of-process reader (`@vzn/vx-mcp`'s
`explainCacheKey` / `whyDidThisRerun` tools) ask the same questions
the same way. The schema itself is owned by `src/cache/cache.ts`; this
module only reads it.

## Public surface

```ts
listRuns(db, { limit?, project?, task?, runId? }): RunSummaryRow[]
getRun(db, runId): RunDetail | null                 // one invocation's task rows
listInvocations(db, { limit?, ... }): InvocationDetail[]
getInvocation(db, runId): InvocationDetail | null   // the header row, tags parsed
explainCacheKey(db, taskId): CacheKeyExplanation    // latest entry for a task
latestRunId(db, taskId): string | null              // the run a caller without one means
whyDidThisRerun(db, runId, taskId): WhyDidThisRerun // this run vs the previous one
cacheKeyDiff(db, runId, taskId): CacheKeyDiff       // which key components moved
```

Every function takes an open `bun:sqlite` `Database` (the caller owns
the `Cache` lifecycle — `cache.dbHandle()`), returns JSON-safe shapes
(bigint spans as decimal strings, like `WireEvent.timeUnixNano`), and
never throws on a missing row: `found: false`, `null`, or an empty
list, with a `note` that says which case it is.

## The two explanations

- `whyDidThisRerun` compares a task's row in `runId` with its
  immediately previous row: `hashChanged` when the keys differ; when
  they do not, the note says whether the run was served from cache,
  re-executed on the same key (`--no-cache` / `--force`), or recorded
  no cache outcome at all.
- `cacheKeyDiff` is the moat: it resolves both runs to their task
  hashes and full-outer-joins the two `entry_inputs` fingerprint sets
  over `(kind, name)` — `changed` / `added` / `removed`, unchanged ones
  counted — with no config re-evaluation and no re-hash. Values are
  digests, never the material (an env value can be a secret); STATUS
  § Next 8(g) records why a plugin part's raw value is not stored.

Keyed-run filtering (`KEYED_RUNS_SQL`, the cache module's) is
imported, not restated, so a rule written once cannot drift between
readers.

## What it does NOT do

- Open or close anything; no `Cache` lifecycle.
- Evaluate configs or recompute a key — `explainCacheKey` says so in
  its note: it returns persisted entry metadata.
- Write rows. `recordRunBundle` (`cache/run-history.ts`) is the writer.

## Tests

`tests/metrics.test.ts` (every query, the three unchanged-key notes,
the diff's four verdicts, degraded rows whose fingerprints were
pruned); `tests/run-record-completeness.test.ts` (a run writes what
these read); `tests/status-vocabulary.test.ts` (no hand-typed status
lists).

## Replacing this module

A reader over another store implements the same eight signatures; the
CLI verbs and the MCP tools format, they do not query.
