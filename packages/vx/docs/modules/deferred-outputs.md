# `src/orchestrator/deferred-outputs.ts` — the deferred-output registry

## Purpose

Run-scoped home for tasks whose outputs were left in the remote store
(`--download=none` / `toplevel`), plus the lazy materialisation that
fetches them when a locally-placed task turns out to need them.

## Public surface

```ts
export interface DeferredEntry {
  materialize: () => Promise<void> // fetches the producer's outputs into its project dir
  hash: string
  entry: { taskId: string; command: string; durationMs: number; stdout: string }
}

export interface DeferredOutputsArgs {
  nodes: Map<string, TaskNode>
  cache: CacheLayer
  workspaceRoot: string
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache?: GitFilesCache
  localWrite: boolean
}

export class DeferredOutputs {
  constructor(args: DeferredOutputsArgs)
  register(taskId: string, entry: DeferredEntry): void
  pending(): string[]
  get size(): number
  materializeFor(node: TaskNode): Promise<void>
}
```

- `register(taskId, {materialize, hash, entry})` — execute-task calls this
  instead of saving, when a deferred result comes back.
- `materializeFor(node)` — fetch every deferred producer in `node`'s
  TRANSITIVE dependency closure. Which upstream bytes a command reads is
  unknowable (that is what `dependsOn` declares), so the whole closure is
  taken; each producer materialises at most once per run and they run
  concurrently. The closure is walked pre-order on an explicit stack: it
  is as deep as the graph, and a recursion per edge threw `RangeError`
  at 50,000.
- `pending()` — task ids whose outputs are still remote, for the run
  summary (`size` is their count). An entry is cleared only on
  SUCCESS, so this covers both "nothing needed them" and "fetching
  them FAILED" — the second is exactly when a user needs telling
  their tree is not current.

## Invariants

- A deferred task writes NOTHING locally — no artifact, no `entries` row,
  no `output_files`. A row without an artifact is the corrupt-entry shape
  `restoreOutputs` refuses.
- Materialisation CONVERGES: clean → closure writes → ordinary
  `cache.save` → `markOutputsChanged`, mirroring `restoreHit`'s sequence
  so the two cannot drift. Afterwards the machine is indistinguishable
  from a `--download=all` run, so no third storage state persists.
- A failed fetch is the CONSUMER's failure, named with the producer and
  the remedy — executing against a half-materialised tree is the
  stale-input class with extra steps.
- Only core calls `materialize()`, and only before a locally-placed,
  cache-missing task. A cache HIT reads no inputs and triggers nothing;
  a remote-placed consumer grafts by reference.

## Tests

`tests/download-policy.test.ts` — no-local-entry, lazy materialisation,
memoisation (two consumers, one fetch), convergence to a local hit,
never-clean, fail-loud, the `--continue` interactions, and a producer
50,000 tasks below its consumer.
