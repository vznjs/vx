# `src/cli/` — the command line

## `src/cli/index.ts` — top-level command dispatcher

### Purpose

Argv → subcommand dispatch; the cli module's contract. Hand-rolled
(no commander / yargs / cac) to keep the dependency tree slim and
behaviour trivially predictable. Each subcommand handler lives in a
sibling `src/cli/<name>.ts`.

### Public surface

```ts
export async function run(argv: readonly string[]): Promise<number>
export { registerCoreAlias } from './core-alias.js'
```

Every verb's module, `run` included, and the plugin-verb lookup are
imported when invoked: each pulls in the orchestrator and the workspace
loader. `vx --version` loads the dispatcher alone, 24 ms against 58 ms
when this file re-exported the verbs' parsers (min of 5, 2026-09-30);
`bin.ts` now answers a lone `--version` / `version` from `version.ts`
without the dispatcher or the util barrel: 16.4 ms against 20.1, where
Bun runs a one-line file in 13.7 (min of 15, interleaved, 2026-10-01).
Tests import a parser from its own file (`cli/run.ts`'s `parseRunArgs`).

`run(argv)` returns the exit code. `bin.ts` sets `process.exitCode` to
it and lets the event loop drain — no `process.exit`, no `stdout.end`:
Bun drops what a pipe has not yet taken when `process.exit` follows a
large write (2026-09-15), and on 1.3.11 `stdout.end`'s callback fired
early too (2026-09-20). A verb never calls `process.exit` itself.

### Subcommands

| Argv first token                     | Handler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`                                | `cli/run.ts:runCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `watch`                              | `cli/watch.ts:watchCmd(rest)`; the OS watcher, its poller fallback and the mtime clock are `cli/watch-fs.ts`, the event filters `cli/watch-filter.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cache`                              | `cli/cache.ts:cacheCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `lock`                               | `cli/lock.ts:lockCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `init`                               | `cli/init.ts:initCmd(rest)` — the scripts mapping through the migration seam; scaffolds an empty workspace instead of refusing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `upgrade`                            | `cli/upgrade.ts:upgradeCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `show`                               | `cli/show.ts:showCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `info`                               | `cli/info.ts:infoCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `why`                                | `cli/why.ts:whyCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `last`                               | `cli/last.ts:lastCmd(rest)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `completions`                        | `cli/completions.ts:completionsCmd(rest, pluginVerbs)` — a bash / zsh / fish script over the verb table and each verb's help cut                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `help` / `--help` / `-h` / _(empty)_ | `cli/help.ts:printHelp(pluginVerbs)` — plugin verbs listed with their plugin; _(empty)_ outside a workspace prints the no-workspace refusal and exits 1; `help <name>` for no verb is refused as `vx <name>` is                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `version` / `--version`              | `process.stdout.write('vx <VERSION>\n')`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| anything else                        | `cli/plugin-commands.ts:resolvePluginCommand` — the workspace's plugins are asked, in order, for a `commands` entry; a verb resolving a non-integer, or throwing anything but a `UserError`, fails naming the plugin; nothing found → a moved or Nx verb's pointer (`run-many`, `affected`), else a task a project declares named with its `vx run` (`cli/task-verb.ts`), else `unknown command`, a near-miss hint when one exists, why plugin verbs could not be looked up when the workspace file failed to load, and a `vx help` pointer, plus a second line naming where a verb can come from when neither hint applies; exit 1 |

Per-subcommand parsers / handlers carry their own argv-walk loops.
See:

- [`cli.md`](#srcclirunts--vx-run-parser--handler) — `vx run`
- [`cli.md`](#srccliwatchts--vx-watch-subcommand-and-watch-fsts-watch-filterts-watch-setts-watch-judgets-watch-cyclets) — `vx watch`
- [`cli.md`](#srcclicachets--vx-cache-clean) — `vx cache clean`
- [`cli.md`](#srcclihelpts--help-text) — `vx help`
- [`cli.md`](#srccliformatts--shared-formatters) — shared formatters
- `vx lock`, `vx init`, `vx show` / `vx info`, `vx why`,
  `vx last`, `vx completions`, `vx upgrade`: documented in
  [`../cli.md`](../cli.md); no separate module doc.

### Workspace loading

Every verb that opens the cache or lists plugin verbs resolves the
workspace through `cli/workspace-config.ts:loadCliWorkspace`: the
workspace config with the plugin `config` stage applied, the plugin
list, and the cache dir derived from the staged config. The stage
shapes `cache.dir`, so a verb reading the file raw would open a
directory the run never used. Plugin warnings go to stderr. Each verb
runs the stage once: a reading verb's helpers share one `verbWorkspace`
(the stage, then the discovery over it), a discovery keeps the workspace
it loaded (`workspaceOfDiscovery`), and a run handed that discovery
reuses it (`keepDiscoveryWorkspace`, projects.md). A plugin
verb the dispatcher could never reach — one naming a core verb, or one
plugins of two packages both declare — is refused by the workspace VALIDATOR
(`validateWorkspace`, against `util/verbs.ts`), so a run refuses it
exactly as a reading verb or the plugin-verb lookup does.

### What this does NOT do

- No global flags (no `--debug`, no `--quiet`, no `--color`). Color
  is gated by env (`NO_COLOR` / `FORCE_COLOR` / TTY).
- No completion installed for you: `vx completions bash|zsh|fish`
  prints the script; sourcing it is the user's.
- No subcommand aliases beyond the help / version sugar.
- No service commands — there is no daemon, server or worker verb in
  core and no separate service package (removed 2026-09-02). A plugin
  that wants a verb adds it through `commands`.

### Tests

`tests/cli.test.ts` covers the dispatcher table — help, version,
unknown subcommand. Per-subcommand parser tests
live alongside.

### Replacing this module

To swap in a parser library, keep `run(argv): Promise<number>` and
keep each verb's parser in its own file (tests import them
directly). Everything else can change.

## `src/cli/run.ts` — `vx run` parser + handler

### Purpose

Parse `vx run`'s argv, resolve the run's options, and invoke the
orchestrator. Handles both real runs (`orchestrator.run`) and planning
paths (`planRun` → text/json/DOT formatters). What a run is asked to
run — the `--filter` resolution, `--affected`'s orphan-path owners, the
cwd project and the interactive picker — is `src/cli/select.ts`
(split 2026-09-09, pure code motion), which run.ts calls from
`resolveRunOptions`; every read of the workspace there goes through
the staged load (`loadCliProjects`), so the selection is the run's —
and when the selection had to stage every config (a filter that walks
the graph), that load travels into the run as `RunHandoff.staged`, so
the configs load once per run. A filter pass also hands its discovered
projects over (`RunHandoff.discovered`), so the workspace is listed once.

### Public surface

```ts
export interface RunArgs {
  continueMode?: ContinueMode // --continue[=never|deps-ok|always]
  tasks: string[] // bare + `pkg#task` positionals
  filters: string[] // raw --filter values
  all: boolean
  excludeDependencies: 'all' | string[]
  settings: Record<string, unknown> // each setting flag by path, parsed by its kind (`run.timeout` → ms)
  cache: CachePolicy // resolved from --cache-policy / VX_CACHE_POLICY / --no-cache / --force (default all-on)
  cacheFlags?: CacheFlags // no spec named: --no-cache / --force, applied over the workspace's cache.policy
  remoteRequested?: '--cache-policy' | 'VX_CACHE_POLICY' // which spec named a remote axis
  cacheDir: string | undefined // --cache-dir
  poll?: true // vx watch --poll (watch.poll)
  forwardArgs: string[] // everything after `--`
  verbosity: number
  dry: 'pretty' | 'json' | undefined
  profile: string | undefined // 'profile.json' default
  affected: string | undefined // '' = default base; else ref
  spaced?: { flag: '--affected' | '--profile'; value: string } // the word after a bare one, read as a task
  error?: string // parser-error message
}

export function parseRunArgs(args: readonly string[], verb: 'run' | 'watch' = 'run'): RunArgs
export function detectFlow(
  parsed: Pick<RunArgs, 'all' | 'filters' | 'affected'>,
): 'focused' | 'broad'
export async function runCmd(args: readonly string[]): Promise<number>

/**
 * Shared with `cli/watch.ts`: turn parsed args + cwd + task list into
 * the orchestrator's `RunOptions`. Returns the options, an error
 * message (caller prefixes with subcommand name), or `nothingSelected`
 * — the selection resolved to zero projects (nothing changed since the
 * `--affected` base), a clean exit, not a failure. Doesn't
 * handle the interactive picker — `runCmd` does that first, then
 * passes the resolved task list in.
 */
export async function resolveRunOptions(
  parsed: RunArgs,
  cwd: string,
  tasks: readonly string[],
  verb: 'run' | 'watch' = 'run',
  scopeOut?: { affectedBase?: string }, // learns the ref --affected diffed from
): Promise<RunOptions | { error: string } | { nothingSelected: string }>
```

### Parser

`parseRunArgs(argv, verb)` walks the array once (`verb` names whose help a
refusal points at: `vx watch` reads the same flags, M-58):

1. Split on the first `--` — everything after is `forwardArgs`.
2. Loop the prefix: recognize each flag form. Optional-value flags
   (`--dry`, `--profile`, `--affected`,
   `--exclude-dependencies`) accept either the bare form or `=<value>`.
3. A setting's flag (`src/settings.ts` names each one, its verb and its
   kind) parses by that kind into `settings` at the setting's path.
4. Unknown flags + missing values + invalid integers → returned via
   `RunArgs.error`. The handler short-circuits to exit 1. An unknown
   flag names the nearest flag `vx run` accepts (`flagHint('run', arg)`
   in `help.ts`, which every verb's refusal shares; it reads the help
   text, so there is no second list to drift).
5. Mutually-exclusive combinations checked at the end:
   `--dry` + `--profile` (planning skips execution; the profile needs a
   real run). `--no-cache` beats
   `--force`, both layered over a `--cache-policy` spec.

### Scope resolution

After parsing, `resolveRunOptions` builds the orchestrator's `projects` field:

| Condition                                  | `projects`                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Every positional is anchored (`pkg#task`)  | `undefined` (no scope needed)                                                                                             |
| Any bare positional + `filters.length > 0` | `resolveFilters(...)` result                                                                                              |
| Any bare positional + `--all`              | `undefined` (every project)                                                                                               |
| Any bare positional + default              | `[findCwdProject(cwd)]` or error; a config between cwd and that project the lock lacks is refused ("not in the lock yet") |

`--affected[=<base>]` adds a `...[<base>]` filter — the changed
projects and their dependents, the candidates (#446) — put first in
`filterStrings` before `resolveFilters` runs, which keeps that filter's
diff per path (`affectedChanges`) as `RunOptions.affected`; `prepare`
then keeps a bare request only when the diff reaches its `dependsOn`
closure (`orchestrator/affected-tasks.ts`, 2026-10-04). With a
`graph` plugin the candidates are every project once anything changed:
the plugin's edges exist only in the run's graph. The no-value form takes
a plugin's base commit (`setBranch({ base })`), else
`defaultAffectedBase(root, baseBranch)`: the merge base with
`origin/<baseBranch>`, refused on that branch (`workspace.md`); an explicit
base that is HEAD itself on its own branch (a single-branch clone) is
named, with the bases that would compare something, never the one in use
(a fresh feature branch on its base gets the plain note); `HEAD` by name is told its
working tree has no change when the diff named none (an edit to a root
file no task declares gets the bare note).

### Interactive picker

When `tasks.length === 0`:

- Non-TTY → exits 1 with `missing task name (stdin is not a TTY, so no
picker; tasks here: …)`: `taskNamesHere(cwd, asked)` (`cli/task-verb.ts`) names
  the tasks of the projects `--filter` / `--affected` select (`asked`), or
  every project's under `--all`, else the cwd project's, else every
  project's, twelve then `and N more`; with no workspace, `vx run <task>,
e.g. vx run build`.
- TTY → `pickTask(cwd)` loads every project's tasks (only the projects
  `--filter` / `--affected` select, through `scopeFilters` and
  `resolveFilters`, the scope a bare task gets; one `selection()` serves
  both branches), prints a numbered
  list with `description` next to each id on stderr (a redirected stdout
  hid it), reads a 1-based index via `readline/promises`, emits one
  anchored `pkg#task` into `tasks`.

### Planning short-circuit

If `--dry` is set:

1. `planRun(opts)` — same setup as `run` but stops before the
   scheduler.
2. Pick a formatter from `cli/plan-format.ts`:
   - `--dry=json` → `formatPlanJson(plan, affectedBase)` → stdout.
   - `--dry=pretty` (default) → `formatPlanText(plan)` → stdout.
3. A requested name that matched no project (`plan.unresolvedTasks`),
   or an empty plan → exits 1 with `no projects declare task(s): …`
   (plus `Did you mean <task>?` when a declared task, or for `pkg#task`
   a runnable spec, is within two edits), before any JSON is
   written. An empty plan from an `--affected` or diff filter exits 0
   (`no affected project declares task(s): …`).
4. A plan marked `isKeyFailed` (a task whose key could not be derived)
   prints as usual, after the scheduler's `cache key not derived: …`
   line on stderr, and exits 1, as the run fails that task.

### Verbose summary

`--verbosity 1` (any value above 0) sets `RunHandoff.summaryTable`:
the run prints a per-task table after the framed blocks and above the
footer (nothing prints below it), one row per task with a command —
groups are left out, as the footer leaves them. The
status column is `outcomeLabel`, the one vocabulary every surface uses:

```
TASK          STATUS          DURATION
--------------------------------------
@vzn/vx#lint  restored-local       4ms
@vzn/vx#test  success           5200ms
```

Columns auto-width to the widest row (the header sets the minimum),
the duration right-aligned.

### Tests

`tests/cli.test.ts` is the main coverage:

- All flags: presence, value-or-not forms, missing-value errors,
  unknown-flag errors.
- Scope resolution matrix (default / `--all` / `--filter` /
  `pkg#task`).
- `--affected` end-to-end against a git fixture.
- Planning paths (`--dry` text/json).
- Verbose summary formatting.
- Forwarded args (cache-key folding tested in
  `tests/task-hash-derive.test.ts`).

The picker (TTY input mocked) is `tests/cli-picker.test.ts`; `--profile`
to a file is `tests/run-output-paths.test.ts` and its emission
`tests/run-artifacts.test.ts`.

### Replacing this module

The internal seam is small: `runCmd(argv): Promise<number>`. Replace
the body but keep that contract — `cli/index.ts` dispatches to it by
import. To swap the picker (e.g. for a fuzzy selector), replace
`pickTask` in-place; nothing else depends on it.

## `src/cli/watch.ts` — `vx watch` subcommand (and `watch-fs.ts`, `watch-filter.ts`, `watch-set.ts`, `watch-judge.ts`, `watch-cycle.ts`)

### Purpose

Run a task once, then re-run it on every filesystem change in the
projects in scope. The initial run goes through the same orchestrator
path as `vx run`; the watch loop just keeps calling it on debounced
filesystem events.

### Public surface

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
  serverDirs?(): readonly string[] // the held servers' projects: a write outside them is not a server's; absent, anywhere
  uncached(): ReadonlySet<string>
  namedIgnored?(): readonly string[] // paths inputs name outright that a key reads ignored files under (namedIgnoredReach): a git-ignored file at or under one is an edit
  fenced?(ownDir: string, abs: string): boolean // in a project nested under ownDir (makeFence)
  existedAtArm?: ReadonlySet<string> // what git listed at the arm; absent when it could not answer
  trackedAtArm?: ReadonlySet<string> // what git tracked at the arm (`tracked` asks git for the rest); absent when it could not answer
  clock?(): number // now on the mtime clock (fsClockNow); Date.now() when absent
}
export class ChangeJudge {
  readonly pending: Map<string, string> // path → label, what fired since the last judgement
  lastCycle: { start: number; end: number } | undefined // start on the mtime clock (fsClockNow), as armedAt
  cycle: { from: number; to: number; windows: CommandWindows } | undefined // the cycle the last change-finding judgement started: from it on the mtime clock to the run's end, with the run's command windows (RunHandoff.commandWindows)
  constructor(ctx: JudgeContext)
  seed(abs: string): void // record a path's state now, if unjudged: a link armed for its target
  sawEvent(abs: string): void // an event: a write during `cycle` no command of it (nor a held server) may have made is a change next time, whatever it settles to
  tracked(abs: string): boolean // git tracks it: at the arm, or now (one `gitTracks`, only where a server would be blamed)
  unseen(moved: readonly (string | null)[]): void // inputs a run read in a state no judgement saw (TaskOutcome.driftedInput): each is a change next time; null marks every pending path
  judge(): string | undefined // the least changed path's label (a file before a directory, a live path before a gone one), or none
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
  dirty?: boolean, // add `-m`: `dirty` is the untracked files and the tracked ones modified
): { listed: Set<string>; tracked: Set<string>; links: Set<string>; dirty: Set<string> } | undefined // one `git ls-files -t -s` at the arm; links: the symlinks, whose targets watch arms
export function gitSpeller(root: string): (p: string) => string // a path as git spells it: a symlinked dir below the root resolved
export function gitTracks(workspaceRoot: string, abs: string): boolean // git tracks `abs` (spelled by gitSpeller) now: one `git ls-files --cached`
export function lockedExtras(workspaceRoot: string): Set<string> // the files the recorded digests read besides a claimed file (.vx/dependencies.lock.json extras), absolute: watch arms them
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
  skipDir?: (rel: string) => boolean, // on Linux, asked of a directory under node_modules only
): ArmedWatcher
export function modifiedBefore(abs: string, t: number): boolean
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
It enters a `node_modules` only where the pool's `skip` keeps it: an
input names a path there through that segment, or git tracks a file
there; a re-read that changes which inputs name one re-arms the trees
(`watch-node-modules-input.test.ts`).

