# `src/cli/watch.ts` — `vx watch` subcommand

## Purpose

Run a task once, then re-run it on every filesystem change in the
projects in scope. The initial run goes through the same orchestrator
path as `vx run`; the watch loop just keeps calling it on debounced
filesystem events.

## Public surface

```ts
export function watchCmd(args: readonly string[]): Promise<number>
```

`cli.ts` dispatches `vx watch <...>` here. Returns the exit code
(`0` on clean Ctrl+C; `1` on parser / scope error).

## Flag surface

`watchCmd` reuses `cli/run.ts:parseRunArgs` so every `vx run` flag
that makes sense for a loop is supported. Rejected with exit 1:

| Flag                        | Reason                                         |
| --------------------------- | ---------------------------------------------- |
| `--dry` / `--graph`         | They skip execution; nothing to watch.         |
| `--summarize` / `--profile` | Would overwrite their target file every cycle. |
| (no task name)              | Watch needs an explicit task — no picker.      |

Everything else (`--all`, `--filter`, `--affected`, `--concurrency`,
`--no-cache`, `--excludeDependencies`, `--verbosity`, forwarded
`--` args) passes through unchanged.

## Algorithm

1. `parseRunArgs` + validate the watch-mode rejections above.
2. `cli/run.ts:resolveRunOptions(parsed, cwd, tasks)` → `RunOptions`.
   Same scope resolution as `vx run`.
3. Enumerate projects in the resolved scope via `listProjects`. Empty
   scope → exit 1.
4. **Initial run.** Print `vx watch: initial run...`; call
   `orchestrator.run(opts)`.
5. **Watch loop** (`runWatchLoop`):
   - For each project, `fs.watch(dir, { recursive: true })`. Bun
     supports recursive watch on every platform.
   - For the workspace root, `fs.watch(root, { recursive: false })`
     — only fingerprint files (`pnpm-lock.yaml` / `bun.lock` / …)
     trigger.
   - Filter out `node_modules` / `.git` / `.vx` path segments and
     `.tsbuildinfo` / `~` suffixes (editor swap files).
   - Debounce events `~150ms` after the last one before triggering a
     cycle.
   - Reentrancy guard: while a cycle is running, further events set
     a `pending` flag; the loop drains it after the current cycle
     finishes. Two events can collapse into one re-run.
6. **Exit.** `process.once('SIGINT', cleanup)` resolves the loop
   promise after closing all watchers. Returns 0.

## Why not filter by `cache.inputs.files`

We could pre-compute the union of every task's input globs in the
resolved graph and reject events outside it. We don't, for two
reasons:

- **The cache key is the source of truth.** A spurious cycle is a
  cache-hit re-run (~tens of ms). Pre-filtering would mean redoing
  the glob + project-boundary work on every event — easily worse
  than the cache lookup.
- **Globs change with `vx.config.ts` edits.** Pre-computing would
  miss config changes that re-shape what's watched. The current
  "watch the whole project dir" approach is robust.

## Why no automatic persistent-task lifecycle

Watch mode just re-invokes `orchestrator.run` per cycle. The
orchestrator's persistent-task lifecycle (spawn → SIGTERM at
end-of-run) applies per cycle. So a `persistent` dev server gets
re-spawned each cycle.

For dev-server workflows, use the dev tool's own watch (`vite`,
`tsc -b -w`, `bun --watch`) rather than `vx watch`. `vx watch` is
for `vx watch test` / `vx watch lint` / `vx watch build` —
non-persistent tasks where each cycle should re-run cleanly.

## What this does NOT do

- Doesn't accept the interactive picker — task name is required.
- Doesn't filter events through declared input globs.
- Doesn't dedupe events by project — every file change triggers a
  re-run of the user's specified task across the entire scope.
- Doesn't manage persistent tasks across cycles (they re-spawn).
- Doesn't react to lockfile changes _during_ a cycle (the cache key
  is computed once per cycle; mid-cycle lockfile bumps land in the
  next cycle).

## Tests

`tests/cli.test.ts`:

- `vx watch` with no task → exits 1.
- `--dry` / `--graph` / `--summarize` / `--profile` rejected.
- Parser errors prefixed with `vx watch:`.
- **End-to-end re-run**: fixture workspace with one task that
  `cat`s a source file; assertion writes the file mid-watch and
  checks the new content appears in stdout; SIGINT exits cleanly.

## Replacing this module

Plausible extensions, all contained:

- **`vx watch <task1> <task2>`** — multiple tasks. The orchestrator
  already supports multi-positional invocation; just relax the
  validation here.
- **Picker support** — borrow the `pickTask` flow from `cli/run.ts`
  for TTY-with-no-task.
- **Per-project debouncing** — track which project's events arrived
  in the current debounce window and only re-run tasks in those
  projects (`opts.projects = [...affected]`). Useful for very large
  workspaces.
- **Persistent-task hand-off** — track persistent children across
  cycles so a dev server doesn't restart on every file change.
  Schema-extending change; cooperate with `execute-task.ts`.
