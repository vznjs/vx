# `src/orchestrator/options.ts` — RunOptions / RunSummary

## Purpose

The declaration home for the orchestrator's input/output types. They
live in a leaf file (not the module entry) so internals like
`prepare.ts` can import them without an upward import of the module's
`index.ts` — the entry must stay cycle-free.

## Public surface

```ts
export interface RunOptions {
  /* cwd, tasks, projects?, staged?, concurrency?, cache? (CachePolicy), forwardArgs?,
     excludeDependencies?, summarize?, profile?, log?, handleSignals?, signal? */
}
export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
}
```

`staged` is the CLI's own selection load handed to the run: a filter
that walks the graph (`app...`, `--affected` with a diff) stages every
config to read the `pkg#task` edges, and the run reuses those entries
instead of evaluating and staging them again (`loadProjects` seeds and
scopes exactly as before). One run only — `vx watch` deletes it from
the options it re-runs, since a cycle after an edit must evaluate live.

Both are re-exported by `orchestrator/index.ts` (the module contract)
and by the package façade `src/index.ts`. See
[`orchestrator.md`](./orchestrator.md) for the full field-by-field
documentation — this page exists to map the file, the types are
documented with their consumer.

## What it does NOT do

No logic, no defaults. Default resolution (`concurrency`, `cache`,
`handleSignals`) happens in `run.ts` at the use sites (`cache` defaults
to `FULL_CACHE_POLICY` — every read/write axis on).