### Flag surface

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

### Algorithm

1. `parseRunArgs` + validate the watch-mode rejections above.
2. `cli/run.ts:resolveRunOptions(parsed, cwd, tasks)` → `RunOptions`.
   Same scope resolution as `vx run`.
3. Enumerate projects in the resolved scope via `discoverCliProjects`
   (the lock's projects with the `discover` stage it records, as
   `vx run` lists them): `opts.projects` (every project when undefined) plus each
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
   No watcher hears an edit made while it runs. One to a task it was
   running leaves the task unsaved (`drifted`); any other is found once
   the loop arms (`heardSinceRun`): of the files the arm's `gitFiles`
   lists as untracked or modified, each written since the run started
   (`InitialRun.from`, on the mtime clock) outside every window of its
   commands (`InitialRun.windows`) is an event, marked `unseen` so the
   judgement takes it for a change; a re-lock among them is the first
   cycle's (`InitialRun.lock`). A start with no edit pays `-m`'s stats
   alone (`tests/watch-initial-edit-done.test.ts`).
5. **Watch loop** (`runWatchLoop`):
   - For each project a cycle can run (`watchedProjects`: the scope
     plus its transitive dependencies through `buildPackageGraph` with
     the cross-project `dependsOn` edges `taskEdges` collects — what
     `vx run` would run for the same filter; every project while the
     edges cannot be read, as a dependency's directory removed fails
     their load and the scope alone stopped watching the rest,
     `tests/watch-dependency-gone.test.ts`), `fs.watch(dir,
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
     workspace config, or a file a plugin claims. A plugin's `discover`
     names and edges come from the lock (2026-11-11), so a dependency
     added widens a `--filter` closure only once `vx lock` records it,
     whose own event re-reads. Until item 891 each of
     these waited for a restart. A re-read that fails is said once,
     after the cycle's header: the one before the run stays silent, and
     the one after says nothing the cycle's own failure said.
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
   - On macOS the one stream serves these arms, and the import arms,
     for every directory under the root by its real path (`inStream`):
     Bun runs ONE FSEvents stream for all of a process's `fs.watch`
     calls and rebuilds it, from "now", on each watch opened or closed,
     so what lands meanwhile is lost to every watch and a close proves
     nothing after it. A re-arm that swapped `apps/`'s arms lost `apps/`
     made again, and every edit after it (macOS CI, 2026-11-04). Under
     `VX_DEBUG_WATCH` each arm line says its watch count, and on macOS
     it holds still across a removal and a restore.
   - Filter out `node_modules` (save an input named through it, or a
     file git tracks under it) / `.git` / `.vx/cache` path segments,
     `.vx/tmp` (restore staging), the `~` suffix (editor swap files), the RESOLVED
     cache directory (a relocated `cache.dir` would otherwise re-trigger
     every cycle; re-read with the watched set, so a `cache.dir` edit
     mid-watch moves it, `tests/watch-cache-dir-change.test.ts`), and each project's declared outputs
     (`outputs.files`, root-relative `workspaceFiles`) — a cycle
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
   - Catch UNDECLARED writes by content: a task with no `cache: true`
     declares no outputs and still writes into its project, and its
     own write re-triggered the cycle without end (the init walkthrough,
     2026-09-04). When the debounce timer fires, every path that fired
     in the window is hashed on its SETTLED bytes and the cycle is
     skipped if none differ from what the loop last hashed; a real
     edit, a deletion or a first sighting modified after the arm
     passes (`modifiedBefore`: the initial run's own writes arrive
     after the arm on macOS, and their mtime and ctime both predate it;
     the ctime is what catches a file moved in with an old mtime, item 945).
     After a run, "the arm" is that run's start less the racy window:
     macOS can deliver half a `git checkout` past the debounce window,
     and the late half, already read by that run, started a second
     cycle (`watch-late-batch.test.ts`). Not while a re-read is pending,
     which only a cycle makes — so a self-write
     costs one redundant cycle, not an unbounded number. Debounce time,
     not event time: on Linux a shell redirect truncates the file (one
     event, empty) and then writes it (another, full), so consecutive
     events never agree (CI read 9 re-runs where macOS, which coalesces
     the two, read 2). Pinned end to end in `tests/cli.test.ts`.
   - A name not valid UTF-8 reaches every watcher decoded, U+FFFD for
     its bad bytes: a path no file has. Gone by its state, it is a
     change all the same, and the poller samples such names by their
     bytes (`readdir` as buffers), so the cycle shows the refusal
     `vx run` gives rather than staying silent
     (`tests/watch-lossy-name.test.ts`; Linux only, APFS refuses one).
   - Debounce events `~150ms` after the last one before triggering a
     cycle, and at most 1 s after the first: a writer that never pauses
     (a dev server's log) reset the timer forever and held every edit
     back (WD-1).
   - Reentrancy guard: while a cycle is running, further events set
     a `pending` flag; the loop drains it after the current cycle
     finishes. Two events can collapse into one re-run.
6. **Exit.** `watchCmd` installs `process.on` handlers for SIGINT,
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
   (`tests/watch-signals.test.ts`). A repeat is a no-op (the abort is
   once); under `once` a second signal mid-teardown took Bun's default
   exit, not 0 (same file, "a second SIGINT during the teardown").

### Why not filter by `inputs.files`

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

### Persistent tasks across cycles

Watch mode re-invokes `orchestrator.run` per cycle with
`holdPersistent: true`, so every persistent task a cycle started,
requested or only a dependency, is handed back
running (`RunSummary.persistent`) instead of being stopped when its
graph ends. The loop holds them while it idles and hands them to the
next cycle as `RunHandoff.keep`: a server still up whose task that
cycle starts again, with the same resolved config and forwarded args,
stays up and reads ready at once (`0ms running`), and what it writes
reaches the new cycle's renderer. The rest of the graph re-runs as
usual: `vx watch dev` over `dev: { dependsOn: ['^build'] }` rebuilds
the libraries an edit reached, and the dev tool's own reload takes it
from there. A server whose config changed, or that died, is stopped
before the cycle's graph and started again; a stop that lands while it
is going ends the cycle there, having run nothing (WD-22). One the
cycle never reaches (a dependency failed) is stopped after it, by the
hand-back it came from. A dependency-only server (`keyedServers`: none
of the requested tasks stands on it) is kept only while its key is
too: the hand-back carries the key (`HeldServer.key`), the cycle
computes its own once when the task is reached, and on a change stops
the old one and starts it again with that key; e2e against an api kept
over an edit to its source tested the old api. One with no
`inputs.files` (`keyBlind`) is not held: no key sees its edits, so it
restarts each cycle. Until 2026-11-12 every dependency-only server was
stopped at the end of each cycle, so `vx watch e2e` booted its whole
stack on every edit (`tests/held-persistent.test.ts` › "a held run
keeps a dependency-only server while its key is unchanged"). Until 2026-10-08 every cycle
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

### What this does NOT do

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
  held server is blamed only for a file in its own project (`serverDirs`,
  not a nested project's) that git does not track: `gitFiles`' `tracked`
  at the arm, then `gitTracks` when it would be blamed, so a file
  committed since is the user's (`watch-server-blame.test.ts`). A judgement
  that finds nothing changed starts no cycle and breaks no streak: a
  log stamped to the second rewrites the same bytes between changes.
- Start a cycle on a file born and gone since the arm (vim's `4913`
  write probe): `gitFiles` lists what existed at the arm, and a gone path
  it did not list was never read by a key (`watch-transient-file.test.ts`),
  unless it was born during a cycle where no command of it may write
  (`sawEvent`) and its event came while it was there.
  Git lists a nested repository (a submodule, a vendored clone) as one
  entry, so a gone path under one is still a deletion.

- Doesn't accept the interactive picker — task name is required.
- Doesn't filter events through declared input globs.
- Doesn't dedupe events by project — every file change triggers a
  re-run of the user's specified task across the entire scope.
- Restart a server for an edit to its own sources: the dev tool
  reloads those itself. Only its config, or its death, restarts it.
- Tell a user's write from the run's own inside a command's window
  (`CommandWindows.writerDuring`, widened by the racy window at its start
  and a millisecond at its end, which `Date.now()` floors): an edit
  there, put back before the next judgement, is judged by state alone.
  An unsandboxed task writing outside its project (out of contract) is
  not the run's, so the same bytes rewritten there every run re-run the
  loop, named after three cycles. A hit's restore and a deferred fetch
  open a window as a command does (hit-restore.ts, deferred-outputs.ts): without one, a restore more than a racy
  window before the next command read as the user's write and started
  one more cycle.
- Re-key a cycle when a task rewrites a lockfile _during_ it: the keys
  are taken once per cycle. The run itself notices (item 750,
  [`orchestrator.md`](./orchestrator.md#srcorchestratorfingerprint-watchts--has-a-task-rewritten-the-lockfile)): nothing keyed
  before the rewrite is restored or saved, and the rewrite is an event
  the next cycle re-keys on. A rewrite to the same bytes starts that one
  cycle and settles (probed 2026-09-25, item 763).

### Tests

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
settled state), `tests/watch-edit-before-keys.test.ts` (an edit after
the judgement, before the keys, put back mid-cycle), `tests/watch-loop-selfwrite.test.ts` (a file rewritten
with different bytes every run), `tests/watch-signals.test.ts` (SIGINT
and SIGTERM during the initial run and a cycle; a Ctrl-C reaches the
cycle's task and the held dev server as SIGINT), and
`tests/staged-once.test.ts` (a cycle loads afresh).

### Replacing this module

Plausible extensions, all contained:

- **Picker support** — borrow the `pickTask` flow from `cli/select.ts`
  for TTY-with-no-task.
- **Per-project debouncing** — track which project's events arrived
  in the current debounce window and only re-run tasks in those
  projects (`opts.projects = [...affected]`). Useful for very large
  workspaces.

## `src/cli/cache.ts` — `vx cache clean`

### Purpose

Implements `vx cache clean`, which trims with a bound and clears with
none. Both parsers are `util/size.ts`'s,
re-exported here. Drives
`Cache.prune({...})` from `src/cache/cache.ts` against the cache
directory a run would use.

### Public surface

```ts
export async function cacheCmd(args: readonly string[]): Promise<number>

