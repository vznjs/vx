# `src/orchestrator/options.ts` — RunOptions / RunSummary

## Purpose

The declaration home for the orchestrator's input/output types. They
live in a leaf file (not the module entry) so internals like
`prepare.ts` can import them without an upward import of the module's
`index.ts` — the entry must stay cycle-free.

## Public surface

```ts
export interface RunOptions {
  cwd: string
  tasks: readonly string[] // bare names and `pkg#task` specs
  projects?: string[] // the selection's project names; undefined = no scope needed
  staged?: ReadonlyMap<string, ProjectEntry> // the CLI's own selection load, reused once (below)
  concurrency?: number
  cacheDir?: string // --cache-dir, resolved against cwd
  cache?: CachePolicy // default FULL_CACHE_POLICY
  remoteRequested?: boolean // a --cache spec named a remote axis
  frozen?: boolean // run the lock's graph
  outputLogs?: 'full' | 'errors-only' | 'none' | 'hash-only'
  download?: 'all' | 'toplevel' | 'none'
  flow?: 'focused' | 'broad'
  retries?: number
  timeout?: number
  continueMode?: ContinueMode
  excludeDependencies?: 'all' | readonly string[]
  forwardArgs?: readonly string[]
  summarize?: string
  profile?: string
  handleSignals?: boolean
  signal?: AbortSignal
  holdPersistent?: boolean // hand requested persistent tasks back on RunSummary.persistent
  log?: Logger
  bus?: EventBus // an embedder's bus; the run's own when absent
  inflight?: Map<string, Promise<void>> // admission's cross-run in-flight table
  tags?: Record<string, string> // onto the run record
  telemetrySinks?: readonly TelemetrySink[] // an embedder's sinks, ahead of the plugins'
  command?: string // the invocation as recorded (`vx run …`)
  remoteCache?: RemoteCacheLayer // an injected remote layer; wins over the cache seam
  artifactCeiling?: number // the 2 GiB artifact ceiling, lowered only by a test
}
export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
  persistent?: HeldPersistent // { ids, stop() }: what holdPersistent handed back
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
