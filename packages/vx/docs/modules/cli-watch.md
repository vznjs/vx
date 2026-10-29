# `src/cli/watch.ts` — `vx watch` subcommand (and `watch-fs.ts`, `watch-filter.ts`, `watch-set.ts`, `watch-judge.ts`, `watch-cycle.ts`)

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

// watch-set.ts — what is watched: the projects a cycle can run and what
// their configs declare:
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
  namedIgnored: string[]
  configImports: string[]
  workspaceConfigImports: string[]
  staged: Map<string, ProjectEntry> | null
}
export async function sweepConfigs(projects, workspaceRoot, load?, tasks?): Promise<ConfigSweep> // tasks: judge only what the run can reach

// watch-judge.ts — which settled paths are changes (state gate, self-write
// window, the 3-cycle notice):
export interface JudgeContext {
  workspaceRoot: string
  armedAt: number
  held(): boolean
  uncached(): ReadonlySet<string>
  namedIgnored?(): readonly string[] // paths inputs name outright: a git-ignored file at or under one is an edit
  fenced?(ownDir: string, abs: string): boolean // in a project nested under ownDir (makeFence)
  existedAtArm?: ReadonlySet<string> // what git listed at the arm; absent when it could not answer
  trackedAtArm?: ReadonlySet<string> // what git tracked at the arm: a held server is never blamed for one
}
export class ChangeJudge {
  readonly pending: Map<string, string> // path → label, what fired since the last judgement
  lastCycle: { start: number; end: number } | undefined // start on the mtime clock (fsClockNow), as armedAt
  constructor(ctx: JudgeContext)
  seed(abs: string): void // record a path's state now, if unjudged: a link armed for its target
  judge(): string | undefined // the first changed path's label, or none
}

// watch-cycle.ts — one cycle's run, stoppable while it waits on readiness alone:
export interface WatchCycle {
  readonly opts: RunOptions // the cycle's own bus and stop, footer: false
  waitsOnReadiness(): boolean // every task in flight is a persistent one not yet ready
  interrupt(): void // stop the run as a SIGTERM would; watch keeps going
  readonly interrupted: boolean
  readonly tasks: number | undefined // the run's task count, once it has started
}
export function watchCycle(opts: RunOptions, stop: AbortSignal, onWaiting: () => void): WatchCycle