interface PruneArgs {
  olderThanMs?: number
  maxBytes?: number
  dry?: boolean
  format?: 'pretty' | 'json'
  cacheDir?: string // `--cache-dir`: prune the cache a run with the same flag uses
  global?: boolean // `--global`: with no bound, clear every ~/.vx/*/cache too
  error?: string
}

export function parsePruneArgs(args: readonly string[]): PruneArgs
export interface ClearResult {
  dry: boolean
  cleared: string[]
  bytesFreed: number
}
export { parseDuration, parseSize } from '../util/index.js'
// util's treeBytes (the blocks under a path, as `du` counts them: diskBytes of each lstat) sizes a clear and `vx info`'s rows
```

### Subcommand surface

```
vx cache clean --older-than <duration>
vx cache clean --max-size <size>
vx cache clean --older-than 7d --max-size 500M   # both
vx cache clean --max-size 1G --dry               # say what the policy would reap; delete nothing
vx cache clean --max-size 1G --format json       # schemas/cache.json
vx cache clean --older-than 30d --cache-dir <path>
vx cache clean                                   # no bound: clear the cache
vx cache clean --global                          # and every workspace's store
```

Neither bound may be zero — a policy that would evict every entry is
refused with "`vx cache clean` with no bound clears the whole cache". A bare number for `--max-size`
is refused too: `--max-size 10` would read as ten bytes and evict
nearly everything; give a unit. Both policies may be combined:
age-based eviction first, then LRU eviction if the total is still
over the size cap. The prune also reaps orphaned artifacts (an archive
with no index row) and stale temps, and says so — `✓ vx cache clean  freed 1.4 GB`, then `12 entries · 3
orphaned artifacts`; a dry run says `would free 1.4 GB (dry run)`.

The directory is the one a run would use — `--cache-dir`,
`defineWorkspace({ cache: { dir } })` and a `config` plugin's edit of it,
through `cliCacheDir` — or a prune silently no-ops against the wrong
path. So is the store: with `.vx/cache` deleted the prune still opens
the store a run would (`resolveStoreRoot`), where it once said 0 while
every entry stayed restorable (X-17); `vx info` reads it the same way. A cache this user cannot write is refused up front with the
directory named, as a run refuses it (a dry run only reads, and reads
a read-only cache fine), and an upgrade that reset the index is
announced once. A prune that deletes takes the workspace's run lock
first (`acquireRunLock`, orchestrator.md), so it waits for a run on the
workspace — `[vx] waiting for another vx run (pid N) on this workspace
to finish…` after a second — instead of evicting the hits that run has
just probed; the age cutoff is taken before the wait, so what the run
touched survives it. A run in another checkout shares the store and
holds none of this checkout's locks, so the prune then waits for every
process with the store open (`holdStore`: SQLite's exclusive lock, which
a WAL connection's shared lock refuses) and opens its own handle after.
A cache directory with no store may be another workspace's: the prune
holds it exclusive (`holdCacheDir`) while every run on it holds it
shared, so each waits for the other. A dry run takes no lock.

### No bound: clear

With neither bound, deletes the cache directory a run would use (`.vx/cache`, `cache.dir`,
`--cache-dir`) when it holds a `cache.db`, and the store that index
records (`Cache.storeDir`, else `resolveStoreRoot`): the entries live
in `~/.vx/<id>/cache`. The recorded store goes only when its `<id>` is
one of `repoIdsOf(root)`: an index copied from another workspace named
that one's store. A target that is `.vx` or holds it (the
workspace config, the lock, `.vx/.gitignore`) is refused, and so,
first, is a cache directory `refuseForeignCacheDir` refuses (home, `/`,
the workspace, a `.git`, reached through a link). A cache
directory other than `.vx/cache` is the user's: only `vxCacheEntries`
(the index and its WAL, `VX_ARTIFACT_NAME` files, an unchanged `*`
`.gitignore`; every other record is in the index) go, then the
directory if empty (item 968). A linked `.vx/cache` loses those and
`compiled/`, never the rest of what its target holds. The size is
summed before the delete (links not followed); the delete takes the run
lock, as a prune does, and holds each store it deletes alone
(`holdStore`, in path order) once no other process has it open: a
checkout's lock never covered the store its sibling checkouts run on.
Under that hold a store is renamed to `<store>.removing` (one a crashed
clean left is deleted first) and deleted once the holds are released
(`moveAside`): deleted in place, its `store.db` went before its other
files, and a sibling's run in between made a `store.db` there that the
delete then took, with the entry saved. A run that meets the hold waits
for it (`attachStore`, prepare.ts).
A cache directory with no store it deletes is held exclusive too
(`holdCacheDir`): another workspace's run on it died opening it as the
clear deleted it (ENOENT on its `.gitignore`, SQLite's disk I/O error). `--dry` deletes nothing and takes no lock.
`--global` adds every `~/.vx/*/cache` and is refused with a bound or
`--cache-dir`. The output says the store is shared by the repo's
checkouts and that run history goes.

### Parsers

#### `parseDuration(input): number | null`

```
/^(\d+)(ms|[smhd])$/i
```

Returns ms. `s` (× 1000), `m` (× 60_000), `h` (× 3_600_000), `d`
(× 86_400_000), case-insensitively (`30D` is thirty days). `null` on
parse fail; the caller surfaces `--older-than must be a duration like 30d, 24h or 60m (got <value>)`.

#### `parseSize(input): number | null`

```
/^(\d+)(?:([KMGT])(?:i?B)?|B)?$/i
```

Returns bytes. Multipliers are powers of 1024 (`K`, `M`, `G`, `T`), with an optional `B` or `iB` (`32KiB`).
Optional trailing `B` is allowed. `null` on parse fail — including
digits past 2^53, which would parse to a number the user did not type;
the caller surfaces `--max-size must be a size like 500M or 1G (got <value>)`.

### Tests

`tests/cli.test.ts`: `parseDuration` and `parseSize` units and parse
failures; `vx cache clean` reports 0 entries
pruned from an empty cache, and rejects an unknown subcommand.
Eviction, orphan reaping and `dry` are tested in
`tests/cache.test.ts` against `Cache.prune`; clearing in
`tests/cache-clean.test.ts`.

## `src/cli/help.ts` — help text

### Purpose

Static help text printed by `vx help`, `vx --help`, `vx -h` and a bare
`vx` inside a workspace; `vx <verb> --help` prints the same text cut to
that verb. A bare `vx` outside one prints the no-workspace refusal every
verb gives there, pointing at `vx help`, and exits 1; an unknown command
prints one line naming it and pointing at `vx help`, not the text.

### Public surface

```ts
export async function printHelp(
  pluginCommands: readonly string[] = [],
  verb?: string,
): Promise<void>
export function helpColors(
  stream: { isTTY?: boolean },
  detect: (s: NodeJS.WriteStream) => ColorSupport,
): ColorSupport
export function paintHelp(text: string, colors: ColorSupport, paint: typeof Paint): string
export function helpText(pluginCommands: readonly string[] = []): string
export function verbHelpText(verb: string): string
export function documentedFlags(verb: string, text?: string): string[] // text: the help text (default: helpText())
export function seeHelp(verb: string): string
export function flagHint(verb: string, arg: string): string // ` (did you mean --x?)` or '', every verb's unknown-flag refusal
export function acceptedFlags(verb: string): string[] // Usage-line flags; `[OPTIONS]` adds run's, less watch's refusals
export const WATCH_REFUSED_FLAGS: readonly string[]
export { CORE_VERBS } from '../util/index.js'

// `completions.ts`
export type CompletionShell = 'bash' | 'zsh' | 'fish'
export function verbFlags(verb: string): string[] // `--help` + acceptedFlags(verb)
export function completionScript(shell: CompletionShell, verbs: readonly string[]): string
export async function completionsCmd(
  args: readonly string[],
  pluginVerbs: readonly string[],
): Promise<number>

// the value sets `completions.ts` offers after a flag; the tests hold
// each to the flag's parser
export const FLAG_VALUES: Readonly<Record<string, readonly string[]>>

// `core-alias.ts`: registers the `@vzn/vx` virtual module so a
// `vx.config.ts` can import the façade inside the compiled binary,
// where no node_modules copy exists. `bin.ts` calls it before dispatch.
// Synchronous: the workspace config's CommonJS bundle requires it.
// `@vzn/vx/config` resolves to `loadConfig`'s module the same way.
export function registerCoreAlias(
  load: () => Record<string, unknown>,
  loadConfig: () => Record<string, unknown>,
): void
```

`helpText` is the whole reference, hard-coded. `verbHelpText` is the
same text cut to one verb — the title, the `Usage:` lines that name
the verb, and every blank-line-delimited section that is `(for
<verb>)` or lists a `vx <verb>` form — plus a `Full reference: vx
help` trailer; a verb the text does not know gets the whole reference.
There is no second list: the cut reads the text, as `acceptedFlags`
(the `(did you mean …)` source, via `flagHint`) does.

`printHelp` paints the text it prints, never the text the parsers read:
`paintHelp` adds accents line by line (headings bold with a dim
`(for <verb>)`, `vx <verb>` bold cyan, the flag, selector or example a
row opens with in cyan; prose and continuation lines plain), so the
painted text strips back to `helpText` byte for byte. `helpColors`
paints on a TTY only, and `NO_COLOR` / `FORCE_COLOR=0` still win:
`FORCE_COLOR=1` set for a CI run's log does not paint a piped help.
A row's term ends at two spaces, so every option row keeps a two-space
gap before its description.

### Sections (current)

- `Usage` — one line per verb.
- `Selection (for run)` — default / `--all` / `--filter` / `--affected`
  / `pkg#task`.
- `Execution (for run)` — concurrency, `--schedule`,
  `--exclude-dependencies`, `--no-cache` / `--force`, `--cache-policy`,
  `--continue`, `--retries`, `--timeout`, `--output-logs`,
  `--cache-download`, `--verbosity`.
- `Planning (for run — skips execution)` — `--dry`.
- `Artifacts (for run)` — `--profile`.
- `Extensions (plugins)` — what plugins are for (remote cache,
  distributed execution, telemetry) and the plugin guide's URL.
- `Argument forwarding (for run)` — explanation of `--`.
- `Watch mode` — `vx watch`.
- `Cache management` — `vx cache clean` examples.
- `Introspection` — `vx show`, `vx info`, `vx why`, `vx last`.
- `Migration` — `vx init` and the pointer to `bunx @vzn/vx-migrate`.
- `Upgrade` — `vx upgrade [TAG]` and `-g` (only the global vx).
- `Shell completions` — `vx completions bash|zsh|fish`.
- `Docs` — `vx docs <query>`.
- `Config lock` — `vx lock`.

A trailing `Plugin commands:` section follows, only when the
workspace's plugins add a verb: each verb, its description and its
plugin.

### Updating

When adding / changing a flag in `cli/run.ts` or `cli/cache.ts`,
update the help text here too. `tests/cli-doc-drift.test.ts` holds
the help to the parser: every flag `parseRunArgs` accepts appears in
`help.ts`, so a flag added to the parser and not to the text fails the
gate.

### Tests

`tests/cli.test.ts` pins `verbHelpText`: the run cut carries every
flag `documentedFlags('run')` names and no other verb's section, the
cache and last cuts carry their own examples only, and an unknown verb
gets `helpText()` byte for byte. `tests/cli-doc-drift.test.ts` pins
the run flags table in cli.md against the parser.

## `src/cli/plugin-commands.ts` — plugin-contributed CLI verbs

### Purpose

The `commands` seam's host. The dispatcher (`cli/index.ts`) matches
core's verbs first; for a word it does not know it asks
`resolvePluginCommand(verb, cwd)`, which finds the workspace around the
cwd, loads `.vx/workspace.*`, and returns the one plugin whose
`commands[verb]` exists (the load refuses two declaring a verb) — with a `CommandContext`
(`workspaceRoot`, `cache.dir`, `warn`, and `run.concurrency`, the worker
count a `vx run` there uses without `--concurrency`: the workspace's
`concurrency`, else `machineParallelism()`). `pluginCommandHelp(cwd)` lists
every plugin verb for `vx help`; `pluginVerbs(cwd)` names them for
`vx completions`.

### Public surface

```ts
export interface ResolvedPluginCommand {
  plugin: VxPlugin
  command: PluginCommand
  ctx: CommandContext
}
/** The workspace file failed to load: said beside "unknown command", never instead of it. */
export interface UnresolvedPluginCommand {
  loadError: string
}

