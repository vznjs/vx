# `src/cli/watch.ts` — `vx watch` subcommand (and `watch-fs.ts`, `watch-filter.ts`, `watch-set.ts`, `watch-judge.ts`)

## Purpose

Run a task once, then re-run it on every filesystem change in the
projects in scope. The initial run goes through the same orchestrator
path as `vx run`; the watch loop just keeps calling it on debounced
filesystem events.

## Public surface

```ts
export async function watchCmd(args: readonly string[]): Promise<number>

// The loop's parts, exported for the watch suites:
export function watchRefusal(parsed: RunArgs): string | null // the refusal line for a flag watch cannot honour
export function pendingAfterCycle(
  pending: ReadonlyMap<string, string>,
  aborted: boolean,
): [abs: string, label: string] | undefined

// watch-set.ts — what is watched: the projects a cycle can run, what their
// configs declare, the member dirs a package glob can grow:
export async function watchedProjects(
  workspaceRoot,
  allProjects,
  scope,
  load?,
  staged?,
): Promise<ProjectMeta[]>
export interface ConfigSweep {
  workspaceWide: boolean
  workspaceInputs: string[]
  outputs: Map<string, string[]>
  inputs: Map<string, string[][]>
  uncached: Set<string>
  configImports: string[]
  workspaceConfigImports: string[]
  staged: Map<string, ProjectEntry> | null
}
export async function sweepConfigs(projects, workspaceRoot, load?, tasks?): Promise<ConfigSweep> // tasks: judge only what the run can reach
export function memberEntries(base: string): ReadonlySet<string>
export function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean

// watch-judge.ts — which settled paths are changes (state gate, self-write
// window, the 3-cycle notice):
export interface JudgeContext {
  workspaceRoot: string
  armedAt: number
  held(): boolean
  uncached(): ReadonlySet<string>
  fenced?(ownDir: string, abs: string): boolean // in a project nested under ownDir (makeFence)
  existedAtArm?: ReadonlySet<string> // what git listed at the arm; absent when it could not answer
  trackedAtArm?: ReadonlySet<string> // what git tracked at the arm: a held server is never blamed for one
}
export class ChangeJudge {
  readonly pending: Map<string, string> // path → label, what fired since the last judgement
  lastCycle: { start: number; end: number } | undefined // start on the mtime clock (fsClockNow), as armedAt
  constructor(ctx: JudgeContext)
  judge(): string | undefined // the first changed path's label, or none
}

// watch-filter.ts — which events matter, decided over paths alone:
export function isIgnoredWatchPath(rel: string): boolean // node_modules / .git / .vx segments, .tsbuildinfo / ~ suffixes
export function makeWatchIgnore(
  cacheDir,
  outputs?,
  inputs?,
): (base: string, filename: string) => boolean // the above plus the cache dir and every declared output no task reads
export function gitIgnored(workspaceRoot: string, paths: readonly string[]): Set<string> // one `git check-ignore --stdin`
export function gitFiles(
  workspaceRoot: string,
): { listed: Set<string>; tracked: Set<string> } | undefined // one `git ls-files -t` at the arm
export function gitSpeller(root: string): (p: string) => string // a path as git spells it: a symlinked dir below the root resolved
export function makeRootEventFilter(
  workspaceRoot: string,
  projectDirs: readonly string[],
  workspaceInputs: readonly string[],
  claimedRootFiles?: ReadonlySet<string>, // fingerprint plugins' claims, and vx-lock.json under --frozen
  fenced?: (ownDir: string, abs: string) => boolean,
): (filename: string) => boolean
export function makeFence(fenceDirs: readonly string[]): (ownDir: string, abs: string) => boolean // inside a configured project nested under ownDir, its own config aside
export function shapesWatchedSet(filename: string): boolean // a manifest, a config or a fingerprint file: re-read the watched set
export function isWorkspaceFingerprintFile(name: string): boolean
export function isWorkspaceConfigFile(name: string): boolean

// watch-fs.ts — the file-system side, which knows nothing of tasks or cycles:
export const IGNORED_SEGMENTS: string[] // node_modules / .git / .vx
export const WATCH_PROBE = '.vx-watch-probe'
export const WATCH_PROBE_TIMEOUT_MS = 2_000
export interface WatchHandle {
  close(): void
}
export interface ArmedWatcher {
  watcher: fs.FSWatcher
  ready: Promise<boolean> // true once the watcher reported the probe, false on timeout
}
export function pollWatcher(
  dir: string,
  recursive: boolean,
  onEvent: (filename: string) => void,
  intervalMs?: number,
  skipDir?: (rel: string) => boolean,
): WatchHandle
export function armWatcher(
  dir: string,
  recursive: boolean,
  onEvent: (filename: string) => void,
  timeoutMs?: number,
): ArmedWatcher
export function modifiedBefore(abs: string, t: number): boolean
export function fsClockNow(dir: string): number
export const CLOSED: WatchHandle // watches nothing: a dropped slot, an arm not made
export class WatcherPool {
  constructor(skip: (dir: string, rel: string) => boolean) // what the poller leaves unsampled
  arm(dir: string, recursive: boolean, onEvent: (filename: string) => void): WatchHandle // OS watcher, poller on no proof, an OS watch limit or VX_WATCH_POLL
  proved(): Promise<void> // every arm so far proved delivery or fell back
  closeAll(): void
}
```