// watch-filter.ts — which events matter, decided over paths alone:
export function isIgnoredWatchPath(rel: string): boolean // node_modules / .git / .vx/cache / .vx/tmp segments, ~ suffix
export function makeWatchIgnore(
  cacheDir,
  outputs?,
  inputs?,
  tracked?, // git's tracked files at the arm: never an output, so an edit there counts
): (base: string, filename: string) => boolean // the above plus the cache dir and every declared output no task reads
export function gitIgnored(workspaceRoot: string, paths: readonly string[]): Set<string> // one `git check-ignore --stdin`
export function gitFiles(
  workspaceRoot: string,
): { listed: Set<string>; tracked: Set<string>; links: Set<string> } | undefined // one `git ls-files -t -s` at the arm; links: the symlinks, whose targets watch arms
export function gitSpeller(root: string): (p: string) => string // a path as git spells it: a symlinked dir below the root resolved
export function makeRootEventFilter(
  workspaceRoot: string,
  projectDirs: readonly string[],
  workspaceInputs: readonly string[],
  claimedRootFiles?: ReadonlySet<string>, // fingerprint plugins' claims and .vx/projects.lock.json
  fenced?: (ownDir: string, abs: string) => boolean,
): (filename: string) => boolean
export function makeFence(fenceDirs: readonly string[]): (ownDir: string, abs: string) => boolean // inside a configured project nested under ownDir, its own config aside
export function shapesWatchedSet(filename: string): boolean // a project or workspace config: re-read the watched set
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
  closeAll(): void // and every arm or fallback after it is CLOSED
}
```

`cli/index.ts` dispatches `vx watch <...>` here. Returns the exit code
(`0` on clean Ctrl+C; `1` on parser / scope error). `armWatcher` proves
delivery before the loop trusts a watcher (a probe file the watcher
must report within the timeout); `pollWatcher` is the fallback that
re-walks the tree when the platform's watcher never does, or when the
OS watch limit refuses one (`ENOSPC` / `EMFILE`, E-49). On Linux a
recursive arm is one non-recursive watch per directory that never enters
`node_modules`, `.git` or `.vx/cache` (whose events the loop drops anyway):
this repo's root arm went from 4,657 inotify watches to 435 and its arm
from 75 to 43 ms (min of 6, interleaved); a directory that appears is
watched and what it already holds reported (`watch-tree-linux.test.ts`).

## Flag surface

`watchCmd` reuses `cli/run.ts:parseRunArgs` so every `vx run` flag
that makes sense for a loop is supported. Rejected with exit 1:

| Flag           | Reason                                       |
| -------------- | -------------------------------------------- |
| `--dry`        | It skips execution; nothing to watch.        |
| `--profile`    | Would overwrite its target file every cycle. |
| (no task name) | Watch needs an explicit task — no picker.    |

Everything else (`--all`, `--filter`, `--affected`, `--concurrency`,
`--no-cache`, `--exclude-dependencies`, forwarded `--` args) passes
through unchanged. `--verbosity` above 0 and `--format json` are refused
too: they format one run's result.

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
4. **Initial run.** Call `orchestrator.run(opts)`; every cycle runs
   with `footer: false` (`watch-cycle.ts`), so a run is its task rows.
   Once armed the loop prints `watching N projects · M tasks`, M being
   the initial run's task count, and again after each re-arm. One that ran nothing and failed (a task
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
   - On macOS, ONE `fs.watch(root, { recursive: true })` stands for
     the per-project arms, the root arm and the `.vx/` arm below:
     `streamEvent` hands each event to every watched project whose real
     directory holds it and to the root and `.vx/` listeners, each
     deciding as its own arm did. Each FSEvents stream went live slower
     than the one before: per project, 751 of 3000 missed the 2 s proof
     on a macos-latest runner and polled, a full core at idle; one root
     stream went live in 8 ms (`tests/watch-one-stream.test.ts`). A
     project whose real directory is outside the root keeps its own arm;
     `--poll` keeps per-project walks.
   - For the workspace root, `fs.watch(root, { recursive: false })`
     — only a file a plugin claims (a lockfile, an install setting),
     `.vx/projects.lock.json`, `.gitignore` and the workspace config (`.vx/workspace.*`, `WORKSPACE_CONFIG_FILENAMES`)
     trigger: the config is no task's input, and it shapes every cycle
     (plugins, `config` stage, concurrency); a cycle re-evaluates it
     since its import is keyed on its bytes. When any task declares
     `inputs.workspaceFiles`, ONE
     `fs.watch(root, { recursive: true })` replaces all of the above,
     and `makeRootEventFilter` keeps the events a key can see — a path
     inside any watched project's directory and outside the projects
     fenced off under it, a claimed file or the workspace config at the
     root, a
     match of a declared `workspaceFiles` glob (negations not
     consulted: a `!` only narrows, and a spurious event is one
     cache-hit cycle) — and drops the rest of the tree, so a log
     written at the root or a `coverage/` run is not a cycle.
   - The projects are the lock's (`vx lock` finds them; a watch
     never walks for configs), so `.vx/projects.lock.json` is the
     event that changes the set: the cycle it starts re-reads the
     workspace before the run keys anything (`rediscover`: discovery,
     the sweep, the watched closure) and `rearm`s — new project dirs
     get an arm that proves delivery before the loop goes on, dropped
     ones are closed, the root filter and the ignore filter are rebuilt
     on the new set. Armed only after the run, an edit in the new
     project while its first cycle ran fell in the gap (X-138). A
     config added and not yet locked is no project and no event; until
     2026-09-10 the set was fixed when the loop armed, and every edit
     in a new project was silence (`tests/watch-loop-members.test.ts`).
     With no lock at start the first cycle fails naming `vx lock` and
     the loop watches for the lock.
   - A lock whose stat moved since a cycle began is that cycle's
     event too, queued after the run: a re-lock landing mid-cycle had
     its event on the way to a watcher the post-run `rearm` closed
     (FSEvents' latency, a poller's tick), and the new lock ran
     nothing until the next edit (macOS CI, 2026-10-23).
   - The same re-read follows a cycle started by a file that shapes
     the watched set (`shapesWatchedSet`): a project config (a task
     that starts or stops declaring `workspaceFiles` swaps the arm
     between per-project and root, `dropMode` / `armMode`), the
     workspace config, or a file a plugin claims (a lockfile plugin's
     `discover` names and edges come from it, so a dependency added
     under `--filter` widens the closure). Until item 891 each of
     these waited for a restart.
   - A project directory, and a directory a config imports from, is
     also watched from its nearest directory that exists, for the next
     name on the way down (`armAncestors`): an inotify watch holds an
     inode, so a directory removed and made again (`rm -rf packages &&