export async function resolvePluginCommand(
  verb: string,
  cwd?: string,
): Promise<
  | ResolvedPluginCommand
  | { declaredVerbs: readonly string[] } // no plugin declares it; these are what they do declare
  | UnresolvedPluginCommand
  | null // no workspace
>
export async function pluginVerbs(cwd?: string): Promise<string[]> // declaration order; none when the workspace does not load
export async function pluginCommandHelp(cwd?: string): Promise<string[]>
```

### Invariants

- Core's verbs win: a plugin naming `run` or `version` never executes
  (pinned in `tests/plugin-commands.test.ts`).
- Outside a workspace the answer is `null`; inside one where no plugin
  declares the verb it is `{ declaredVerbs }` (feeding the "did you mean"
  and the where-verbs-come-from line). Either way the dispatcher reports
  "unknown command" — never a workspace-not-found error for a typo. A workspace file that fails to
  load answers `{ loadError }`: the dispatcher still says "unknown
  command" and adds the load error, so a typo reads as a typo and a real
  plugin verb points at the file that broke it.
- The verb's return value is the process exit code; a thrown `UserError`
  prints like core's own (`bin.ts` handles it).
- The loader validates the shape (`{ description: string, run: function }`)
  before any verb can be reached.

### Tests

`tests/plugin-commands.test.ts`.

## `src/cli/format.ts` — shared formatters

### Purpose

Small string formatters shared by multiple CLI subcommands. The one
formatter lives in `util/size.ts` since item 658 (the orchestrator may not
import the CLI); this file re-exports it for the verbs.

### Public surface

```ts
export { formatBytes } from '../util/index.js' // (n: number) => string
```

Human-readable byte size with `B / KB / MB / GB / TB / PB` suffixes
and one decimal of precision below 10 of any unit but PB. Powers of 1024.

| Input            | Output   |
| ---------------- | -------- |
| `0`              | `0 B`    |
| `1023`           | `1023 B` |
| `1024`           | `1.0 KB` |
| `9 * 1024 + 100` | `9.1 KB` |
| `10 * 1024`      | `10 KB`  |
| `1024 ** 2`      | `1.0 MB` |
| `5 * 1024 ** 3`  | `5.0 GB` |

### Use sites

- `vx cache clean` output (`freed 1.3 GB`).
- The `vx info` doctor printout: the
  cache-size line (`cache entries     N (1.3 GB)`).
- `vx last`: each executed task's peak RSS.

### Tests

`tests/cli.test.ts` includes a `formatBytes` table-driven case set; the
table above is the function's output row for row
(`tests/module-shape-drift.test.ts`).

## `src/cli/plan-format.ts` — plan → text / JSON

### Purpose

Format a `RunPlan` (from [`orchestrator.md`](./orchestrator.md#srcorchestratorplants----dry-planning)) as human-readable
text or structured JSON. Pure functions; no I/O.

### Public surface

```ts
export function planReport(plan: RunPlan): ui.Block // the `Plan` panel `vx run --dry` prints
export function formatPlanText(plan: RunPlan, c?: ColorSupport): string // it, rendered
export interface PlanTaskJson {
  id: string
  project: string
  task: string
  hash: string
  cacheStatus: CacheStatus
  deps: readonly string[]
  p50Ms?: number
  executor?: string
  download?: 'deferred'
  description?: string
  affected?: AffectedReason // why `--affected` kept it (affected-tasks.md)
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string } // a `skipped` task's own platforms, and this machine's
  blockedBy?: string // a `skipped` task's root: the task off this machine's platform it depends on
}
export function formatPlanJson(plan: RunPlan, affectedBase?: string): string
```

The two formatters return a complete string with a trailing newline; the
caller writes it to stdout or a file (`Bun.write(path, out)`).

### `formatPlanText`

The `Plan` panel: one row per real task (groups are hidden, as the live
runner hides them) on the running list's grid (`planList`, the same
component and header the run draws): the status and cache words the run
would print (`cached` `local` or `remote`, `run` `miss` or `no-cache`), its
usual time from history on a task that would run (`~p50`), a remote
hit's download size under `outputs`, how many tasks are downstream of
it under `blocks` (as the run counts them), and where it would run
under `worker`. A `description` or an `--affected` reason rides the row, dim,
after the id. Painted when `c` is enabled (the run passes stdout's);
left out, the words are plain. The cache key is in `--dry=json`.

```
  Plan 4    status  cache      usual    time   cpu    mem outputs  blocks worker         task
            cached  local          —       —     —      —       —       1 local          @vzn/vx#format-check
            cached  remote         —       —     —      —    12MB       2 local          @vzn/vx#lint  oxlint with tsgolint-backed type-aware checks
            run     miss       ~4.2s       —     —      —       —       1 local          @vzn/vx#test
            run     no-cache       —       —     —      —       —       0 local          @vzn/vx#dev

  tasks      4 planned · 2 cache hits (1 local, 1 remote, 12 MB) · 1 would run · 1 no-cache
  predicted  ~4.20s wall · ~4.20s total execution · 1 task never timed (+?)
