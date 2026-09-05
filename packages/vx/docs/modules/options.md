# `src/orchestrator/options.ts` — RunOptions / RunSummary

## Purpose

The declaration home for the orchestrator's input/output types. They
live in a leaf file (not the module entry) so internals like
`prepare.ts` can import them without an upward import of the module's
`index.ts` — the entry must stay cycle-free.

## Public surface

```ts
export interface RunOptions {
  /* cwd, tasks, projects?, concurrency?, cache? (CachePolicy), forwardArgs?,
     excludeDependencies?, summarize?, profile?, log?, handleSignals? */
}
export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
}
```

Both are re-exported by `orchestrator/index.ts` (the module contract)
and by the package façade `src/index.ts`. See
[`orchestrator.md`](./orchestrator.md) for the full field-by-field
documentation — this page exists to map the file, the types are
documented with their consumer.

## What it does NOT do

No logic, no defaults. Default resolution (`concurrency`, `cache`,
`handleSignals`) happens in `run.ts` at the use sites (`cache` defaults
to `FULL_CACHE_POLICY` — every read/write axis on).
