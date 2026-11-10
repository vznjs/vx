# `src/orchestrator/run-keys.ts` — a warm run's keys, read back whole

## Purpose

The up-front pass (`stable-keys.md`) derives every stable key and every
reusable uncached key one task at a time. With every fold memo row
answering, that walk still cost 250 ms of a 1,070 ms warm run at 9,600
tasks (2026-10-22). The run key memo stores the pass's result under one
token for the whole selection and hands it back when the token matches,
so a warm run that changed nothing derives no key. A run after an edit
derives only the keys the edit reaches (the delta row, below): one file
changed at 200 tasks keyed all of them again, 22 ms of a 120 ms run
where Turbo took 109 (2026-10-28).

## Public surface

```ts
export interface RunKeysArgs {
  nodes: Map<string, TaskNode>
  workspaceRoot: string
  claimedFiles: readonly string[]
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
}
export interface RunKeys {
  stableKeys: StableKey[]
  uncachedKeys: Map<string, string>
}
export interface RunKeysAt {
  id: string
  token: string
  delta?: () => { global: string; files: Map<string, string> }
}
export interface RunDerivation {
  keys: Map<string, string>
  stable: string[]
  uncached: string[]
}
export function runKeysToken(args: RunKeysArgs): RunKeysAt | undefined
export function readRunKeys(
  args: RunKeysArgs,
  at: { id: string; token: string },
): RunKeys | undefined
export function readRunDelta(
  args: RunKeysArgs,
  at: RunKeysAt,
): { derivation: RunDerivation; dirty: Set<string> } | undefined
export function writeRunDelta(args: RunKeysArgs, at: RunKeysAt, derivation: RunDerivation): void
export function writeRunKeys(
  args: RunKeysArgs,
  at: { id: string; token: string },
  keys: RunKeys,
): void
// The code that derives keys, as a stamp (graph-memo.md shares it).
export function codeIdentity(): string
```

- `runKeysToken` — the row's name is the hash of the selected task ids;
  the token is everything `deriveStableKeys` reads: the code that
  derives (a compiled binary's file stamp, told by `Bun.main`, or every source module's size,
  mtime, ctime and inode: an npm tarball's fixed mtime left a same-size
  upgrade unseen), the workspace root, forward args, claimed root files,
  nested project dirs, the outputs git ignores, the workspace's
  `outputs.clean` and the `inputs.stability.strategy` of the workspace
  and of `VX_INPUTS_STABILITY_STRATEGY` (a config key folds them, and a
  remembered graph's token names the lock, not `.vx/workspace` or the
  variables), then per task its id,
  project, edges, `requested`, resolved config hash, plugin key parts,
  output adders and files token's hash (`inputs.md`, the fold memo's), and the
  declared env values. When the nodes are a remembered graph no plugin
  or flag edited (`hashCache.graph`, graph-memo.md), that graph's token
  stands for each task's project, edges, config and adders, and a task
  adds only its id, `requested` and files token hash. It answers undefined, and the run derives as
  before, when there is no fold memo, or any task is keyless, has an
  excluded upstream, declares `runtime` or `workspaceRuntime` inputs,
  or has no files token (an untrusted input, an ignored path a
  declaration reaches). A `workspaceFiles` declaration is in the files
  token (`inputs.md`): refused, every key of a repo whose tasks read a
  root `tsconfig.json` derived again on every no-op (vueuse: 107 of
  230 ms, 2026-11-10). A files token is computed and
  hashed once per project and declaration (inputs and outputs), and the
  declaration's text once per config object: the lock shares one among
  the tasks that declare it alike. The hash, not the ~200-character
  token, is what each task adds (2 MB of token at 8,002 tasks,
  2026-11-07), and it is the delta's files token hash too.
- `readRunKeys` / `writeRunKeys` — the row lives in `fold_memo`
  (`hashCache.folds`) as JSON of the stable and uncached keys, each by
  its task's place in the run's node order, which the token pins (every
  id, in order): by id, the ids and a lookup per task were ~5 ms of
  8,002 (2026-11-07). A row naming a place this run lacks reads as
  absent.

- `readRunDelta` / `writeRunDelta` — a second row (`\0rund\0` + the
  selection hash), written beside the run row, read only when the run
  row misses. It holds every key the last derivation made, in walk
  order, which became stable or uncached keys, and each task's files
  token hash, under the GLOBAL token: the token with each task's files
  token left out. It exists only under a remembered graph
  (`hashCache.graph`), where the global token names every edge and
  config. The stable and uncached verdicts read only what it names (the
  graph, configs, ignored outputs, claimed files), so they stand; the
  dirty tasks are those whose files token moved and every task folding
  one of theirs, and `rederiveKeys` (stable-keys.ts) derives just those,
  over their deps' keys, in the walk's order.

Group keys are not stored: execute-task derives them on demand.

Tests: `tests/run-keys.test.ts` (a stored row is what the run uses; an
upstream edit, env value, config edit outside the project's files, and a
dirty edit each run what they reach; an edit derives only the keys it
reaches, and they equal a full derivation's; a keyless task stores
nothing); `tests/run-keys-token.test.ts` (a shared declaration taken
once; each distinct files token hashed once; each ingredient of a files
token moves the token and the delta's files but not the global token; a
row read back by place, and another node order is another row).