```

Words, as the run's rows use them; the status word's colour carries the
outcome, and an empty cell shows `—`:

| Status    | Cache      | Plan status   |
| --------- | ---------- | ------------- |
| `cached`  | `local`    | `hit-local`   |
| `cached`  | `remote`   | `hit-remote`  |
| `run`     | `miss`     | `miss`        |
| `run`     | `no-cache` | `no-cache`    |
| `noop`    | `—`        | `@noop`       |
| `skipped` | `—`        | `skipped`     |
| `not run` | `—`        | `not-started` |

The fields under the rows: `tasks` counts them; `predicted` prints only
when history gave the plan something to say (at least one would-run
task has a p50) and counts the would-run tasks without history as
`(+?)`; a `--cache-download` policy adds `download`: how many tasks
would keep their outputs remote and, up to three, the tasks the
eligibility gate kept eager and why.

**Placement** is the `worker` cell: the executor the plan placed the
task on, `local` when none:

```
  Plan 2    status  cache      usual    time   cpu    mem outputs  blocks worker         task
            run     miss       ~4.2s       —     —      —       —       0 vx/reapi       @vzn/vx#test
            run     miss           —       —     —      —       —       0 local          @vzn/vx#docker

  tasks     2 planned · 2 would run
```

It is the executor's NAME, not a `local`/`remote` word for the cache
tier. One placement is not an executor: `@noop` marks a `remote: 'only'`
task no remote executor took. It will not run ANYWHERE this run
(dependents use the machine's ambient state), so its row reads `noop`
and the counts name it `noop`, never would-run. See
[`schema.md` § `remote`](../schema.md#remote-optional) for what pins a task
locally and what `'only'` means.

**`skipped`** is what the run skips here: a task whose `exec.platforms`
leave this machine out, and each task that depends on one. Its row
says why after the id, as the run's frame does (`needs darwin-arm64,
this is linux-x64`, `blocked by mac#build`), and the counts name it
`skipped`.

