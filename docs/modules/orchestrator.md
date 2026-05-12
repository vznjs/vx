# `orchestrator.ts` — end-to-end glue

## Purpose

Drive a single `vx run` invocation from start to finish. Wire
workspace discovery, config loading, graph building, fingerprinting,
scheduling, per-task execution, and caching together.

## Public surface

```ts
export const VERSION: string

export async function run(options: RunOptions): Promise<RunSummary>

export interface RunOptions {
  cwd: string
  task: string
  projects?: string[] // restrict to these projects (and their graph)
  concurrency?: number
  force?: boolean // ignore cache hits; still write
  log?: Logger
}

export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
}

export interface Logger {
  status(line: string): void
  taskStdout(node: TaskNode, chunk: string): void
  taskStderr(node: TaskNode, chunk: string): void
}
```

## Lifecycle (high level)

See [`../execution.md`](../execution.md) for the full timeline. The
big steps inside `run()`:

1. Find workspace root, load workspace, list projects.
2. Load each project's config via `loadProjectConfig`.
3. Build `packageGraph` (from `package.json`s).
4. Compute `nestedProjectDirs` (for boundary isolation).
5. Filter `requested` to projects/tasks that exist and (if `options.projects`
   is given) are in that set.
6. Build the task graph.
7. Compute the workspace fingerprint (one hash per run).
8. Hand off to `scheduler.runGraph` with an `execute` callback that
   maps to `executeTask`.

## `executeTask`

The per-task work:

1. Resolve inputs (`inputs.resolveInputs`) → `{ files, envValues }`.
2. Filter upstream cache hashes (`filterUpstreamHashes`) using
   `cache.inputs.tasks` with per-bucket defaults and `'*' / '!name'`
   pattern matching.
3. Compute `taskConfigHash = sha256(JSON.stringify(node.config))`.
4. Compute the cache key via `cache.key(...)`.
5. If `cacheEnabled` (i.e., `cache` field provided AND `noCache` is
   off), look up `cache.get(hash)`:
   - Hit → restore outputs, replay stored stdout/stderr, return
     `cache-hit`.
6. Build the isolated env (essentials + `exec.env.passThrough` +
   `exec.env.define`) and run `exec.command` via `runCommand`. Any
   CLI `forwardArgs` are appended shell-quoted. Output streams live
   to the logger.
7. If exit 0 and caching is enabled, save the entry: `resolveOutputs`
   to find produced files, then `cache.save(...)`.
8. Return the `TaskOutcome` (status, exitCode, durationMs, hash).

## `filterUpstreamHashes`

Implements `cache.inputs.tasks` semantics:

- `filter === undefined` → every upstream hash contributes.
- Otherwise, for each upstream:
  - Determine bucket by whether `upstream.node.projectName ===
selfProjectName` (self) or not (dependencies).
  - If the bucket is undefined in `filter`, include the hash (per-bucket
    default = all).
  - If the bucket is present, walk its patterns in order:
    - `'*'` → include
    - `'name'` → include if `upstream.taskName === name`
    - `'!name'` → exclude if `upstream.taskName === name`
      Last write wins.

This gives the rich filtering documented in
[`../schema.md`](../schema.md) §`cache.inputs.tasks`.

## `computeNestedProjectDirs`

Given the project list, for each project compute the absolute dirs of
any other projects nested under it. Used by `inputs.ts` to exclude
them from file globs (the project-boundary guarantee).

## `computeWorkspaceFingerprint`

Hashes `pnpm-lock.yaml` + `pnpm-workspace.yaml`. Returned as one
string, folded into every task's cache key. Missing files are
silently skipped (e.g., a workspace without a lockfile yet).

## `hashTaskConfig`

```ts
sha256(JSON.stringify(node.config))
```

Captures every config-time decision — command list, env declarations,
output globs, input globs, dependsOn, cache.inputs.tasks filter — and
critically also captures _imported / computed values_ because `jiti`
has already baked them into the loaded object.

## `defaultLogger`

When `run({ log })` isn't provided, uses a logger that writes status
lines to stdout and prefixes per-task output with `<task#id> │ `.
Both stdout and stderr from tasks go to the corresponding parent
streams.

## What this does NOT do

- Doesn't parse command-line arguments — that's `cli.ts`.
- Doesn't define the cache key derivation format — that's `cache.ts`.
- Doesn't track signal handling. SIGINT propagates via Node defaults.
- Doesn't currently load `WorkspaceConfig` (deferred).

## Tests

`orchestrator.test.ts` is the largest test file (41 tests). It
covers the full integration surface — see the inline test names. All
other modules' unit tests verify their slices; this file verifies the
glue.

## Replacing this module

You probably wouldn't replace the whole orchestrator — it's the glue.
You'd replace individual modules and keep the wiring.

If you do refactor:

- Extract `executeTask` into its own file if it grows.
- Keep `run()` as the entry point that takes structured options and
  returns `RunSummary`.
- Don't make orchestrator dependencies bidirectional — modules
  should not know about the orchestrator.
