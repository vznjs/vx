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
   - For each project a cycle can run (`watchedProjects`: the scope
     plus its transitive dependencies through `buildPackageGraph` with
     the cross-project `dependsOn` edges `taskEdges` collects — what
     `vx run` would run for the same filter), `fs.watch(dir,
{ recursive: true })`. Bun supports recursive watch on every
     platform.
   - For the workspace root, `fs.watch(root, { recursive: false })`
     — only fingerprint files (`pnpm-lock.yaml` / `bun.lock` / …) and
     the workspace config (`vx.workspace.*`, `WORKSPACE_CONFIG_FILENAMES`)
     trigger: the config is no task's input, and it shapes every cycle
     (plugins, `config` stage, concurrency); a cycle re-evaluates it
     since its import is keyed on its bytes. When any task declares
     `inputs.workspaceFiles`, ONE
     `fs.watch(root, { recursive: true })` replaces all of the above,
     and `makeRootEventFilter` keeps the events a key can see — a path
     inside any project's directory, a fingerprint file or the
     workspace config at the root, a
     match of a declared `workspaceFiles` glob (negations not
     consulted: a `!` only narrows, and a spurious event is one
     cache-hit cycle) — and drops the rest of the tree, so a log
     written at the root or a `coverage/` run is not a cycle.
   - For the directory each `<dir>/*` package glob names
     (`memberBaseDirs`), `fs.watch(base, { recursive: false })`: a
     member coming or going there is a cycle, and the cycle's end
     re-reads the workspace (`rediscover`: discovery, the sweep, the
     watched closure) and `rearm`s — new project dirs get an arm that
     proves delivery before the loop goes on, dropped ones are closed,
     the root filter and the ignore filter are rebuilt on the new set.
     Until 2026-09-10 the set was fixed when the loop armed: the next
     cycle ran the new package and every edit inside it was silence
     (`tests/watch-loop.test.ts`, the added-package pair). The scope
     is the one resolved at start; a glob of another shape has no
     such directory.
   - Filter out `node_modules` / `.git` / `.vx` path segments,
     `.tsbuildinfo` / `~` suffixes (editor swap files), the RESOLVED
     cache directory (a relocated `cacheDir` would otherwise re-trigger
     every cycle), and each project's declared outputs
     (`cache.outputs.files`, root-relative `workspaceFiles`) — a cycle
     that writes `dist/` is not an edit, and neither is `dist` itself —
     the directory holding an output tree, `outputContainer`, which the
     clean before a miss prunes and the task re-creates; a literal entry
     is its whole tree, as in the schema (`makeWatchIgnore`, pinned in
     `tests/watch-rules.test.ts`; end to end in
     `tests/watch-loop.test.ts`). The outputs come from the run
     path's staged load (`sweepConfigs` → `loadProjects`), so an
     output a `project` plugin gave a config-less package is ignored
     like a declared one, and a pure config is served from its cached
     evaluation; a config that fails to load drops the sweep to the
     files that do load. The sweep's load is also what
     `watchedProjects` reads the cross edges from, so a watch start is
     the initial run's scoped load plus one sweep, not a third load;
     and the options every cycle re-runs carry no `staged` map — a
     cycle after an edit evaluates live (`tests/staged-once.test.ts`).
   - Catch UNDECLARED writes by settled state — a file's bytes, a
     directory's entry names and sizes, absence — judged one debounce
     window after events stop, and never while a cycle runs (its own
     writes are mid-flight; what landed is judged together once it
     ends, under the label of what arrived). Before 2026-09-10 a
     deletion and a directory passed unconditionally and a mid-run
     judgement saw a half-rebuilt `dist`: `rm -rf dist && tsc` with no
     outputs declared looped forever (`tests/watch-loop.test.ts`, the
     delete-and-recreate pair). The prior text:
   - Catch UNDECLARED writes by content: a task with no `cache` block
     declares no outputs and still writes into its project, and its
     own write re-triggered the cycle without end (the init walkthrough,
     2026-09-04). When the debounce timer fires, every path that fired
     in the window is hashed on its SETTLED bytes and the cycle is
     skipped if none differ from what the loop last hashed; a real
     edit, a deletion or a first sighting passes — so a self-write
     costs one redundant cycle, not an unbounded number. Debounce time,
     not event time: on Linux a shell redirect truncates the file (one
     event, empty) and then writes it (another, full), so consecutive
     events never agree (CI read 9 re-runs where macOS, which coalesces
     the two, read 2). Pinned end to end in `tests/cli.test.ts`.
   - Debounce events `~150ms` after the last one before triggering a
     cycle.
   - Reentrancy guard: while a cycle is running, further events set
     a `pending` flag; the loop drains it after the current cycle
     finishes. Two events can collapse into one re-run.
6. **Exit.** `watchCmd` installs `process.once('SIGINT' | 'SIGTERM')`
   BEFORE the initial run; both abort one `AbortController` whose
   signal every cycle's `run()` carries (`RunOptions.signal`,
   `handleSignals: false`). The in-flight cycle tears its children down
   (SIGTERM, `VX_KILL_GRACE_MS`, SIGKILL) and returns; the loop closes
   its watchers, waits for that cycle, and resolves 0. SIGINT also
   prints `vx watch: stopped`. Until 2026-09-10 the handlers went in
   with the loop, so a SIGTERM during the initial run took Bun's
   default (exit 143) and orphaned the cycle's child
   (`tests/watch-signals.test.ts`).

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
- Doesn't re-decide the watcher shape: a package added under a running
  watch that declares the first `workspaceFiles` input keeps the
  per-project arms until a restart.
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
