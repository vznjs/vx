# `src/orchestrator/task-hash.ts` — cache-key derivation

## Purpose

The single place that selects and assembles the parts of a task's
cache key: resolved input files and `workspaceFiles`, env and runtime
values, the task-config digest, the project `package.json` digest,
the workspace fingerprint, the upstream hashes `inputs.tasks` keeps
(a group's own upstream expanded through it), forwarded `--` args on
a requested task, and the plugin parts the `key` stage attached
(`node.keyParts`). Split out of `execute-task.ts` because the plan,
the prepare step, the prefetch, the local short-circuit, the miss
save, admission and the stable-key probe all need the hashing surface
without the execution glue.

It lives in `orchestrator` (not `cache`) deliberately: key-part
selection composes graph types (`TaskNode`, `TaskOutcome`), and
pushing it into `cache` would force a `cache → graph` edge the
dependency matrix forbids. The byte-level folding itself stays in
`Cache.key()`.

## Public surface

```ts
// Per-run memos of derived values, shared across every task's computeTaskHash call.
export interface HashCache {
  packageJson: Map<string, Promise<string>> // project package.json digest, by projectDir
  taskConfig: WeakMap<TaskConfig, string> // task-config digest, by config object identity
  runtime: Map<string, Promise<string>> // `inputs.runtime` output, by projectDir + '\0' + command
  workspaceRuntime: Map<string, Promise<string>> // `workspaceRuntime` output, by command
  workspaceFiles: WorkspaceFilesCache // `inputs.workspaceFiles` resolution, by declaration
}
export function createHashCache(): HashCache

// One key component at hash time: mirrors `Cache.key()`'s fold-site rows one for one.
export interface TaskInputComponent {
  kind: string
  name: string
  hash: string
}

export interface ComputeHashArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  forwardArgs?: readonly string[] | undefined
  nestedProjectDirs: string[]
  gitFilesCache?: GitFilesCache
  hashCache?: HashCache
  captureInto?: TaskInputComponent[] // filled at each fold site inside `cache.key()`; no effect on the hash
}

export async function computeTaskHash(args: ComputeHashArgs): Promise<string>
export async function describeTaskInputs(
  args: ComputeHashArgs,
): Promise<{ hash: string; inputs: TaskInputs }>
export function computeGroupHash(upstream: TaskOutcome[]): string
```

- `computeTaskHash` — resolves `cache.inputs.files` (git-backed) and
  `workspaceFiles`, reads `cache.inputs.env` host values, runs the
  `runtime` commands once per run, hashes the resolved task config and
  the project `package.json`, folds in the filtered upstream hashes,
  and calls `cache.key({...})`. Timed as the `task hash` span.
- `captureInto` — on a miss the orchestrator persists the captured
  components to `entry_inputs` inside the save transaction, so a later
  run can diff its inputs against this one (`vx why`); a hit captures
  nothing, so the warm path is free.
- `describeTaskInputs` — the key AND the structured input set behind
  it, for the executor seam on the miss path: it re-runs the memoized
  resolution and keeps the values the key folded (env, runtime output,
  per-file digests), which `captureInto` reduces to digests because
  its rows are persisted.
- `computeGroupHash` — for group tasks (no `exec`): rolls up upstream
  hashes only, so downstream keys still cascade through the group.

## Invariants

- Any change to what participates in the key requires a
  `CACHE_VERSION` bump (see
  [`../caching.md`](../caching.md#bumping-cache_version)).
- Hash algorithm is xxHash3 via `util/hash.ts` (16-hex keys).

## Tests

`tests/task-hash.test.ts` and `tests/task-hash-derive.test.ts` (what
the key folds and how it cascades), `tests/orchestrator.test.ts`
(cache-hit / invalidation end to end) and `tests/plan-predict.test.ts`
(predicted keys match executed keys).