`cli/index.ts` dispatches `vx watch <...>` here. Returns the exit code
(`0` on clean Ctrl+C; `1` on parser / scope error). `armWatcher` proves
delivery before the loop trusts a watcher (a probe file the watcher
must report within the timeout); `pollWatcher` is the fallback that
re-walks the tree when the platform's watcher never does, or when the
OS watch limit refuses one (`ENOSPC` / `EMFILE`, E-49). On Linux a
recursive arm is one non-recursive watch per directory that never enters
`node_modules`, `.git` or `.vx` (whose events the loop drops anyway):
this repo's root arm went from 4,657 inotify watches to 435 and its arm
from 75 to 43 ms (min of 6, interleaved); a directory that appears is
watched and what it already holds reported (`watch-tree-linux.test.ts`).

## Flag surface

`watchCmd` reuses `cli/run.ts:parseRunArgs` so every `vx run` flag
that makes sense for a loop is supported. Rejected with exit 1:

| Flag                        | Reason                                         |
| --------------------------- | ---------------------------------------------- |
| `--dry` / `--graph`         | They skip execution; nothing to watch.         |
| `--summarize` / `--profile` | Would overwrite their target file every cycle. |
| (no task name)              | Watch needs an explicit task — no picker.      |

Everything else (`--all`, `--filter`, `--affected`, `--concurrency`,
`--no-cache`, `--exclude-dependencies`, forwarded `--` args) passes
through unchanged. `--report` / `--report-file` / `--verbosity` above 0
are refused too: they format one run's result.

## Algorithm

1. `parseRunArgs` + validate the watch-mode rejections above.
2. `cli/run.ts:resolveRunOptions(parsed, cwd, tasks)` → `RunOptions`.
   Same scope resolution as `vx run`.
3. Enumerate projects in the resolved scope via `discoverCliProjects`
   (discovery plus the plugins' `discover` stage, as `vx run` lists
   them): `opts.projects` (every project when undefined) plus each
   `pkg#task`'s project, or only those when every task is anchored
   (`tests/watch-anchored-scope.test.ts`). Empty scope → exit 1, judged
   after the initial run so an unknown `pkg` gets the run's refusal.
4. **Initial run.** Print `vx watch: initial run...`; call
   `orchestrator.run(opts)`. One that ran nothing and failed (a task
   no project declares) exits 1. Then `opts.affected` and
   `opts.selectedOutright` are dropped: the `--affected` diff is the
   tree at start, so a later cycle runs the requested task across the
   scope and the keys decide (`tests/watch-affected.test.ts`).