### `formatPlanJson`

One JSON object on one line, each task a `PlanTaskJson`, led by `affectedBase` (the ref the diff
was taken from) under `--affected`; `schemas/plan.json`
states it and `tests/cli-json-schemas.test.ts` holds it:

<!-- prettier-ignore -->
```json
{"tasks":[{"id":"@vzn/vx#lint","project":"@vzn/vx","task":"lint","hash":"d66cfed2a1b2c3d4","cacheStatus":"hit-remote","deps":[],"description":"oxlint with tsgolint-backed type-aware checks"}]}
```

`p50Ms`, `executor`, `download`, `affected`, `otherPlatform` and
`blockedBy` ride a task only when set, and
`predicted` and `downloadDowngrades` ride the object only when the plan
has them. The object enumerates its fields on purpose — the plan's
internal shape is not the wire — so a new `PlannedTask` field is not on
the wire until it is added here. For tooling —
`vx run <task> --dry=json | jq …`.

### Tests

`tests/plan-format.test.ts`:

- The text form hides groups, puts every real task on the run's grid,
  shows the description only when set, and says so plainly on an empty
  or all-miss plan.
- The `~p50` and `predicted` field appear only with history; a task
  without it is counted as `(+?)`; an all-hit plan has none.
- JSON carries every planning field, `p50Ms` and `predicted` when present.
- Placement: the executor name in the worker cell, `local` when the task
  carries none, a JSON field when present.
