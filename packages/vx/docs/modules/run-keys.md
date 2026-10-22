# `src/orchestrator/run-keys.ts` — a warm run's keys, read back whole

## Purpose

The up-front pass (`stable-keys.md`) derives every stable key and every
reusable uncached key one task at a time. With every fold memo row
answering, that walk still cost 250 ms of a 1,070 ms warm run at 9,600
tasks (2026-10-22). The run key memo stores the pass's result under one
token for the whole selection and hands it back when the token matches,
so a warm run that changed nothing derives no key.

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
export function runKeysToken(args: RunKeysArgs): { id: string; token: string } | undefined
export function readRunKeys(
  args: RunKeysArgs,
  at: { id: string; token: string },
): RunKeys | undefined
export function writeRunKeys(
  args: RunKeysArgs,
  at: { id: string; token: string },
  keys: RunKeys,
): void
```

- `runKeysToken` — the row's name is the hash of the selected task ids;
  the token is everything `deriveStableKeys` reads: the code that
  derives (a compiled binary's file stamp, or every source module's size
  and mtime), the workspace root, forward args, claimed root files,
  nested project dirs, the outputs git ignores, then per task its id,
  project, edges, `requested`, resolved config hash, plugin key parts,
  output adders and files token (`inputs.md`, the fold memo's), and the
  declared env values. It answers undefined, and the run derives as
  before, when there is no fold memo, or any task is keyless, has an
  excluded upstream, declares `runtime`, `workspaceRuntime` or
  `workspaceFiles` inputs, or has no files token (an untrusted input, an
  ignored path a declaration reaches).
- `readRunKeys` / `writeRunKeys` — the row lives in `fold_memo`
  (`hashCache.folds`) as JSON of stable and uncached keys by task id. A
  row naming a task this run lacks reads as absent.

Group keys are not stored: execute-task derives them on demand.

Tests: `tests/run-keys.test.ts` (a stored row is what the run uses; an
upstream edit, env value, config edit outside the project's files, and a
dirty edit each run what they reach; a keyless task stores nothing).