5. **Watch loop** (`runWatchLoop`):
   - For each project a cycle can run (`watchedProjects`: the scope
     plus its transitive dependencies through `buildPackageGraph` with
     the cross-project `dependsOn` edges `taskEdges` collects — what
     `vx run` would run for the same filter), `fs.watch(dir,
{ recursive: true })`. Bun supports recursive watch on every
     platform. A path inside a project nested under the
     watched one is dropped (`makeFence`): its key leaves that file
     out (`computeNestedProjectDirs`), so a root project ran a cycle
     for every edit in a nested one (X-42). The fences are every
     project, config or not (X-57). The nested project's own config
     still passes, since it may give the project tasks.
   - For the workspace root, `fs.watch(root, { recursive: false })`
     — only fingerprint files (`pnpm-lock.yaml` / `bun.lock` / …) and
     the workspace config (`vx.workspace.*`, `WORKSPACE_CONFIG_FILENAMES`)
     trigger: the config is no task's input, and it shapes every cycle
     (plugins, `config` stage, concurrency); a cycle re-evaluates it
     since its import is keyed on its bytes. When any task declares
     `inputs.workspaceFiles`, ONE
     `fs.watch(root, { recursive: true })` replaces all of the above,
     and `makeRootEventFilter` keeps the events a key can see — a path
     inside any watched project's directory and outside the projects
     fenced off under it, a fingerprint file or the
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
     (`tests/watch-loop-members.test.ts`, the added-package pair). A
     cycle that fails re-reads too: a package added with a config that
     does not load yet was left unwatched, and the fix to that config
     ran nothing (WD-26). The scope
     is the one resolved at start; a glob of another shape has no
     such directory.
   - The same re-read follows a cycle started by a file that shapes
     the watched set (`shapesWatchedSet`): a `package.json` (a
     dependency added under `--filter` widens the closure; the root's
     `workspaces`, like `pnpm-workspace.yaml`, is the glob list, and the
     re-read takes its bases too, so a glob added there is watched from
     the cycle it triggers, item 1018), a project
     config (a task that starts or stops declaring `workspaceFiles`
     swaps the arm between per-project and root, `dropMode` /
     `armMode`) or the workspace config. And a directory under a
     member base with no package in it yet gets a non-recursive arm
     of its own (`armPending`): the base's watcher never hears the
     `package.json` written inside it, so a directory made before its
     manifest stayed unwatched for good. Until item 891 each of these
     waited for a restart (the three item-891 rows).
   - Filter out `node_modules` / `.git` / `.vx` path segments,
     `.tsbuildinfo` / `~` suffixes (editor swap files), the RESOLVED
     cache directory (a relocated `cacheDir` would otherwise re-trigger
     every cycle), and each project's declared outputs
     (`cache.outputs.files`, root-relative `workspaceFiles`) — a cycle
     that writes `dist/` is not an edit, and neither is `dist` itself;
     a path a task the watch reaches declares as an input is never
     dropped, whoever declares it as an output (item 946) — the
     requested tasks and the names their `dependsOn` reaches, in any
     project; a name pattern keeps every task (`watch-set.ts`; until
     the fix a `lint` reading `**/*` took `build`'s `dist/` write for
     its input and re-ran `vx watch build` on every save), and a task's own outputs (and
     their directory) are no input of it, as its key reads them, so a
     `turbo()` task reading `**/*` does not re-run on its own `dist/` —
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
     outputs declared looped forever (`tests/watch-loop-uncached.test.ts`,
     the delete-and-recreate pair). The prior text:
   - Catch UNDECLARED writes by content: a task with no `cache` block
     declares no outputs and still writes into its project, and its
     own write re-triggered the cycle without end (the init walkthrough,
     2026-09-04). When the debounce timer fires, every path that fired
     in the window is hashed on its SETTLED bytes and the cycle is
     skipped if none differ from what the loop last hashed; a real
     edit, a deletion or a first sighting modified after the arm
     passes (`modifiedBefore`: the initial run's own writes arrive
     after the arm on macOS, and their mtime and ctime both predate it;
     the ctime is what catches a file moved in with an old mtime, item 945) — so a self-write
     costs one redundant cycle, not an unbounded number. Debounce time,
     not event time: on Linux a shell redirect truncates the file (one
     event, empty) and then writes it (another, full), so consecutive
     events never agree (CI read 9 re-runs where macOS, which coalesces
     the two, read 2). Pinned end to end in `tests/cli.test.ts`.
   - Debounce events `~150ms` after the last one before triggering a
     cycle, and at most 1 s after the first: a writer that never pauses
     (a dev server's log) reset the timer forever and held every edit
     back (WD-1).
   - Reentrancy guard: while a cycle is running, further events set
     a `pending` flag; the loop drains it after the current cycle
     finishes. Two events can collapse into one re-run.
6. **Exit.** `watchCmd` installs `process.once` handlers for SIGINT,
   SIGTERM and SIGHUP BEFORE the initial run; each aborts one
   `AbortController`, with the signal's name as the reason, whose
   signal every cycle's `run()` carries (`RunOptions.signal`, `handleSignals: false`). The
   in-flight cycle tears its children down (the received signal, a
   SIGHUP as SIGTERM; `VX_KILL_GRACE_MS`; SIGKILL) and returns; the loop
   closes its watchers, waits for that cycle, stops the persistent tasks
   it holds with the same signal, and resolves; watch exits 0. SIGINT then
   prints `vx watch: stopped`, the last line. Until 2026-09-10 the handlers went in
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

## Persistent tasks across cycles

Watch mode re-invokes `orchestrator.run` per cycle with
`holdPersistent: true`, so the requested persistent tasks a cycle
started, and the persistent tasks they depend on, are handed back
running (`RunSummary.persistent`) instead of being stopped when its
graph ends. The loop holds them while it idles; the next cycle calls
their `stop()` before its run, and the stop path calls it after the
in-flight cycle returns. Any other persistent task is still stopped at
the end of its cycle, as under `vx run`. So a `persistent` dev server is up between cycles and
re-spawned by each one. Until 2026-09-24 the server was stopped at the
END of each cycle and was dead whenever watch sat idle
(`tests/watch-loop.test.ts` › "the dev server stays up while watch
idles and is replaced when the next cycle starts").

For dev-server workflows, use the dev tool's own watch (`vite`,
`tsc -b -w`, `bun --watch`) rather than `vx watch`. `vx watch` is
for `vx watch test` / `vx watch lint` / `vx watch build` —
non-persistent tasks where each cycle should re-run cleanly.

## What this does NOT do

- Start a cycle on a path git ignores: `gitIgnored` asks
  `git check-ignore --stdin` once per judgement (never per event), and a
  path no cache key can see starts nothing — the pid file or log a dev
  server rewrites on every start made the loop re-run itself forever
  (item 237). A tracked file matching a pattern is not ignored, by git's
  rule; outside a repository nothing is. A path inside a submodule makes
  git refuse the batch; that path is skipped and the rest asked again
  (`watch-ignore-submodule.test.ts`). A project reached through a symlink
  (`packages/x -> ../shared/x`) is watched at the link, which git refuses
  ("beyond a symbolic link"), so each path is asked, and looked up in
  `gitFiles`, at its real place (`gitSpeller`).
- Settle a file the task rewrites with DIFFERENT bytes every run when
  it is neither ignored nor declared: the loop re-runs on it, and after
  three cycles in a row started by the same path after a run, watch
  names it and the remedy once (`watch-loop-selfwrite.test.ts`). A
  held server is blamed only for a file git did not track at the arm
  (`gitFiles`' `tracked`; `watch-server-blame.test.ts`).
- Start a cycle on a file born and gone since the arm (vim's `4913`
  write probe): `gitFiles` lists what existed at the arm, and a gone path
  it did not list was never read by a key (`watch-transient-file.test.ts`).
  Git lists a nested repository (a submodule, a vendored clone) as one
  entry, so a gone path under one is still a deletion.

- Doesn't accept the interactive picker — task name is required.
- Doesn't filter events through declared input globs.
- Doesn't dedupe events by project — every file change triggers a
  re-run of the user's specified task across the entire scope.
- Doesn't carry a persistent task through a cycle: it stays up while
  watch idles, and the next cycle stops and re-spawns it.
- Re-key a cycle when a task rewrites a lockfile _during_ it: the keys
  are taken once per cycle. The run itself notices (item 750,
  [`fingerprint-watch.md`](./fingerprint-watch.md)): nothing keyed
  before the rewrite is restored or saved, and the rewrite is an event
  the next cycle re-keys on. A rewrite to the same bytes starts that one
  cycle and settles (probed 2026-09-25, item 763).

## Tests

`tests/cli.test.ts`:

- `vx watch` with no task → exits 1.
- `--dry` / `--graph` / `--summarize` / `--profile` rejected.
- Parser errors prefixed with `vx watch:`.
- **End-to-end re-run**: fixture workspace with one task that
  `cat`s a source file; assertion writes the file mid-watch and
  checks the new content appears in stdout; SIGINT exits cleanly.

The loop's own suites: `tests/watch-rules.test.ts` (the ignore rules
and the root event filter), `tests/watch-loop.test.ts` (cycles end to
end), `tests/watch-loop-members.test.ts` (a package coming or going),
`tests/watch-affected.test.ts` (`--affected` past the first cycle),
`tests/watch-anchored-scope.test.ts` (what `pkg#task` watches),
`tests/watch-loop-uncached.test.ts` (undeclared writes judged by
settled state), `tests/watch-loop-selfwrite.test.ts` (a file rewritten
with different bytes every run), `tests/watch-signals.test.ts` (SIGINT
and SIGTERM during the initial run and a cycle; a Ctrl-C reaches the
cycle's task and the held dev server as SIGINT), and
`tests/staged-once.test.ts` (a cycle evaluates live).

## Replacing this module

Plausible extensions, all contained:

- **Picker support** — borrow the `pickTask` flow from `cli/select.ts`
  for TTY-with-no-task.
- **Per-project debouncing** — track which project's events arrived
  in the current debounce window and only re-run tasks in those
  projects (`opts.projects = [...affected]`). Useful for very large
  workspaces.
- **Persistent-task hand-off** — track persistent children across
  cycles so a dev server doesn't restart on every file change.
  Schema-extending change; cooperate with `execute-task.ts`.
