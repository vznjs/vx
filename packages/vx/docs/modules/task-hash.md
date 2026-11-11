# `src/orchestrator/task-hash.ts` — cache-key derivation

## Purpose

The single place that selects and assembles the parts of a task's
cache key: resolved input files and `workspaceFiles`, env and runtime
values, the task-config digest, the upstream hashes `inputs.tasks` keeps
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
  taskConfig: WeakMap<TaskConfig, string> // task-config digest, by config object identity
  runtime: Map<string, Promise<string>> // `inputs.runtime` output, by projectDir + '\0' + command
  workspaceRuntime: Map<string, Promise<string>> // `workspaceRuntime` output, by command
  workspaceFiles: WorkspaceFilesCache // `inputs.workspaceFiles` resolution, by declaration
  projectFiles: ProjectFilesCache // `inputs.files` resolution, by projectDir + declaration
  folds?: FoldMemo | undefined // each task's last key by its probe, across runs (cache.md, fold-memo.ts)
  graph?: string | undefined // the remembered graph's token while nothing edited the nodes (graph-memo.md)
}
// cleanOutputs: the workspace's `outputs.clean`, kept beside the HashCache (not on it, the package's surface);
// `false` keys a task without its own as if it declared it
// strategies: `VX_INPUTS_STABILITY_STRATEGY` (`run`) and the workspace's `inputs.stability.strategy`, kept beside
// it the same way; a key folds the strategy a task runs under when it differs from what the task declares
export function createHashCache(
  folds?: FoldMemo,
  cleanOutputs?: boolean,
  strategies?: { run?: InputStability['strategy']; workspace?: InputStability['strategy'] },
): HashCache
export function workspaceCleanOf(hashCache: HashCache): boolean | undefined
export function inputStrategiesOf(
  hashCache: HashCache,
): { run?: InputStability['strategy']; workspace?: InputStability['strategy'] } | undefined

export interface ComputeHashArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  cache: CacheLayer
  forwardArgs?: readonly string[] | undefined
  nestedProjectDirs: string[]
  gitFilesCache?: GitFilesCache
  hashCache?: HashCache
  captureInto?: TaskInputComponent[] // filled at each fold site inside `cache.key()`; no effect on the hash
  probesAfterWrites?: ReadonlySet<string> // stable-keys.md: these tasks' probes are answered per task (`runtimeScope`)
}

export async function computeTaskHash(args: ComputeHashArgs): Promise<string>
// A key derivation whose throw is rethrown as the scheduler's `KeyFailed`.
export async function keyOf(derived: Promise<string>): Promise<string>
export async function describeTaskInputs(args: ComputeHashArgs): Promise<{
  hash: string
  inputs: TaskInputs
  facts: InputFact[]
  describedAt: number
  readUpstream: () => Promise<void> // lists `inputs.upstream`, a non-cacheable upstream's outputs from disk
  added: () => string | undefined // an input file the key did not fold that exists now
}>