git checkout packages`) was no event to its own arm, nor to the
     root's (`tests/watch-recreated-dirs.test.ts`). Every directory
     above it up to the root is watched for the next name as well:
     FSEvents reports no child of a watched directory removed with it,
     so on macOS the parent's arm alone never heard `packages/` go. A
     project's parent's `.gitignore` is heard there too, as the root's is.
     A project directory still the inode these arms first saw is no
     change there (`heldDirs`): its own arm judges what is in it, and a
     task's write at its top level started a second cycle on macOS
     (`tests/watch-project-dir-write.test.ts`).
   - Filter out `node_modules` / `.git` / `.vx/cache` path segments,
     `.vx/tmp` (restore staging), the `~` suffix (editor swap files), the RESOLVED
     cache directory (a relocated `cache.dir` would otherwise re-trigger
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
     output a `project` plugin gave a config-less project is ignored
     like a declared one, and each config is read from `.vx/projects.lock.json`;
     a config that fails to load drops the sweep to the
     files that do load. The sweep's load is also what
     `watchedProjects` reads the cross edges from, so a watch start is
     the initial run's scoped load plus one sweep, not a third load;
     and the options every cycle re-runs carry no `staged` map — a
     cycle reloads from the lock afresh (`tests/staged-once.test.ts`).
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
   SIGHUP as SIGTERM; a 2 s grace; SIGKILL) and returns; the loop
   closes its watchers, waits for that cycle, stops the persistent tasks
   it holds with the same signal, and resolves; watch exits 0. The pool
   stays closed: a cycle still re-arming arms nothing, and a watcher the
   close caught before its proof gets no poller
   (`tests/watch-pool-close.test.ts`). SIGINT then
   prints `vx watch: stopped`, the last line. Until 2026-09-10 the handlers went in
   with the loop, so a SIGTERM during the initial run took Bun's
   default (exit 143) and orphaned the cycle's child
   (`tests/watch-signals.test.ts`).

## Why not filter by `inputs.files`

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
graph ends. The loop holds them while it idles and hands them to the
next cycle as `RunOptions.keep`: a server still up whose task that
cycle starts again, with the same resolved config and forwarded args,
stays up and reads ready at once (`0ms running`), and what it writes
reaches the new cycle's renderer. The rest of the graph re-runs as
usual: `vx watch dev` over `dev: { dependsOn: ['^build'] }` rebuilds
the libraries an edit reached, and the dev tool's own reload takes it
from there. A server whose config changed, or that died, is stopped
before the cycle's graph and started again; a stop that lands while it
is going ends the cycle there, having run nothing (WD-22). One the
cycle never reaches (a dependency failed) is stopped after it, by the
hand-back it came from. Any other persistent task is still stopped at
the end of its cycle, as under `vx run`. Until 2026-10-08 every cycle
restarted the server, and until 2026-09-24 it was stopped at the END of
each cycle and was dead whenever watch sat idle
(`tests/watch-loop.test.ts` › "the dev server stays up across cycles
and is replaced when its config changes").

A cycle whose server never matches `readyWhen` and has no
`exec.timeout` never ends. An edit judged a change while every task in
flight is such a server stops the cycle (SIGTERM, grace, SIGKILL, as
Ctrl-C does) and starts the next; a cycle running any other task is
never stopped (`tests/watch-ready-interrupt.test.ts`, WD-15).

`vx watch dev` is the dev-server workflow: the server is started
once and the tasks it depends on re-run on each edit. A one-shot task
(`vx watch build`, `vx watch test`) re-runs itself and what it depends
on, as the cache keys decide.

## What this does NOT do

- Start a cycle on a path git ignores: `gitIgnored` asks
  `git check-ignore --stdin` once per judgement (never per event), and a
  path no cache key can see starts nothing — the pid file or log a dev
  server rewrites on every start made the loop re-run itself forever
  (item 237). A tracked file matching a pattern is not ignored, by git's
  rule; outside a repository nothing is. A path inside a submodule makes
  git refuse the batch; that path is skipped and the rest asked again
  (`watch-ignore-submodule.test.ts`). A project reached through a symlink
  out of the root (`packages/x -> ../../shared/x`; one inside it is the
  project at its real directory) is watched at the link, which git refuses
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
- Restart a server for an edit to its own sources: the dev tool
  reloads those itself. Only its config, or its death, restarts it.
- Re-key a cycle when a task rewrites a lockfile _during_ it: the keys
  are taken once per cycle. The run itself notices (item 750,
  [`fingerprint-watch.md`](./fingerprint-watch.md)): nothing keyed
  before the rewrite is restored or saved, and the rewrite is an event
  the next cycle re-keys on. A rewrite to the same bytes starts that one
  cycle and settles (probed 2026-09-25, item 763).

## Tests

`tests/cli.test.ts`:

- `vx watch` with no task → exits 1.
- `--dry` / `--profile` / `--verbosity` rejected.
- Parser errors prefixed with `vx watch:`.
- **End-to-end re-run**: fixture workspace with one task that
  `cat`s a source file; assertion writes the file mid-watch and
  checks the new content appears in stdout; SIGINT exits cleanly.

The loop's own suites: `tests/watch-rules.test.ts` (the ignore rules
and the root event filter), `tests/watch-loop.test.ts` (cycles end to
end), `tests/watch-loop-members.test.ts` (a project the lock adds or drops),
`tests/watch-affected.test.ts` (`--affected` past the first cycle),
`tests/watch-anchored-scope.test.ts` (what `pkg#task` watches),
`tests/watch-loop-uncached.test.ts` (undeclared writes judged by
settled state), `tests/watch-loop-selfwrite.test.ts` (a file rewritten
with different bytes every run), `tests/watch-signals.test.ts` (SIGINT
and SIGTERM during the initial run and a cycle; a Ctrl-C reaches the
cycle's task and the held dev server as SIGINT), and
`tests/staged-once.test.ts` (a cycle loads afresh).

## Replacing this module

Plausible extensions, all contained:

- **Picker support** — borrow the `pickTask` flow from `cli/select.ts`
  for TTY-with-no-task.
- **Per-project debouncing** — track which project's events arrived
  in the current debounce window and only re-run tasks in those
  projects (`opts.projects = [...affected]`). Useful for very large
  workspaces.