- The samples on this page are what the formatters print for the same
  fixture.

## `src/cli/upgrade.ts` — `vx upgrade`

### Purpose

`vx upgrade [TAG]` brings vx to a release the way it was installed. A
compiled binary installed by hand reads its platform package
(`@vzn/vx-<os>-<arch>`) from the npm registry the user configured
(`cli/registry.ts`: `.npmrc`, bunfig, npmjs.org last, with that
registry's credential sent under it only), verifies npm's registry
signature over `name@version:integrity` against npm's key pinned here,
verifies the tarball's SHA-512 against that integrity, extracts
`package/vx` and renames it over the current executable. The signature
is what proves the bytes are npm's: the host serving the tarball cannot
make it (2026-10-13; pnpm/get checks the same). A vx a package
manager installed is upgraded by that manager (`managedInstall`,
`upgradeArgv`); vx never installs Node or a package manager.

Handed off by a global vx (`VX_HANDED_OFF` names it), the project's vx
moves both to one version: its own install first, then the global
(`upgradeGlobal`), each its own way (`upgradeBoth`); a refusal names the
install that failed (2026-10-15). `vx upgrade -g` moves only the global: the
compiled binary and npm-launcher.sh skip the hand-off for it
(`upgradesOnlyItself`), and `upgradeOnlyGlobal` upgrades this vx its
own way, refusing when it is a project's install (2026-10-16).

### Public surface

```ts
export const NPM_SIGNING_KEY: SigningKey // npm's registry key, pinned
export interface SigningKey {
  id: string // npm's key id, `SHA256:…`
  spki: string // SPKI DER, base64
}
export function isBunfsPath(p: string): boolean // a path inside the compiled binary's bundle
export function isCompiledBinary(): boolean
export function npmOwnedBinary(execPath: string): string | null // the package that owns this file, or null
export function versionSpec(tag: string | undefined): string // `latest`, or the version a tag names
export async function fetchManifest(
  pkg: string,
  spec: string,
  verb?: string,
  registry?: Registry,
  silenceMs?: number, // each wait on the registry; default 30 s
): Promise<unknown> // the registry's document
export interface SignedRelease {
  version: string
  tarball: string
  integrity: string // `sha512-…`, as npm signed it
}
// refuses no signature, an unpinned key id, a signature that does not verify, no integrity
export function verifiedRelease(manifest: unknown, pkg: string, key?: SigningKey): SignedRelease

export function binaryFromTarball(tgz: Uint8Array): Uint8Array // `package/vx`
// the signature, the download's SHA-512, then the extraction; null when the release is this vx's version
export async function releaseBinary(
  pkg: string,
  spec: string,
  announce: (version: string) => void,
  key?: SigningKey,
  current?: string, // the version being replaced; default this vx's
  silenceMs?: number, // each wait on the registry; default 30 s
): Promise<Uint8Array | null>
export async function replaceBinary(
  dest: string,
  fetchBinary: () => Promise<Uint8Array | null>, // runs after the write check
  starts?: (dest: string) => boolean, // false puts the previous binary back (item 1097)
): Promise<boolean> // false: nothing to install
export interface ManagedInstall {
  manager: 'npm' | 'pnpm' | 'bun' | 'yarn'
  scope: 'global' | 'project'
  cwd: string
  field?: 'dependencies' | 'devDependencies' | 'optionalDependencies'
  plugins?: string[] // the @vzn/vx-* plugins the same package.json lists from the registry
}
export function managedInstall(execPath: string, cwd: string): ManagedInstall | null
// the version `tag` names, else the registry's latest; `vx init` asks it too (verb prefixes refusals)
export async function targetVersion(tag: string | undefined, verb?: string): Promise<string>
export function upgradeArgv(install: ManagedInstall, version: string): string[] // core and plugins pinned to `version`, one install
// `latest` on the four below: `version` is the registry's latest, refused below `current`
// runs that argv; a plugin behind `version` runs it even when core is at it
export async function upgradeManaged(
  install: ManagedInstall,
  version: string,
  current?: string,
  step?: string,
  latest?: boolean,
): Promise<boolean>
// the binary at `dest` to `spec`; `current` itself answers `already at` with no network
export async function upgradeBinary(
  dest: string,
  spec: string,
  current?: string,
  step?: string,
  key?: SigningKey,
  latest?: boolean,
): Promise<boolean>
// the global vx at `from` to `version`: replaced, or updated by its manager; refusals name it
export async function upgradeGlobal(
  from: string,
  version: string,
  key?: SigningKey,
  latest?: boolean,
): Promise<void>
// the project's vx at `dest`, then the global `from`, to `version`; a moved project is locked even when the global fails
export async function upgradeBoth(
  from: string,
  dest: string,
  install: ManagedInstall | null,
  version: string,
  latest: boolean,
  key?: SigningKey,
  current?: string,
): Promise<void>
// `vx upgrade -g`: this vx alone to `version`; a project's install refuses
export async function upgradeOnlyGlobal(
  self: string,
  version: string,
  current?: string,
  latest?: boolean,
): Promise<void>
export async function upgradeCmd(argv: readonly string[]): Promise<number>
// `bin --version`, run at `/` so no workspace hands it off, when it answers as vx within the bound, else null
export function startedVersion(bin: string, timeoutMs?: number): string | null // default 10 s
```

A host the box cannot reach is one line naming the host and the step
(`could not reach <host> to <what>`), never Bun's `fetch` stack
(832c349).

### Invariants

- Every refusal (signature, key id, integrity, extraction, a directory
  it cannot write) comes before anything is written; the tarball is not
  fetched until the signature verifies. `tests/upgrade.test.ts` holds a
  forged signature, a wrong key id, a re-signed-elsewhere integrity and a
  tampered tarball, each against an untouched `dest`.
- The signed message is built from the package vx asked for, so npm's
  signature for another package does not verify.
- No fallback to GitHub's release digest: it comes from the same host as
  the asset, so it proves the transfer only (item 1096).
- Compiled-binary detection keys off `Bun.main` / `process.argv[1]`
  (`/$bunfs/…`); `import.meta.path` is only a last fallback, since under
  `--minify --bytecode` it reports the original source path.
- A binary under `node_modules` is a package manager's: global trees by
  path (`<prefix>/lib/node_modules`, `pnpm/global`, `.bun/install/global`,
  `yarn/global`), a project by the package.json that lists `@vzn/vx`
  (the tree's root, else the nearest above cwd), its manager by lockfile,
  then `packageManager`. A `bunx` cache is refused.
- `latest` below the running vx is refused on every install path, by
  one function (`refuseOlderLatest`); a version named by `TAG` goes
  back. A package manager's install went down to it with exit 0.
- Core and every `@vzn/vx-*` plugin beside it move in one install to one
  release (2026-10-16); a plugin in another field is refused before
  anything runs.
- The compiled path against the real registry stays manual (proven
  2026-10-13: `@vzn/vx-<os>-<arch>@0.0.635` for all four targets verified,
  extracted, and the linux-x64 binary answered `vx 0.0.635`).