// A file the key folded, its digest, and since when that digest is known true (ms epoch).
export interface InputFact {
  path: string
  digest: string
  since: number
  ctimeMs?: number // the ctime of the describe's stat behind the digest (none for an index OID)
  behind?: string // a link's content as the key folds it (`behindLink`)
}
export async function movedInput(
  facts: readonly InputFact[],
  cache: CacheLayer,
  commandFrom?: number, // the command's start on the file system's clock (`fsClockNow`), just after the describe
  byBytes?: (file: string, ctimeMs: number) => boolean, // `'mutable'`: true judges that write by bytes
): Promise<string | undefined>
// command-windows.ts: when each command of the run ran, and each restore or deferred fetch, and where it may write.
export interface CommandWindows {
  open(id: string, projectDir: string, reach: WriteReach): () => void // a command, a hit's restore or a deferred fetch starts; the function marks its end
  writerDuring(self: string, file: string, from: number, to: number): string | undefined // another command that may write `file` and ran within [from, to]
}
export function commandWindows(): CommandWindows
export function computeGroupKey(args: ComputeHashArgs): Promise<string>
// The fold memo's files token for one task, or undefined (run-keys.md).
export function taskFilesToken(
  args: Pick<ComputeHashArgs, 'node' | 'workspaceRoot' | 'nestedProjectDirs'> & {
    gitFilesCache: GitFilesCache
  },
): string | undefined
// The resolved config's hash as the key folds it.
export function hashTaskConfig(cfg: TaskConfig, hashCache?: HashCache): string
export interface UpfrontGroupKey {
  key: string
  upstream: TaskOutcome[]
}
```

- `computeTaskHash` — resolves `inputs.files` (git-backed) and
  `workspaceFiles`, reads `inputs.env` host values, runs the
  `runtime` commands once per run, hashes the resolved task config, folds in the filtered upstream hashes,
  and calls `cache.key({...})`. Timed as the `task hash` span. With
  `hashCache.folds` and a `filesToken` (inputs.md: a partition of
  trusted, clean, unlinked files and a declaration that reaches no
  ignored path and no workspace file), it first folds everything but the
  files (`foldHead`, which ends where the files begin) and seeds it into
  the token: a probe the memo already holds for the task names the key,
  and no file is resolved or folded (~300 ms of a 5,000-project warm run,
  2026-10-17). Any other probe takes the whole fold and remembers its
  key. A capturing call never reads the memo.
- `captureInto` — on a miss the orchestrator persists the captured
  components to `entry_inputs` inside the save transaction, so a later
  run can diff its inputs against this one (`vx why`); a hit captures
  nothing, so the warm path is free.
- `describeTaskInputs` — the key AND the structured input set behind
  it, for the executor seam on the miss path: it re-runs the memoized
  resolution and keeps the values the key folded (env, runtime output,
  per-file digests), which `captureInto` reduces to digests because
  its rows are persisted. Its `facts` date each digest: an index OID
  from the git enumeration's start (`GitFilesCache.enumeratedAtMs`), a
  hashed file from the describe's own start (`describedAt`). Its
  `added` runs inputs.md's `addedInput` over the listings the key was
  filtered from, dated from the enumeration's start (the describe's
  own start with no run cache). `inputs.upstream` lists each upstream's
  outputs from the local index; `readUpstream`, which execute-task awaits
  for a plugin executor only, lists a non-cacheable upstream's from its
  declared outputs on disk (it keeps no entry, and a remote executor
  shipped its dependant without them).
- `movedInput` — the post-command re-check (item 743): one `lstat` per
  fact; a file whose ctime is not older than its fact by
  `FILE_HASH_RACY_MS` (plus a second for a whole-second stamp, two
  for an even one, `racyWindowMs`) is hashed again and compared, and a missing file
  has moved. So has one whose ctime is after `commandFrom` (or within
  a whole-second stamp's widening of it), whatever it holds now: an
  input changed and changed BACK while the command ran matches its
  digest again (item 1015). A ctime equal to `commandFrom` shares its
  coarse tick: it is an upstream's write, judged by content, when the
  describe's stat saw that very ctime (`InputFact.ctimeMs`), else the
  command's. Where `byBytes` answers true (execute-task
  passes it for `inputs.stability.strategy: 'mutable'` or
  `VX_INPUTS_STABILITY_STRATEGY=mutable`, true when no other command
  that may write the file ran between the describe and that write,
  `command-windows.ts`; `vx watch` reads the same windows to tell a
  user's write during a cycle from the run's own, `RunOptions.commandWindows`) such a write is hashed and compared instead. Returns the
  first moved path; execute-task then withholds the save.
- `keyOf` — wraps a key derivation for `executeTask` and `plan()`: a
  throw (a runtime probe that exits non-zero, a refused `inputs.env`
  value) becomes `KeyFailed` (scheduler.md), so the run and `--dry` say
  `cache key not derived: …` alike and the outcome is marked `isKeyFailed`.
- `computeGroupKey` — for group tasks (no `exec`): rolls up upstream
  hashes only, so downstream keys still cascade through the group. The
  default `build` (projects.ts), the one group with `cache`, is keyed as
  a task is (`computeTaskHash`), so it folds every file of its project.
- `UpfrontGroupKey` — an unkeyed group's key from the up-front pass and
  the upstream it folded (stable-keys.md); a live upstream with the same
  ids and keys in order derives the same bytes, so execute-task reuses it.

## Invariants

- A new key field, or a change in the order or framing of existing ones,
  requires a `CACHE_VERSION` bump; a change in which values flow into an
  existing field does not, since it moves those keys itself (see
  [`../caching.md`](../caching.md#bumping-cache_version)).
- Hash algorithm is xxHash3 via `util/hash.ts` (16-hex keys).
- A key hands `Cache.key()` each input file's identity in
  `fileHashes`: the index OID, else the run's `identityOf`, else one
  `hashFilesOf` for every file left, learned for the run. The map is the
  fold's fast path only, so the key is the bytes the fold would derive
  per file (`tests/stale-hit-memo.test.ts`: a file a task rewrote after
  its identity was learned keys again).

## Tests

`tests/task-hash.test.ts` and `tests/task-hash-derive.test.ts` (what
the key folds and how it cascades), `tests/orchestrator.test.ts`
(cache-hit / invalidation end to end) and `tests/plan-predict.test.ts`
(predicted keys match executed keys).
