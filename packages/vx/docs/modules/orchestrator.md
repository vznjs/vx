# `src/orchestrator/` — the run pipeline

## `src/orchestrator/{index,run}.ts` — end-to-end glue

### Purpose

Placement — which executor each task lands on, and the `--dry` view of
it — lives in `orchestrator.md` since 2026-09-10; `run()` calls
`placeTasks` once and `planRun` calls `planExecutorOf`. Signal
forwarding (SIGINT/SIGTERM/SIGHUP to every child, exit 128+signo) is
`orchestrator.md`; `run()` installs it before the graph and removes it in
its finally.

The orchestrator module's entry. `run.ts` hosts `run()` / `planRun()`;
`index.ts` is the module contract re-exporting them with
`RunOptions` / `RunSummary` ([`orchestrator.md`](#srcorchestratoroptionsts--runoptions--runsummary)), `Logger` /
`defaultLogger` ([`report.md`](./report.md#srcreportloggerts--pluggable-logging-surface)), the `RunPlan` types
([`orchestrator.md`](#srcorchestratorplants----dry-planning)), and the plugin / telemetry / wire /
metrics surfaces the public API consumes. Invoked directly by
`cli/run.ts` — a run always executes in the `vx run` process, and the
scheduler never leaves it. Discovers the workspace, loads
configs, builds the task graph, opens the cache, installs plugins +
telemetry, fires cache acceleration (remote prefetch / local
short-circuit), schedules execution two-tier, manages persistent
subprocesses, writes optional artifacts, and records the run history.

Companion modules: [`orchestrator.md`](#srcorchestratorplants----dry-planning) for the read-only
`--dry` mirror; [`orchestrator.md`](#srcorchestratorpreparets--shared-runplanrun-setup) for the
shared setup; [`orchestrator.md`](#srcorchestratorlocal-shortcircuitts--restore-ahead-classify) /
[`orchestrator.md`](#srcorchestratorremote-prefetchts--background-remote-gets) for the acceleration
passes; [`orchestrator.md`](#srcorchestratorplugints--the-vxplugin-interface--installer) / [`orchestrator.md`](#srcorchestratortelemetryts--canonical-telemetry-export-contract)
for the extension seams.

### Public surface

```ts
export function run(options: RunOptions): Promise<RunSummary>
export function planRun(options: RunOptions): Promise<RunPlan>
// The same two as vx's CLI calls them, with its hand-off (CoreRunOptions).
export function runCore(options: CoreRunOptions): Promise<RunSummary>
export function planCore(options: CoreRunOptions): Promise<RunPlan>
// The abort reason `vx watch` stops a cycle with: the run's own work stops, its ready servers, handed in (`RunHandoff.keep`) or made ready by the run, are spared.
export const CYCLE_INTERRUPT: 'vx:cycle-interrupt'
export function nxProjectTarget(spec: string, projects): string | undefined // Nx's `web:build` as `web#build`, when web declares build
export function projectNamed(typed: string, projects): string | undefined // `cart` as `@scope/cart`, when that is the one such project
export function projectAtDir(typed: string, root: string, projects): string | undefined // the project whose directory `typed` is: `alpha` for `p/a`
export function shouldShortCircuit(nodes, policy): boolean
export function invocationCommand(line: readonly string[] | string): string // the args after `--` as `<n arguments>`; a string is split as sh splits words
export function runLockPath(workspaceRoot: string, dir?: string): string // the lock directory
export function liveSocketPath(workspaceRoot: string, lockDir?: string): string // `<lock>.sock`: the run in progress answers `vx last --live` there
export interface LiveSnapshot {
  live: { runId; command; pid; startedAt; elapsedMs }
  tasks: LiveTask[]
  warnings: string[]
}
// The workspace's run lock (below); `vx cache clean` takes it too. `of: 'lock'`
// is its other lock, which `vx lock` holds from evaluating to writing.
export function acquireRunLock(
  workspaceRoot: string,
  opts: { log: (line: string) => void; signal?: AbortSignal; dir?: string; of?: 'lock' },
): Promise<() => Promise<void>>
// What `vx run` and a plugin verb read of the workspace's cache policy.
export function workspaceCachePolicy(config): CachePolicy | undefined
export function namesRemote(spec: string | undefined): boolean // `cache.policy` names `remote:r` or `remote:w`
// Task entries by key for a task run on another machine
// (`ExecutorContext.artifacts`, `CommandContext.artifacts`).
export function taskArtifacts(cache: CacheLayer, workspaceRoot: string): TaskArtifacts
export interface TaskArtifacts {
  save(key: string, task: ArtifactTask, run: ArtifactRun): Promise<void>
  restore(key: string, task: ArtifactTask): Promise<CapturedChunk[] | null>
  // The output alone, no file laid (a remote-only task's stay off this disk).
  // A remote read is kept locally, so a later restore downloads nothing; it
  // names no task, so its row reads `<key>#unknown` and its names go unchecked.
  output(key: string): Promise<CapturedChunk[] | null>
  // True once a remote the run reads holds it: this machine's entry uploaded
  // to those it writes when none does. Another machine reads the remotes alone.
  share(key: string): Promise<boolean>
  // This machine's entry sent over the remotes' copy another machine found corrupt.
  resend(key: string): Promise<boolean>
  // Whether a remote it writes took what `save` uploaded; undefined when it writes none.
  uploaded?(key: string): Promise<boolean | undefined>
}
// What a machine that runs the run's tasks reads its cache under
// (`ExecutorContext.cacheFacts`, `CommandContext.artifactsFor`).
export interface CacheFacts {
  refs: readonly string[]
  lent: Readonly<Record<string, string>> // plugin name → its remote's `lend` token
  expiresAt?: number
}

// RunOptions highlights (full list in options.md):
//   cwd, tasks, projects?, concurrency?, cache?: CachePolicy,
//   retries?, excludeDependencies?, forwardArgs?, outputLogs?, flow?,
//   footer? (false: none), profile?, command?, log?, bus?,
//   inflight?, handleSignals?, signal? (AbortSignal: tear the run down and return),
//   holdPersistent? (return every persistent task still running),
//   keep? (an earlier run's hand-back: keep each server whose task is unchanged)
//   commandWindows? (the run's command windows, command-windows.ts; vx watch passes its own)

export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
  persistent?: HeldPersistent // { ids, stop(), servers }, set only under holdPersistent
  refused?: string // why the run refused to start; the caller prints it
}
```

### Algorithm — `run()`

1. **Color decision + event bus.** Programmatic logger → plain text;
   default logger → `detectColors()`. The renderer SUBSCRIBES to the
   run event bus (`terminalSubscriber`); `run()` emits through
   `busLogger` — it never calls the logger directly. The bus may be
   the caller's (`RunOptions.bus`) and outlive the run, so what `run()`
   subscribes on it leaves with the run: the renderer in the wrapper's
   finally (`runOnBus` is the body), a plugin's hooks and its direct
   `ctx.bus.subscribe` with `disposePlugins`, the telemetry source with
   its handle's `dispose()`, the outcome fold once the graph ends.
   The outcome fold (`foldOutcomes`, `run-records.ts`) is the run's own
   subscriber: each `task:complete` of the graph's nodes, in finish
   order, is the list every later step reads (history, telemetry
   summary, footer, `RunReport`), and as each lands it hands the task
   to `RunKeeper` and a hit's row to the history stream.
2. **`prepareRun(options, log)`** — shared setup: discovery, scoped
   config loading (from the lock), package + task
   graph, cache open (local policy slice; the declared `cache`
   layers chained in order; an injected
   `RunOptions.remoteCache` wrap wins), bulk git populate, hash memo.
   **Caller owns `cache.close()`.**
3. **Empty-case handling.** `no-tasks-declared` / `empty-graph` →
   log, close cache, return NOT-ok. `none-affected` (a diff-scoped run
   whose names are declared only outside the scope) → log, close, return
   ok.
4. **Plugins.** When declared: `installPlugins` (setup hooks on the
   bus; a throw is a fail-fast UserError naming the plugin), then
   run-context capture (HEAD read from `.git` directly, a git spawn only
   as the fallback; dirty reuses the GitFilesCache status) and `subscribeTelemetry` — which returns `undefined` when
   zero sinks are contributed, so a plain run adds no subscriber and
   builds no records. The pipeline stages (`config`, `project`,
   `graph`, `key`, `schedule`) ran earlier, inside `prepareRun`.
5. **Run-level state.** `runId` (UUIDv7) + `runStartHrTimeNs` anchor +
   `runStop` (`run-stop.ts`): the run's one abort, the `liveChildren` set
   and `persistentRegistry` map, and the SIGINT/SIGTERM/SIGHUP handlers,
   installed here and removed (`detach`) in a `finally`.
6. **Sandbox prepare.** `prepareSandbox(nodes)` — null when no node
   declares `exec.sandbox`; otherwise an armer whose probe + init run on
   the first sandboxed execution (sandbox-request.md).
7. **`markSurfacedDeps(nodes)`** — transparent-group display marking;
   the footer run context is built (there is no top-of-run header).
8. **Cache acceleration.** LayeredCache → `startRemotePrefetch`
   (background, drained before close). Local reads on +
   a non-empty graph (`shouldShortCircuit`) → `startLocalShortCircuit`,
   producing `preProbed` (probe reuse) + `restoreTier`.
9. **`runGraph({..., priorities, restoreTier})`.** Two-tier schedule;
   each ready node runs `executeTask` (with its pre-probe when
   present; its arguments from `executeArgsOf`, execute-args.ts, which
   hands every task the run's one `RunContext` by reference) through `admission.ts`: a service-supplied `inflight` map
   dedupes identical-hash tasks across concurrent delegated runs, and
   under `continueMode: 'always'` the taint of an upstream failure is
   tracked so the task's save is withheld.
10. **Persistent cleanup** (`persistent.ts`, `disposeServers`). `selectKeepAlive` picks
    the persistent tasks the user REQUESTED (or that were surfaced), and
    every persistent task a kept one depends on (directly or through
    groups: `vx run dev --filter app` keeps the `api#dev` its `app#dev`
    needs), to KEEP ALIVE in the real CLI foreground (`options.log === undefined
&& handleSignals !== false`); `shutdownPersistent` SIGTERMs every
    other persistent child's group and waits for the groups, SIGKILLing
    whatever is left after a 2 s grace (see util.md, kill-tree.md),
    each server only once the servers using it (`serverUsers`, through
    groups too) have exited, as the early stop of an unneeded server does.
    Before the SIGTERM it returns the children that already ended on
    their own, not cleanly (`CrashedPersistent`: a non-zero exit or a
    signal): each fails the run, its outcome becomes `failed` with that
    code (`failServer`; a kept server that has already died likewise, item 1071), and
    a status line after the summary names it
    (`vx: <id> exited with code <n> before the run stopped it`, item
    892). One that died while the graph still ran was also named at that
    moment (`vx: <id> exited with code <n> while the run went on`,
    #2152), so a dependant failing against it reads why. Read before the stop,
    so the SIGTERM's own 143 is never one; and on a stopped run (Ctrl-C,
    an embedder's abort) only the servers that had ended when the stop
    landed count, since the stop's own teardown kills the rest before
    this runs (item 1061). The pin after the
    summary lists only the kept servers still up (`hasEnded`).
    The foreground then blocks until ONE kept-alive server exits, tears
    the others down the same way (`terminateChildren`, signals.md) and
    returns `ok && exit === 0` — a crashed dev server fails the run.
    Such a run's history is written after that wait, through a fresh
    writing `Cache` handle on the cache directory, so `vx last` and the
    flaky list see the server's failure; an index another vx version
    reset during the session is reset back silently, as a run's open does.
    Its telemetry summary (step 14) waits for that verdict too, after the
    plugins' teardown, so a sink (vx-ci's job summary) reads the failure.
    Under `RunHandoff.holdPersistent` (the watch loop) every server is
    kept, a dependency-only one too (but one with no `inputs.files`), and run() returns at
    once with the kept tasks on `RunSummary.persistent` (`holdServers`): the caller
    owns them and its `stop()` is the same teardown. One that dies on
    its own after that is named (`vx: <id> exited with code <n>`,
    #2442), so a watch loop idling over a dead server says so; the
    teardown its `stop()` runs is not. `RunHandoff.keep` hands such a
    hand-back to the next run: each server still up whose node is in its
    graph with the same resolved config (`serverConfig`), and for a
    dependency-only one (`keyedServers`) the same key, is reported
    ready when its task is reached, without a spawn, and its output cell
    is pointed at the new run's bus; the others are stopped before the
    run lock (`takeHeldServers`). A taken server leaves the earlier
    hand-back: its `stop()` and exit notice skip it. A server outlives
    the runs that keep it, so each listens on its exit once
    (`onServerExit`: a later run's listener replaces the earlier one's),
    and a stopped hand-back lets go of its run: each cycle kept every
    earlier cycle's run reachable through `keep` (`held-persistent.test.ts`).
    `RunOptions.signal` aborts a run from outside through the same
    teardown: the scheduler dispatches nothing further (never-started
    tasks complete `aborted`) and run() returns to its caller.
11. **Summary.** `formatPersistentList` rows for kept-alive tasks,
    `formatOutcomeTable` when `summaryTable` (`--verbosity 1`),
    then `formatRunSummary(list, totalMs, colors, runContext)` — the
    footer carries the run banner (wordmark rule + projects/tasks/
    cache meters + info + time).
12. **Optional artifacts.** `writeRunProfile` (`--profile`).
    Errors logged, exit code unchanged.
13. **`assembleRunRecords` → `runHistory(cache).recordRunBundle`**
    (`run-records.ts`). One pass over the outcomes builds the `runs`
    rows (one per real task; group + `aborted` skipped), the
    `invocations` header row (command, policy, git/CI/host context,
    counts) and, only when a sink is active, the per-task
    telemetry mirror — so all three carry the same task count by
    construction. Written in one transaction.
14. **Telemetry summary.** When a sink is active: build + emit the
    `RunSummaryRecord`, await `flush()` (crash-isolated). A foreground
    run holding a requested server does this after the wait (step 16).
15. **Drain + close.** Await background prefetches, uploads and the
    run bytes `RunKeeper` (`run-report.ts`) sent as each task ended,
    then `reportOf` builds the `RunReport` plugin teardowns read;
    `cache.close()`, sandbox teardown.
16. **Keep-alive block.** If the user requested a persistent task,
    block on its exit AFTER everything above (`sessionEnd` picks the
    exit that ends the session) — Ctrl-C reaps the process group; the
    run stays in the foreground on purpose.

`planRun()` mirrors steps 1–3 via the same `prepareRun`, then
delegates to `orchestrator/plan.ts:plan(...)` inside a try/finally
that closes the cache. No scheduler, no spawn, no SIGTERM, no
recording.

### Forwarded-args scoping

`RunOptions.forwardArgs` are appended to user-requested tasks only.
A `TaskNode.requested === true` task sees the forwarded args appended
to its `exec.command` AND folded into its cache key; a dep-pulled
task ignores them entirely. (`surfaced` is display-only and does NOT
receive forwardArgs.) This keeps `vx run build -- --watch` from
leaking `--watch` into every dep's build AND keeps upstream cache
identity stable across CLI args.

### Persistent registry

`persistentRegistry: Map<taskId, Bun.spawn>` is owned here. The
scheduler sees persistent tasks as instant successes that resolve at
"ready"; the registry is the single place to tear them down — except
requested ones, which the foreground run keeps alive and blocks on at
the very end (the dev server IS the point of the run).

### Signal shutdown

`run()` installs SIGINT + SIGTERM + SIGHUP handlers for its own
duration, from the run lock on (unless `RunOptions.handleSignals ===
false`), and removes them in a `finally`, so repeated `run()` calls
never stack listeners. A signal before the run's stop takes over (a
slow plugin setup) is held and replayed (`orchestrator.md`). On
signal: forward it (a SIGHUP as SIGTERM) to everything in
`liveChildren` + `persistentRegistry`, close the cache, and die of the
signal once the exit hooks have run (130 / 143 / 129 to the parent; a
run that handed a task the terminal exits with that code instead, so
Bun restores the terminal).
Children killed this way classify as `aborted`: counted in the task
total, not recorded. Watch mode passes `handleSignals: false`; the loop owns
signal disposition for its whole lifetime.

### Failure semantics

The orchestrator does NOT throw on task failure — the scheduler
already converts thrown errors into `failed` outcomes. The `ok` field
on the returned summary is `true` iff every outcome passes
(`isPassStatus`: `failed`, `skipped` and `aborted` do not) and no
persistent task crashed. CLI maps this to exit code 1. Setup throws (`UserError`
from discovery/loader/graph/plugin-setup) are caught at
`cli/run.ts:runCmd`. Before anything starts, `run()` and `planRun()`
refuse, as a `UserError` naming the option and what it must be, an
option the CLI would never pass: a number out of its bound (C-61), a
word outside its set (`continueMode`, `outputLogs`, `download`, `flow`),
a list that is not one of strings, an `excludeDependencies` that is
neither `'all'` nor names, a `signal` that is no `AbortSignal` (C-86).

### Tests

`tests/orchestrator.test.ts` — the heaviest test file in the repo:
runs, caching, cross-project graphs, forwarded args, failure
handling, persistent tasks, output cleaning, artifacts, boundary
enforcement, invocation + entry_inputs recording. Companions:
`tests/local-shortcircuit.test.ts`, `tests/orchestrator-remote.test.ts`,
`tests/telemetry.test.ts`, `tests/signal-handling.test.ts`,
`tests/output-flow.test.ts`.

### Replacing this module

To extend, you typically replace something downstream and leave this
module alone: a different scheduler consumes the same `runGraph`
signature; a different cache layering is a plugin `cache` capability;
telemetry is a plugin `telemetry` sink; a different execution venue
is a plugin `executor` (per task — the whole-run `backend` seam was
removed in 2026-08; the scheduler never leaves this process). Touch
`run.ts` itself only for new run-level
lifecycle steps.

### The run lock (`run-lock.ts`)

One run at a time per workspace, per machine. Two vx processes on one
workspace raced on every task's OUTPUT TREE (both clean and restore the
same `dist/`; a clean landing while the other run's restore is staging
takes its files out from under it, item 215), so `run()` takes the
workspace's lock before it opens the cache (`prepareRun`'s
`beforeOpen`) and releases it with its cache handle, before a
persistent task's wait. Before the cache, never after: a run that held
the store while it waited for the lock, and a `vx cache clean` that
holds the lock while it waits for every process with the store open,
waited on each other for ever, and a clear deleted the store under a
run opening it (`SQLiteError: disk I/O error`; `tests/run-lock-e2e.test.ts`
› "a run waiting for the lock holds neither the index nor the store
open"). The lock is keyed by the workspace root's real
path, so a symlinked spelling and the canonical cwd a CLI gets (macOS's
`/var` → `/private/var`) name one lock. It lives in this user's own
directory under the temp directory (`vx-runs-<uid>`, mode 0700; one that
is a link or another owner's is refused and the run goes on unlocked,
since a lock in the shared directory was anyone's to plant, L-47),
keyed by the resolved workspace root (`--cache-dir` does not
make two runs strangers; a read-only checkout can take it; two
processes whose `TMPDIR` differs hold two locks, item 970), and is a
directory HELD exactly while it is not empty. Its one entry,
`h-<pid>-<start>-<n>`, names the holder and is unique to that taking.
The lock is built beside its name and renamed onto it, which succeeds
only where the name is absent or an empty directory; it is left, or
reclaimed from a holder that died, by unlinking that one entry by
name — an unlink that cannot succeed on another taking's entry, so a
reclaim judged on one holder never removes the next one's lock — and
the emptied directory goes with a best-effort `rmdir`. It was a bare
`mkdir` then a `pid` file, left as an unlink then the rmdir and
reclaimed by `rm -r`: visible without its pid a moment each way, which a
waiter past its grace removed as abandoned, so four contending processes
held it two at once 22 times in four seconds and a release threw ENOENT
out of `run()` (item 759, `tests/run-lock.test.ts` › "contending
processes never hold it at once…", with holders that die holding it). A
second process polls every 50 ms, after a second says
`[vx] waiting for another vx run (pid N) on this workspace to finish…`
(`run()` passes it to `log.status` as `wait`: taking turns is no
warning; `tests/run-lock-e2e.test.ts` › "the waiting notice is a status
line…"), and reclaims a lock whose pid is gone. A signal exit is `process.exit`
(`signals.ts`), which runs no `finally`, so the process's `exit` event
also removes the entry this process still holds, synchronously: a
Ctrl-C left it for the next run to reclaim (item 848,
`tests/signal-handling.test.ts` › "a signal exit leaves no run-lock
entry behind"); a `kill -9` still does. The hook also removes a
staging directory this process made and has not yet renamed in: an exit
between the mkdir and the rename left it, randomly named, in the lock
root for good (`tests/run-lock.test.ts` › "an exit while the lock is
staged removes the staging directory"). A first signal no longer exits
there at all: the run hears signals from the lock on (`orchestrator.md`,
`holdSignals`). A pid comes back, too: the temp
directory outlives a container restart, and the restarted container's
vx got the dead run's pid (1) and waited for itself forever (nx#36473,
reproduced on vx 2026-09-24). So a lock naming this process's OWN pid
is stale (a run of this process shares the lock and never meets its
entry), and on Linux the entry also carries the holder's start time
(field 22 of `/proc/<pid>/stat`), so a live pid another process now
wears is stale as well. A holder procfs shows as a zombie (`Z`) is
stale too: a `kill -9`ed vx whose parent does not reap it (a
container's pid 1 that never waits) still answers signal 0 with its
start time unchanged, and the next run waited for the reaper, or for
good. A process inside a task of the run that holds the lock
(`VX_RUN_WORKSPACE` names the same lock) is refused rather than left
to wait for its own parent: `vx cache clean` in a task waited for good
(X-104). The start time is read once per process for its entry, and
`/proc/<pid>/stat` once per poll while waiting; elsewhere, where it
would cost a `ps` spawn per run, and under a procfs mounted for another
pid namespace (`util/procfs.ts`), the lock trusts the pid
(`tests/run-lock.test.ts`, `tests/run-lock-recycled.unsafe.test.ts`). A
`pid` file an older vx wrote is still read, waited for and reclaimed;
an older vx does not read the entry, so mixed versions exclude each
other only as far as the older one's lock did. A lock that cannot be
made, read or reclaimed for any reason but "held" (another user's lock
refuses this user's unlink) is a one-line warning and an unlocked run,
never a retry without the poll; when the reason is the temp directory itself (missing, a
file, not writable), the warning adds `point TMPDIR at a writable
directory`. Runs inside ONE process share the lock (a count; the last
release leaves it through the taker's entry): an embedder that runs two
at once coordinates them itself through `RunOptions.inflight`. Taking
and releasing costs five calls — the mkdir, the entry's write, the
rename, the unlink and the rmdir — with nothing read back: the unlink of
its own entry is the release's proof that no later run reclaimed the
lock (`tests/syscall-repeats.unsafe.test.ts`). `vx cache clean` (not
`--dry`) takes the same lock before it evicts: a prune beside a run
removed the artifacts the run had just probed as hits, whose
`accessed_at` bumps were not flushed yet (nx#36688). The run survives
that now (a vanished artifact is a miss), but only by re-running the
task.

### The run in progress (`run-live.ts`)

While it holds the run lock, a run answers on a unix socket beside it
(`liveSocketPath`), for `vx last --live` (2026-10-28): one request line,
`snapshot` or `follow`, then the snapshot as one JSON line; a follower
then gets each event until `run:done`. Nothing is written for it, and a
follower a megabyte behind is let go, so a stuck reader never holds the
run's memory. A signal exit leaves the path too, before the lock
(`tests/signal-handling.test.ts`).

## `src/orchestrator/options.ts` — RunOptions / RunSummary

### Purpose

The declaration home for the orchestrator's input/output types. They
live in a leaf file (not the module entry) so internals like
`prepare.ts` can import them without an upward import of the module's
`index.ts` — the entry must stay cycle-free.

### Public surface

```ts
export interface RunOptions {
  cwd: string
  tasks: readonly string[] // bare names and `pkg#task` specs
  projects?: string[] // the selection's project names; undefined = no scope needed
  affected?: AffectedChanges // --affected's diff: a bare task runs only when it reaches a seeded task (affected-tasks.md)
  concurrency?: number // run.concurrency: the flag, else VX_RUN_CONCURRENCY, else .vx/workspace (withRunSettings)
  cacheDir?: string // --cache-dir, resolved against cwd
  cache?: CachePolicy // --cache-policy / VX_CACHE_POLICY resolved; absent → the workspace's cache.policy, else FULL_CACHE_POLICY
  cacheFlags?: CacheFlags // with no `cache`: --no-cache / --force over the workspace's cache.policy
  cacheScope?: string // an embedder's scope, above VX_CACHE_SCOPE, a plugin's and the branch's
  outputLogs?: 'full' | 'errors-only' | 'none' | 'hash-only'
  download?: 'all' | 'toplevel' | 'none'
  downloadConcurrency?: number // cache.concurrency.download
  uploadConcurrency?: number // cache.concurrency.upload, per remote
  restoreConcurrency?: number // cache.concurrency.restore; twice concurrency unset
  flow?: 'focused' | 'broad'
  retries?: number // run.retries; a task's exec.retries beats it
  timeout?: number // run.timeout in ms; a task's exec.timeout beats it
  continueMode?: ContinueMode
  branch?: string // --branch; unset, VX_RUN_BRANCH, git's, then CI's
  schedule?: NonNullable<RunSettings['schedule']> // run.schedule
  excludeDependencies?: 'all' | readonly string[]
  forwardArgs?: readonly string[]
  footer?: boolean // false: no footer, live or printed, and no blank line opening the task log (vx watch)
  profile?: string
  handleSignals?: boolean
  signal?: AbortSignal
  tty?: boolean // vx's stdin is a terminal: each exec.interactive task is handed it, alone
  log?: Logger
  bus?: EventBus // an embedder's bus; the run's own when absent
  inflight?: Map<string, Promise<void>> // admission's cross-run in-flight table
  telemetrySinks?: readonly TelemetrySink[] // an embedder's sinks, ahead of the plugins'
  command?: string // the invocation as recorded (`vx run …`)
  remoteCache?: RemoteCacheLayer // an injected remote layer; wins over the cache seam
  artifactCeiling?: number // the 2 GiB artifact ceiling, lowered only by a test
}
// What only vx's own CLI hands run(): not on the façade's RunOptions.
export interface RunHandoff {
  staged?: ReadonlyMap<string, ProjectEntry> // the CLI's own selection load, reused once (below)
  discovered?: { root: string; projects: ProjectMeta[] } // the selection pass's discovery, reused once when the root matches
  selectedByDiff?: boolean // `projects` came from a git diff: bare names judged workspace-wide (item 1024)
  selectedOutright?: readonly string[] // projects a non-affected --filter named: their tasks run beside affected ones (X-10)
  affectedReasons?: Map<string, AffectedReason> // planRun (`--dry`) collects why `--affected` kept each request
  remoteRequested?: string // the setting whose spec named a remote axis ('--cache-policy')
  remoteReadOnlyByDefault?: boolean // the default policy writes no remote; the CLI passes it off CI
  summaryTable?: boolean // --verbosity 1: the per-task table, just above the footer
  holdPersistent?: boolean // hand every persistent task still running (a dependency-only one only with inputs.files) back on RunSummary.persistent
  watch?: boolean // a vx watch cycle: a save withheld over an input edited mid-run says the next cycle runs on it
  keep?: HeldPersistent // an earlier hand-back: a server still up whose task is unchanged stays up; the rest stop first
  commandWindows?: CommandWindows // where the run records when each command ran (and each restore or deferred fetch) and where it may write; vx watch passes its own to tell a user's mid-cycle write from the run's
}
// run()'s argument inside vx (runCore / planCore): the public options and the hand-off.
export interface CoreRunOptions extends RunOptions {
  handoff?: RunHandoff
}
export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
  persistent?: HeldPersistent // { ids, stop(), servers }: what holdPersistent handed back
  refused?: string // why the run refused to start (ok false, nothing ran); the caller prints it, vx run on stderr
}
```

`handoff.staged` is the CLI's own selection load handed to the run: a filter
that walks the graph (`app...`, `--affected` with a diff) stages every
config to read the `pkg#task` edges, and the run reuses those entries
instead of evaluating and staging them again (`loadProjects` seeds and
scopes exactly as before). One run only — `vx watch` deletes it from
the options it re-runs, since a cycle after an edit must load again.

`RunOptions` and `RunSummary` are re-exported by `orchestrator/index.ts`
(the module contract) and by the package façade `src/index.ts`;
`RunHandoff`, `CoreRunOptions`, `runCore` and `planCore` only by the
module, so the CLI's plumbing is no embedder's surface. See
[`orchestrator.md`](#srcorchestratorindexrunts--end-to-end-glue) for the full field-by-field
documentation — this page exists to map the file, the types are
documented with their consumer.

### What it does NOT do

No logic, no defaults. Default resolution (`concurrency`, `cache`,
`handleSignals`) happens in `run.ts` at the use sites (`cache` defaults
to `FULL_CACHE_POLICY` — every read/write axis on).

## `src/orchestrator/execute-task.ts` — per-task runtime

### Purpose

The seam between the scheduler and the cache + runner. Given one
`TaskNode` and its upstream outcomes, decide what to do (group
short-circuit, persistent spawn, or normal cache-or-exec flow) and
return a `TaskOutcome` to the scheduler.

### Public surface

```ts
// What every task of a run shares: built once, shared by reference.
export interface RunContext {
  workspaceRoot: string
  cache: CacheLayer
  cachePolicy?: CachePolicy // 4-axis read/write control; undefined → everything on
  forwardArgs?: readonly string[]
  retries?: number // run-level retry default (run.retries); exec.retries wins
  keyedProjects: (node: TaskNode) => ReadonlySet<string> // orchestrator.md
  runStartHrTimeNs: bigint
  persistentRegistry?: Map<string, ReturnType<typeof Bun.spawn>>
  liveChildren?: Set<ReturnType<typeof Bun.spawn>> // run-scoped; the signal handler signals these
  track?: (taskId: string, pid: number) => () => void // TelemetrySource.track: samples each attempt's tree
  // … and the other optional run-wide fields (timeout, deferSave,
  // serverDiedUnder, leftRunning, fingerprintWatch, probesAfterWrites, …)
}

// One dispatch: the run it belongs to, plus this task's own facts.
export interface ExecuteArgs {
  run: RunContext
  node: TaskNode
  upstream: TaskOutcome[]
  log: Logger
  executor: TaskExecutor // where run.ts placed this task
  nestedProjectDirs: string[]
  // … and the optional per-task fields (preProbed, download,
  // taintedUpstream, noDependants, terminal, servers, …)
}

export function executeTask(args: ExecuteArgs): Promise<TaskOutcome>
// the probed hit executeTask would restore, as a thunk when its tree is current (`currentHit`)
export function settleProbedHit(args: ExecuteArgs): (() => TaskOutcome) | undefined
export { restoreHit, type RestoreHitArgs } from './hit-restore.js'
```

Cache-key derivation (`ComputeHashArgs`, `computeTaskHash`,
`computeGroupKey`) moved to `src/orchestrator/task-hash.ts` —
[`orchestrator.md`](#srcorchestratortask-hashts--cache-key-derivation).

### Three execution paths

#### A. Group task (no `exec`)

Return `{ status: 'success', exitCode: 0, durationMs: 0, hash }`, `hash`
being `computeGroupKey`'s. An unkeyed group takes `upfrontGroupKey`'s key
when the live upstream has its ids and keys in order, else
`computeGroupHash(upstream)`, synchronously; a keyed group awaits
`computeTaskHash`.
No spawn, no I/O. The hash is a stable rollup so downstream tasks
filtering `inputs.tasks` to include this group still invalidate when
anything beneath it changes.

#### B. Persistent task (`exec.persistent` set)

`executePersistentTask`, in `persistent-task.ts`. The env and timeout
both paths share are `taskEnv` and `taskTimeoutMs` in `task-process.ts`.

1. Build isolated env (same as normal — see [`exec.md`](./exec.md#srcexecenvts--child-process-env-builder)).
2. Construct `PersistentOptions` for `runPersistent`. The
   `forwardArgs` are appended in-line (`withForwardArgs`, as a one-shot
   task's are), with or without a `readyWhen`: a readyWhen server once
   got none, and `vx run dev -- --port 4000` dropped the port.
3. If the run's stop landed during the awaits before this (the key,
   the sandbox's arming, request and wrap), spawn nothing: release the
   bridges and placeholders and return `aborted` with the signal's exit.
   Spawned anyway, the server came up after the teardown, and a Ctrl-C
   took 7 s to end the run.
4. Call `runPersistent(opts)`. Stash the returned `child` in
   `persistentRegistry[node.id]`. Its `onReady` flushes what the
   secret mask and the open-line hold kept of the pre-ready text, then
   calls `serverReady`: run.ts holds the server's output from there
   until it has logged the task's outcome, so a renderer files every
   byte after the ready line as since-ready, never into the frame (the
   lines after the ready line, and what came before the outcome, were
   lost from a success row's view).
5. `await spawn.ready`. On reject (child exited before ready) →
   stop what its group left running (SIGTERM, grace, SIGKILL), then
   return `failed` with the captured streams.
6. On resolve → return `success` with `durationMs = spawn.readyMs()`,
   unless the run's stop has landed: a server that matched `readyWhen`
   only on the way down (a trap that prints the marker) is `aborted`,
   as a one-shot that exits 0 on the stop is, and is not registered.

The orchestrator SIGTERMs every registry entry at end-of-run. Never
caches. A readiness timeout returns once the server's process group is
gone (SIGTERM, grace, SIGKILL), not when its shell exits: `ready`
rejects only then (runner.md), and the group gets one SIGTERM. A second
one, sent here a turn after the runner's, killed a server with a
one-shot handler mid-cleanup.

#### C. Normal task

1. `computeTaskHash(...)` — see below, through `keyOf`: a throw is
   `KeyFailed`, a failed outcome marked `isKeyFailed` and no command run —
   unless the up-front pass
   already has the key: a `preProbed` hash, or an uncached task's
   `upfrontKey` (orchestrator.md; a persistent task takes it too).
2. `cleanArgs = { projectDir, outputs, nestedProjectDirs }` is
   prepared once.
3. **If caching is on**: `cache.get(hash)`.
   - Hit: `restoreHit` (`hit-restore.ts`, below) — `cleanOutputs(cleanArgs)`
     and `cache.restoreOutputs(hash, projectDir)` unless a proof shows
     the tree current → replay the stored output log (`hit.stdout`)
     through `log.taskStdout` / `log.taskStderr`, in order. Return a
     `cache-hit` (or `cache-hit-remote` if `hit.source === 'remote'`)
     outcome with `durationMs = performance.now() - cacheOpStart` —
     the user-perceived restore time.
   - A restore that throws `ArtifactVanishedError` (the artifact was
     removed after the probe: a `vx cache clean` in another shell,
     another workspace's retention on a shared cache directory) is a
     miss: one status line naming the task and the artifact, ending
     `— running it`, then step 4. A hit the
     up-front probe found (`preProbed`) may be restoring ahead of its
     deps, so it throws `RestoreDemoted` instead and the scheduler
     runs it once they are done (graph.md; admission drops the
     probe, so that dispatch probes afresh and misses).
   - Any other throw (a full disk, a path in the way, a link out of the
     project) is `RestoreFailed`: the task fails with that error, and
     every surface counts it as failed only, never a miss or a hit.
4. Miss-or-no-cache:
   - If the run's stop landed during the awaits before this (the key,
     the probe, the input description), return `aborted` with the
     signal's exit: no clean, no executor call. The first attempt wiped
     the last build and handed the executor a request after the stop.
   - If caching enabled, `cleanOutputs(cleanArgs)` first so a stale
     `dist/` doesn't survive into a fresh exec: it prunes only inside
     the declared trees, so a glob's root stays (B-49) and a directory
     above it or holding a literal output, which a sibling task may just
     have made to write into, stays too (inputs.md).
   - Build isolated env (`<projectDir>/node_modules/.bin`, then
     `<workspaceRoot>/node_modules/.bin`, prepended to PATH).
   - `timing.startNs = process.hrtime.bigint() - runStartHrTimeNs`.
   - The attempt builds an `ExecuteRequest` (command, env, capture,
     declared outputs, timeout, sandbox grants) and hands it to
     `args.executor` — the executor this task was PLACED on by `run.ts`
     before scheduling, so every attempt of a task runs in the same
     place. With no executor plugin declared that is the local floor —
     `runCommand` / `runSandboxed` exactly as before. The request's
     `signal`, which arms a plugin executor's `exec.timeout`, is made
     last, once the sandbox is armed: armed first, a 60 ms `echo` timed
     out unrun under the runtime's ~200 ms probe. A local request's
     signal carries no timeout: the runner times the task from its
     spawn, and a clock on the signal also timed the sandbox's wrap, so
     a wrap slower than the timeout failed and retried a task that never
     ran.
   - Up to `1 + (exec.retries ?? args.retries ?? 0)` attempts: a failed
     attempt (timeouts included, `aborted` NOT — a teardown breaks out
     immediately) re-cleans declared outputs and re-executes, with one
     `vx: retrying <id> (attempt <k>/<total>) after exit <code>` stderr
     line between attempts, which ends `after a timeout` instead when
     the attempt was killed by `timeout`, and
     `after <n> sandbox violation(s)` when the shell exited 0 and only
     a refusal failed it.
     A retried attempt's violation lines go into its own output, under
     `SANDBOX VIOLATIONS (<n>)` (the outcome's section is the last
     attempt's), so `vx last --log` keeps them. The final outcome (and the
     cached stdout) is the last attempt's, its `durationMs` every
     attempt's; `TaskOutcome.attempts.count` is
     set when > 1.
   - `timing.endNs = process.hrtime.bigint() - runStartHrTimeNs`.
5. **If exit 0 + caching enabled**: the key is re-checked
   (`keyStillTrue`, item 743): the key the describe re-derived before
   the command must equal it, no input may have moved since its
   fact (`movedInput`), and no input file may have been added since
   the listing (`described.added`, cache.md's `addedInput`). A move withholds the save, says so on the
   status line, and drops the project's facts as an uncached command
   does (every partition when the task declares workspace outputs,
   whose save would have marked them). Strategy `'unchecked'` skips the
   move check but still drops the facts where the command may write
   (`commandWriteReach`; every partition with workspace outputs), since
   a reader keyed after it reads them. A claimed root file (a lockfile) a
   task rewrote since the run read it withholds the save too (the run's
   `FingerprintWatch`, [`orchestrator.md`](#srcorchestratorfingerprint-watchts--has-a-task-rewritten-the-lockfile),
   item 750), and so does a server it depends on (through groups and servers too)
   that died while it ran (`serverDiedUnder`, run.ts: it seeds the
   run's taint, so what is built on it is not saved either), and so does
   an upstream that is a `remote: 'only'` no-op, directly or through
   others (`belowNoop`): its key names outputs that never landed. Otherwise `resolveOutputs(...)` →
   `cache.save({ hash, projectDir, outputFiles, entry })`.
   **If it ran here and saves nothing** — it failed, the policy writes
   nothing (`--cache-policy=local:r,remote:r`), an upstream failed or
   no-op'd, an upstream left a process running, a server died under it, the key no longer held — the same re-check runs (`movedInput`), and a move drops
   the project's facts; otherwise its declared outputs are resolved and
   marked in the git snapshot as a save marks them (`markUnsaved`). A
   same-run reader keyed from the snapshot's OIDs for either replayed
   the bytes from before the command (item 750). A deferred or
   remote-only task wrote nothing here and marks nothing, and nor does
   one nothing in the run depends on (`noDependants`, set by `run.ts`):
   no task is ordered after it to read what it wrote, and the output
   walk cost 1,000 read-only misses 1.62 → 1.78 s (min of 9).
6. Return outcome with hash, status (`success` / `failed`),
   exitCode, durationMs, hrtime spans, and
   (when Bun's resourceUsage returned them) `cpuMs` / `peakRssBytes` —
   the peak only when it rose above vx's own footprint (runner.md).

### The hit

A confirmed hit is materialised by `hit-restore.ts` (`restoreHit`):
the two proofs that let a current tree skip the restore, clean +
restore otherwise, the git marking, the stdout replay, the outcome.
Moved out on 2026-09-10 as pure code motion; re-exported from here.

### The save

An ADDITIVE task (`node.addsToOutputsOf`, item 588; only with
`run.rules.exclusiveOutputs: false`, X-53) is not cleaned by
glob before an attempt: its outputs are stamped once before the first
attempt (`stampOutputs`) and, after a 0 exit, its own set is what the
run added or changed against that stamp (`ownOutputsSince`), plus what
it found and left exactly as a save or restore of its own left it: a
row of any of the task's entries (`taskEntryHashes`) that
`isOutputsCurrent` holds current. An incremental emitter rewrites only
what changed, and without those its entry restored a tree a forced run
never leaves. The set is handed to
`saveMiss` as `ownOutputFiles` in place of the glob walk. Its
`workspaceFiles` get the same treatment (`stampWorkspaceOutputs`,
`ownWorkspaceOutputsSince`, `ownWsOutputFiles`; A-43). A run that removed a file
it found (a bundler deleting its upstream's intermediate) saves nothing:
an artifact holds what a run wrote, never what it took away, and the
upstream's restore puts the file back (X-32). Any task's run that removed
a committed file its clean left (`cleanOutputs`'s `kept`) saves nothing
for the same reason: no restore deletes a committed file, so no hit
replays the removal (2026-11-11). Before a retry, what the
failed attempt added against the stamp is removed by path
(`dropFailedAdditions`, `cleanOutputPaths`); a found file it changed or
removed cannot be put back, so that task saves nothing. No clean
deletes a committed file under the outputs either: when a retry can
follow, the first attempt's clean stamps them (`stampCommitted`), and a
retry's clean that finds one added, removed or touched
(`committedMoved`) withholds the pass's save the same way.

A process any attempt's shell left running (`ExecuteResult.leftRunning`)
withholds the save, a failed attempt's too: it may write into the
passing attempt's outputs. It is not killed, as a passing attempt's
is not. The first one also calls `RunContext.leftRunning` (run.ts: it
seeds the run's taint, so what is built on it is not saved either).

What a miss leaves behind — outputs resolved, artifact and rows saved,
output prefixes recorded, git snapshot marked — is
[`orchestrator.md`](#srcorchestratormiss-savets--what-a-miss-leaves-behind); `execute-task.ts` calls it under the
`exitCode === 0 && willSave` gate and keeps the deferred-download
branch beside it.

### The lazy probe

A task not probed up front asks the run's `FingerprintWatch` before its
`cache.get`: once a task rewrote a fingerprinted file, the key (which
folded the old digest) is not probed, and the task runs.

### What a command may have written

A task with no `cache: true` declares no outputs, so after its command
exits — pass or fail — and after a persistent task becomes ready, the
run drops the facts it holds about where `undeclaredWriteReach`
(`orchestrator.md`) says the task may have written: `'project'`
deletes the project's git snapshot and its index OIDs, the
workspace-wide partition;
`'workspace'` clears every partition. The next reader
re-enumerates (one `git ls-files`) and hashes by content. A task on a
remote executor wrote on its own disk and drops nothing (item 743:
turborepo#13788, `tests/undeclared-writes.test.ts`). Any task that
`mayWriteFingerprint` (`sandbox.md`) tells the run's
`FingerprintWatch` it ran, cached or not.

### Sandbox request

The `sandbox` half of the `ExecuteRequest` (grants, denials, the paths a
bind needs pre-created) is built by
[`sandbox.md`](./sandbox.md#srcsandboxrequestts--the-sandbox-half-of-a-request); `execute-task.ts` only
asks for it when the task declares `exec.sandbox`, passing the run's
keyed set for the task when it declares `cache`
([`orchestrator.md`](#srcorchestratorkeyed-projectsts--the-projects-a-key-answers-for)) and nothing otherwise (the
persistent path never does). A reported denial under a linked package
the request withheld gets one more line beside it
(`withheldLinkLine`): the package, where it is linked, and the ways to
key it (a `dependsOn` edge names the project id at the target, `projectAt`;
a target that is no project gets only the grant and `inputs.workspaceFiles`).
Before the executor is called, the key's files outside the project
(`inputs.workspaceFiles`, `outsideProject`) are held against the request
(`keyedOutsideGrants`, sandbox-runtime.md): a file no grant reaches is
not there inside the sandbox, so the command is not spawned and the
attempt's result (`unseenResult`) is one read violation per such
file and a line naming the grant (spelled by `sandboxFix`; none for a
credential file). Asked from the request, not a trace: a tool that stats
a config before opening it (oxlint) leaves no record, and a read past
the wall is no violation. A project file is left to the trace: an open
of it is a violation, and a key may hold one the task never reads.

A write refused at a per-run temp name (`bun build --compile`'s
`.<hex>-<n>.bun-build`, `bun pm pack`'s `.bun-pack.<hex>-<n>.tmp`) gets
no `sandboxFix` grant, which the next run's name would miss: the
outcome's violation lines gain a hint naming the
`ignore: { write: ['*.bun-build'] }` glob instead (`perRunWriteHint`).
A file refused at the project's top, which vx would make empty before
the next run for its literal grant, is granted `'.'` when the task's
`allow.read` lets it list the project: a pack read the empty file.
A write refused in an installed package's files or its store under the
project, which a directory above holds too, gets none: the tool took the
project for its root, missing a lockfile the sandbox hides, so the fix
names those lockfiles as reads and keys, and `misrootedWriteHint` says why.
A write refused in a dependency's declared outputs (the request's
`dependencyReads` and `dependencyReported`) gets none either: that
project's task writes them, and the runtime's note says so
(`upstreamWritesHint`).

### Verdict

A step that exits 127 or 126, or a persistent task that exits so
before or after it is ready (`persistent-task.ts`), gets one frame line from
`shell-verdict.ts` (`shellVerdict`), because the shell's own line names
the word and nothing about why. A bare word is a PATH lookup and the
PATH is vx's: the line names the word (`execWord`, the predicate
`execWrap` uses; for a compound command, the word the shell's own "not
found" line names in the step's stderr, else "a command in this task"), the two
bin directories `taskBinDirs` prepends, and that a sibling project's bin
is never on it; a bare word on 126 gets `chmod +x`. A word with a slash
is a file, and the file says why, under either code: missing (the
resolved path), a directory, not executable by this user, a `#!` line ending in CRLF
(the interpreter's name ends in `\r`), a `#!` interpreter that does not
exist, or no `#!` line at all (the loader refused a binary). For a
sandboxed task a file the host has under a denial no grant reads
(`sandboxReads`) is named as hidden by the sandbox: it is not there inside, and the
`#!` line was blamed (B-66). Probed
2026-09-16: dash and bash 5 exit 127 for a missing interpreter and
blame the file (bash 3.2 names the interpreter itself; macOS runs
tasks under dash since Q-2, so vx names it there too). An exit above 128
is a signal's number: a signal the runner saw (`RunResult.signal`) is
named as definite, a bare code (a pipeline's last command) as "a death
by SIGSEGV in the last command, or that command exited 139 itself", and
each signal carries what sends it — SIGKILL the OOM killer or a kill,
SIGSEGV/SIGBUS/SIGILL/SIGFPE a crash in native code, SIGABRT an
assertion or a JS runtime's heap limit, SIGPIPE a reader that left,
SIGXCPU/SIGXFSZ a ulimit, SIGSYS a seccomp filter or the sandbox, and
SIGINT/SIGTERM something outside vx (the task failed: the run was not
stopping, item 1100; it read nothing, while a pipeline's same 143 was
explained). No task that ends while the run is stopping gets a line,
since the stop's own SIGKILL past the grace read as the OOM killer's,
and a SIGINT/SIGTERM death waits a turn for a pending handler before
it is judged: a Ctrl-C reaches the task and vx together. A timed-out step gets no line either: its
own line names the timeout, and so does a spawn that threw
(`RunResult.spawnFailed`, A-41): no shell ran, so its 127 is vx's, and
`EMFILE` there is named with the `ulimit -n` to raise. Pinned in `tests/shell-verdict.test.ts` on real files and
end to end in `tests/tool-not-on-path.test.ts` and
`tests/signal-death.test.ts`.

### Hash derivation (`computeTaskHash`)

The pieces folded into `cache.key(...)`:

| Field            | Source                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskId`         | `node.id`                                                                                                                                                 |
| `taskConfigHash` | `xxh3(JSON.stringify(hashableConfig(node.config)))` (internal `hashTaskConfig`; the projection drops `exec.remote`, which is placement, not key material) |
| `envValues`      | `resolveInputs` reads host env for declared `inputs.env` names                                                                                            |
| `inputFiles`     | `resolveInputs` glob result (gitignore + boundary-filtered, sorted)                                                                                       |
| `upstreamHashes` | `filterUpstreamHashes(upstream, cfg.inputs?.tasks, ...)`                                                                                                  |
| `forwardArgs`    | `node.requested ? (args.forwardArgs ?? []) : []`                                                                                                          |

`forwardArgs` are scoped to user-requested tasks. The reason it's
folded into the key for those tasks: `vx run test -- --watch` should
not cache-hit a previous `vx run test`. The reason it's NOT folded
in for dep-pulled tasks: their cache identity is supposed to be
stable across CLI args.

### What this does NOT do

- Doesn't handle the run-level setup (workspace discovery, graph
  build, cache opening) — `orchestrator/run.ts` does.
- Doesn't drive the live console output — `log: Logger` does. This
  module just calls `log.taskStdout` / `log.taskStderr`.
- Doesn't record the analytics row — `orchestrator/run.ts` does after
  the run drains.
- Doesn't enforce `cache + persistent`-rejection — the project
  loader does at config-load time.

### Tests

Covered indirectly by `tests/orchestrator.test.ts`. Specific
behaviors with dedicated test cases:

- Group-task hash rollup (`tests/orchestrator.test.ts` — cascading
  invalidation through groups).
- Persistent task ready-then-success outcome shape.
- Cache-hit replay restores outputs AND replays log streams.
- Cache miss followed by cache write; subsequent hit returns from
  local.
- Forward-args isolation (dep-pulled task's hash doesn't drift).

### Replacing this module

This module is the seam most likely to grow over time. Plausible
extensions:

- **Input tracing is NOT one of them.** Recording reads during exec and
  using the observed set as the next run's inputs is a rejected
  approach (CLAUDE.md § Rejected): inputs stay declared and explicit.
  A task that wants its reads confined to the paths it declared asks
  for that with `exec.sandbox`, which enforces rather than infers.
  The user's grants derive NOTHING from `cache`: `inputs` says
  what invalidates a task, `exec.sandbox.allow` says what it may touch.
  Declaring `cache` only narrows core's own `node_modules` link grant to
  the packages the key answers for (`orchestrator.md`).
- **Conditional output capture.** Compress / dedupe before save.
  Hook between `resolveOutputs` and `cache.save`.
- **Pre-spawn hooks.** Run a setup script (e.g. cgroup/limits
  application) before each spawn: contribute an `executor` that runs
  them itself — no change to this module (`localExecutor()` is not on
  `@vzn/vx` to wrap).
- **Different cache layer.** Already abstracted via `CacheLayer` —
  the caller decides which.

## `src/orchestrator/keyed-projects.ts` — the projects a key answers for

### Purpose

K(T) in `docs/design/linked-sibling-reads-2026-09.md`: for a task, the
directories of every project whose files its cache key already moves
with. A sandboxed task that declares `cache` is granted a linked
workspace package through `node_modules` only when that package is in
this set (`sandbox/request.ts`); every other link inside the workspace
root is withheld, since an edit there would not re-run the task.

### Public surface

```ts
export function keyedProjects(
  nodes: ReadonlyMap<string, TaskNode>,
  keyOnly?: ReadonlyMap<string, TaskNode>,
): (node: TaskNode) => ReadonlySet<string>
export function readableDeps(
  nodes: ReadonlyMap<string, TaskNode>,
  keyOnly?: ReadonlyMap<string, TaskNode>,
): (node: TaskNode) => readonly TaskNode[]
export function nestedDirsOf(
  nodes: ReadonlyMap<string, TaskNode>,
  keyOnly: ReadonlyMap<string, TaskNode>,
  nestedDirsByProject: ReadonlyMap<string, readonly string[]>,
): (projectDir: string) => readonly string[]
```

`nestedDirsOf` is the projects nested in a keyed one, by its directory
(`RunContext.nestedDirsOf`): a task granted that linked package is
walled from them, since its key stops at a nested project
(`sandbox/request.ts`).

`readableDeps` is the one-step version for outputs: the exec tasks a
task's key folds directly, through a group to its members. A sandboxed
task may read their declared outputs (`dependencyReads`), since its key
moves with every file that made them.

The step the walk repeats is `foldedDeps` (`graph/folds.ts`): the
dependencies one task's key folds. `stable-keys.ts`' `probesAfterWrites`
and `vx lock`'s input-overlap rule ask it too.

Under `--exclude-dependencies` the walk folds what the key folds
(`keyUpstream`): a task's scheduled edges less its order-only ones, plus
its `excludedUpstream`, whose own dependencies it reads from `keyOnly`
(`PreparedRun.keyOnly`). A group's dedup stand-in lists the same members,
since its hash is taken over them: built from `deps`, two groups whose
dropped members differed shared one, and a keyed sibling was withheld.

`run.ts` builds one lookup per run and hands it to every task
(`RunContext.keyedProjects`); execute-task asks it only on the miss path
of a sandboxed task that declares `cache`.

### Rules

- **The fold relation is the hash path's, on the graph.** An exec task
  folds its dependencies as its own `inputs.tasks` selects them
  (absent means all), through `graph/folds.ts`'s
  `selectFoldedDeps` — the one copy of the matcher. A group folds every
  dependency. The walk is transitive.
- **Every exec task reached counts its project, cached or not.** Its
  key folds its own project's files through its `inputs`, and one with
  no `inputs` is keyless: a key that folds it is never stored or read. An
  unkeyed group counts nothing of its own; a keyed one (`inputs`) counts
  its project.
- **A persistent task counts as any task with no `cache`** (A-17): keyed
  on its `inputs`, or keyless.
- **The task itself is not counted**, and its own project is never
  granted through a link anyway (`sandbox/request.ts`).
- **Lazy and memoized by task id.** A run of hits asks nothing; a shared
  subgraph is walked once. The walk is a post-order on an explicit
  stack, since a fold is as deep as the graph (the builder takes
  50,000, item 737) and a recursion per edge overflowed the call stack.

### Cost

A warm run of hits never calls it. Measured 2026-09-24 on `vx-bench`'s
1,000-package workspace (`bun private/vx-bench/generate.ts <dir> 1000`:
3,000 nodes, 2,000 exec tasks), over the graph `prepareRun` builds,
min / median of 30, 4-core Xeon container:

| Shape                                            | Every exec task, fresh lookup | Worst task, fresh    |
| ------------------------------------------------ | ----------------------------- | -------------------- |
| the generator's (`build` a leaf)                 | 0.28 / 0.50 ms                | 0.001 ms (1 project) |
| deep (`build` → `^build`: closures span a third) | 18.4 / 28.0 ms                | 3.6 / 4.2 ms (334)   |

The first column is the bound for a run where every task is sandboxed,
cached and executes; the memo makes it the whole graph's walk, once.
`sandboxRequestFor` then realpaths the keyed directories: for the deep
worst task (334 of them, three real links) 1.36 / 1.69 ms against 0.25 /
0.36 ms uncached — beside a sandboxed spawn, which costs hundreds.

This repo's gate (`vx run ci --all`), interleaved against a worktree of
the previous commit, each arm in its own copy: cold (cache wiped), min of
3, 159 s before and 142 s after, every run green (the spread, 142–251 s,
is the suites' own); warm, min / median of 15, 0.49 / 0.59 s before and
0.51 / 0.62 s after. The warm stage table is equal through `classify +
probe` (60 / 61 ms), `task hash` and `stable keys`; what differs lies in
`run graph`, which on a warm gate is `check.bun`, the one uncached
sandboxed task, and whose median favoured the after arm (462 ms, against 477).

### Tests

`tests/keyed-projects.test.ts`: the walk row by row on hand-built graphs
(R3, a 50,000-deep chain among them), and against the key itself (R4) — for each shape `run()` computes
the task's real hash, every other project is edited in turn, and the
hash must move for exactly the projects the set names on the live path,
and for at least them on the classify path.

## `src/orchestrator/miss-save.ts` — what a miss leaves behind

### Purpose

Once a cached task's command exited 0 and the task will save, one call
does everything a later hit depends on: resolve the declared outputs,
say so if they matched nothing, save the artifact with its output rows
and input-fingerprint rows in one transaction, record the whole-subtree
output prefixes the next hit's skip-restore reads, and mark the exact
written paths against the git snapshot so a same-project consumer
re-spawns git only when its globs can see them. Moved out of
`execute-task.ts` on 2026-09-09 as pure code motion.

**Stale-hit-critical.** A line changed here changes what a later run
replays under a green result; treat edits like `execute-task.ts` ones.

### Public surface

```ts
export interface OutputDirSnapshot {
  hash: string
  projectDir: string
  prefixes: readonly string[] // the whole-subtree output prefixes
  holds: (files: readonly string[], rows: ReadonlyArray<{ path: string }>) => boolean // the run-end walk's files are the entry's rows (item 1087)
}
export function entryHolds(
  node: TaskNode,
  takes: (rel: string) => boolean,
): (files: readonly string[], rows: ReadonlyArray<{ path: string }>) => boolean
export async function recordOutputDirSnapshots(
  cache: CacheLayer,
  snapshots: readonly OutputDirSnapshot[],
): Promise<void> // at run end: every entry's rows in one batch read, then the walks, 32 at a time

export interface SaveMissArgs {
  node: TaskNode
  hash: string
  cache: CacheLayer
  log: Logger
  workspaceRoot: string
  nestedProjectDirs: string[]
  gitFilesCache?: GitFilesCache | undefined
  outputs: readonly string[] // declared outputs.files
  wsOutputs: readonly string[] // declared outputs.workspaceFiles
  ownOutputFiles?: string[] | undefined // an ADDITIVE task's own set, in place of the glob walk (item 588)
  ownWsOutputFiles?: string[] | undefined // the same for `workspaceFiles` (A-43)
  captured: readonly TaskInputComponent[] // Tier-3 rows from the pre-exec describe
  command: string
  durationMs: number
  stdout: string
  cpuMs?: number | undefined // what the execution used — stored on the entry and the artifact's sidecar
  peakRssBytes?: number | undefined
  outputDirSnapshots?: OutputDirSnapshot[] | undefined // queued for run end when present
  deferSave?: ((save: () => Promise<void>, taskId: string) => Promise<boolean>) | undefined // the run's save lane; resolves when the save settles, true when it landed
  measure?: boolean | undefined // a telemetry sink listens: time the save, stat its artifact
  state?: StateStamps | undefined // the undeclared ignored files the miss stamped (below)
}
export interface SaveFacts {
  saveMs?: number // the save's own time (pack, write, index)
  artifactBytes?: number // the artifact it wrote
  outputBytes?: number // the files it saved, uncompressed: the row's `outputs` and runs.output_bytes
  saved?: true // the entry landed; the outcome's `saved` comes from here in a run
}
export function saveMiss(a: SaveMissArgs): Promise<{ landed: Promise<SaveFacts> }>

export type UnsavedArgs = Pick<
  SaveMissArgs,
  'node' | 'workspaceRoot' | 'nestedProjectDirs' | 'gitFilesCache' | 'outputs' | 'wsOutputs'
>
export function markUnsaved(a: UnsavedArgs): Promise<void>

// save-lane.ts
export interface SaveLane {
  defer(save: () => Promise<void>, taskId: string): Promise<boolean> // settles true when the entry landed, false on a failure
}
export function createSaveLane(
  cap: number,
  onError: (err: unknown, taskId: string) => void,
): SaveLane

// undeclared-state.ts
export type StateStamps = ReadonlyMap<string, string | undefined> // absolute path → lstat stamp before the command
export function stampUndeclaredState(args: {
  config: TaskConfig
  projectDir: string
  workspaceRoot: string
  nestedProjectDirs: readonly string[]
  gitFilesCache: GitFilesCache | undefined
  projectTasks: readonly TaskConfig[]
}): StateStamps // the ignored files `git status` listed in the project, neither input nor output; none when the task declares no outputs
export function stateChanged(stamps: StateStamps, projectDir: string): string[] // changed and still there, project-relative
export function stateLeft(stamps: StateStamps, projectDir: string): string[] // still there, project-relative
export function declareStateHint(rels: readonly string[], alongside?: string): string // the way out: declare them in outputs.files (of the task that writes them, when `alongside` ran with it)
```

`markUnsaved` is step 3 alone, for a miss that ran here and saves
nothing (it failed, the policy writes nothing, an upstream failed): its
outputs are resolved and marked exactly as a save's are. Before it, a
reader after such a task kept the snapshot's index OIDs for them and
restored the bytes from before the command (item 750).

### The save lane (2026-09-10)

The execution slot is CPU-shaped (`--concurrency`) and the save is not:
pack, write, rename and one index transaction, ~2.5 ms of mostly I/O per
one-file artifact against ~5 ms of execution on the 1,000-project bench.
So when the run passes `deferSave`, only the slot-bound half runs in the
slot — resolve the outputs, warn on an empty match, mark the git
snapshot (a same-project downstream task reads both) — and the pack +
write + index + snapshot request go to `save-lane.ts`: at most
`2 × concurrency` saves in flight (each pack holds an artifact's bytes),
drained by `run()` before the upload drain (the uploads are what the
saves queued) and the snapshot loop (which reads what the saves pushed).
A save that fails is a miss next time — the task's work ran, and a cache
error degrades to a miss like a remote one. A run says it once: the first
failure is `[vx] cache save failed: <task>: <why>`, and once the graph
ends one more line names the others (`[vx] cache save failed for 2 more
tasks: b#build, c#build`, five at most): a full disk failed every save
after the first the same way, a line each, naming no task. An
embedder that passes no lane gets the entry before the outcome, as
before. The one reader that must wait for the entry is admission's
in-flight join (a duplicate of the task in another run): `saveMiss`
returns the lane's `landed` promise, `execute-task` parks it in
`deferredSaves` by task id, and admission lifts its barrier on it —
the executor's own return is never held. Dependents wait on the same
promise (the scheduler's `settledOf`): their execute request carries
the upstream's output rows, which the save writes.

### Undeclared state (2026-11-12)

A git-ignored file in the task's project that is neither an input nor
an output survives the clean and is never restored by a hit; an
incremental tool keeps its state there (`tsc -b`'s
`tsconfig.tsbuildinfo` beside the tsconfig). With `dist/` cleaned and
the state still calling it built, tsc emitted only the changed file,
exited 0, and the partial `dist/` was saved. `execute-task` stamps such
files before the command (`stampUndeclaredState`: the run's one
`git status --ignored=matching` listing, a stat each, only where a save
on this disk follows). After a 0 exit, one the command changed (and a
sandbox let it write) withholds the save before `saveMiss`; here, outputs
that matched no files (or no wildcard glob matched) while one is still
there withhold it too: the tool read it as proof the outputs exist and
wrote nothing. Both lines name the files and say to declare them in
`outputs.files`. A file the command creates was not listed, so a first
build saves (`tests/undeclared-state.test.ts`). What is guarded is a
partial output, so a task that declares no outputs stamps nothing
(`eslint --cache`, `tsc --noEmit --incremental` rewrite their state every
run or edit), and a file any task of the project declares as its output
(`projectTasks`) is that task's, not state. A sibling running at the same
time may still write an undeclared one, and outside a sandbox that cannot
be told from the task's own write: the save is withheld anyway, and the
line names the sibling (`commandWindows.writerDuring`) and says to declare
the file in the outputs of the task that writes it.

### Order, and why it is the order

1. `resolveOutputs` / `resolveWorkspaceOutputs` — the files as they are
   NOW, after the command.
2. The empty-set warning (`outputs matched no files`) — a status
   line, once, on this miss; `outputs: []` is a deliberate cached no-op
   and says nothing. When only literal outputs matched and every
   wildcard glob matched nothing, the line names those globs and says a
   later hit restores only the literal files. When the task declares `exec.sandbox` and no
   `allow.write`, the line names that as the cause: its writes were
   refused (item 444; until 2026-10-02 a single-package workspace's
   mask took them unnoticed, and this line was the only signal). An
   output directory linked out of the project, or a `workspaceFiles` one
   out of the workspace, never gets here: the resolver refuses the task,
   naming the link (X-88, M-65).
3. `markOutputsChanged` / `markWorkspaceOutputsChanged` /
   `invalidateWorkspacePartition` — the git snapshot learns the exact
   paths, not "everything changed"; on a 1,000-package cold run that
   is one `git ls-files` spawn per project not made. The last two mask
   each other on the workspace partition: a consumer that read it
   before the producer wrote keys from an empty set with both gone, and
   a later run whose real set is empty hits that artifact
   (`stale-hit-memo.test.ts`, "written mid-run", item 637).
4. `cache.save` — entry, output rows and `entry_inputs` rows in one
   transaction; no exit code, because the contract accepts none and the
   caller's `exitCode === 0` gate is the invariant.
5. A snapshot request (`outputDirSnapshots`) — whole-subtree prefixes
   for the hit path's directory-mtime check, recorded at run end from
   the run's list; a caller with no list gets no snapshot (recording
   here fell inside the racy window and was always refused, item 637).

Not here: the deferred-download path (`--cache-download=none`), which saves
no artifact and registers a closure instead (`execute-task.ts`).

### Tests

`tests/cache*.test.ts`, `tests/output-*.test.ts`, the stale-hit pins
in `tests/execute-task*.test.ts`, and the git-marking pins in
`tests/miss-save-marks.test.ts`; the split itself is covered by the whole gate
passing unchanged.

## `src/orchestrator/lockfile-claim.ts` — the claimant's shell

### Purpose

What every lockfile plugin needs around its parser, for any ecosystem:
`bun.lock`, `Cargo.lock`, `uv.lock`, `go.sum`. A plugin that keys each
project on its own dependency closure claims the file
(`VxPlugin.fingerprint`), records one digest per project through
`vx lock` (`digests`), folds the recorded one through `key`, and answers
`--affected` by digesting both sides of a change. Only the parser differs
per lockfile; the memo, the per-run gate, the fallback for a project the
file does not list and the `--affected` diff are one implementation
here. `@vzn/vx-lockfile` (`bun()`, `pnpm()`, `npm()`, `yarn()`) is one
claimant; `private/vx-plugin-examples/fingerprint/uv.ts` claims
`uv.lock` in ~60 lines.

### Public surface

```ts
export interface LockfileClaimOptions<L = unknown> {
  readonly file: string // the lockfile's name at the workspace root
  // member dir → digest; `files` is extraFiles' content hashes ('' when absent; one there but unreadable refuses the key)
  readonly digest: (text: string, files: ReadonlyMap<string, string>) => ReadonlyMap<string, string>
  // root-relative files the lockfile names but does not pin (a patch, a path dependency)
  readonly extraFiles?: (text: string) => readonly string[]
  readonly version: number // the memo's identity; bump when `digest` folds differently
  readonly identity?: string // stands for the functions' text in the claimant; changes when they do
  readonly scope?: 'project' | 'workspace'
  readonly part?: string // the key part's name as `vx why` shows it under the plugin; default 'deps'
  // member dir → its links to other members, any JSON value, memoised beside the digests
  readonly links?: (text: string) => ReadonlyMap<string, L>
  // member dir → the dependency names it records, memoised beside the digests
  readonly recorded?: (text: string) => ReadonlyMap<string, readonly string[]>
}
export interface LockfileClaimHooks<L = unknown> {
  readonly fingerprint: FingerprintClaim
  key(task: TaskNode, ctx: KeyHookContext): Promise<Readonly<Record<string, string>> | undefined>
  // the file's links now, through the memo; undefined without the file
  links(ctx: {
    workspaceRoot: string
    cacheDir: string
  }): Promise<ReadonlyMap<string, L> | undefined>
  // the file's recorded names now, through the memo; undefined without the file or `recorded`
  recorded(ctx: {
    workspaceRoot: string
    cacheDir: string
  }): Promise<ReadonlyMap<string, ReadonlySet<string>> | undefined>
}
export function lockfileClaim<L = unknown>(options: LockfileClaimOptions<L>): LockfileClaimHooks<L>

// an extra file's content hash ('' when absent; a directory: every file under
// it but node_modules and .git), read once per run through `hashes`
export function hashExtra(workspaceRoot: string, rel: string, hashes?: ExtraHashes): Promise<string>
export type ExtraHashes = Map<string, Promise<string>> // absolute path → hash, one run's
// `ctx` carrying the run's hashes (a spread of it keeps them); core makes its
// discover, project, key and fingerprint contexts so
export function withExtraHashes<T extends object>(ctx: T, hashes: ExtraHashes | undefined): T
export function extraHashesOf(ctx: object): ExtraHashes | undefined

export interface ReachGraph {
  readonly material: readonly string[] // one per node
  readonly edges: ReadonlyArray<readonly number[]> // node → the nodes it reaches directly
}
export function reachDigests(g: ReachGraph): string[]
```

A plugin spreads `fingerprint` and `key` into `definePlugin(import.meta, …)`;
`links` and `recorded` are no hooks, but what its own `discover` and `project` read.
All are on the `@vzn/vx` façade.

### Construction rules

- **A run's key never parses the lockfile.** `key` (project scope)
  answers the digest `vx lock` recorded in `.vx/dependencies.lock.json`
  (`ctx.locked(file)`, asked once per run), which core holds to the
  file's bytes ([`workspace.md`](./workspace.md#srcworkspacelockfilets--vxprojectslockjson), "A run's read"). Only
  when an extra file the record names moved since (a path dependency
  edited, no install) does the run digest, through the memo; `digests`
  (`vx lock`, `--affected`'s head side) and `affected` always do.
- **A run's read digests nothing.** `links` and `recorded` (a
  `discover` or `project` stage's reads) leave the digests out of a
  parse they pay, and out of the memo; `digests` parses again and keeps
  them. The digests are most of a parse.
- **Once per content.** The digests, and `links`' and `recorded`'s
  answers beside them, are memoised in cache.db (`lockfile_memos`, one
  row per file and claimant) by `version`, the claimant (its `part`, its
  `scope` and its functions' source, or the `identity` it gives for
  them: another claimant of the file at the same `version` does not read
  it, nor a workspace-scope memo a project-scope one) and the file's
  xxh3. A function's source is how its loader printed it, and one plugin
  prints two ways (from source under the compiled binary, from the
  workspace config's bytecode bundle), so a plugin gives `identity`, a
  hash of its own source. A warm run pays one read, one hash and one row
  read — never a parse. Core owns the row; a plugin passes parsers. Its
  readers (a `discover` hook, `--affected`'s selection) run before a run
  opens the index, so each read or write opens the index on its own, and
  only an index that exists with this vx's schema is read or written. A
  memo that cannot be written is a speed-up lost, not an error.
- **Once per run.** Core hands every `key` call of one run the same
  context object; under `scope: 'workspace'` a `WeakMap` on it makes the
  stat + read happen once per run, not once per task.
- **An extra file is hashed once per run.** Each discovery makes one
  `ExtraHashes` (`extraHashesOfDiscovery`), the contexts core hands a
  claim carry it (`withExtraHashes`), and every hash a claim takes goes
  through it. A run hashes before any task starts, so no task's write
  falls between; a `vx watch` cycle discovers, and hashes, afresh.
- **Once per process.** The file's size, mtime, ctime and inode gate the
  read within a process (a `vx watch` cycle): size and mtime alone keep
  the digests of a same-size file copied in with its mtime (`cp -p`). A
  file changed within the racy window of its read (50 ms, or its second
  where the file system keeps whole seconds) gates nothing. The content
  hash decides whether the digests are current.
- **Every project folds the root member's digest** beside its own (one
  xxh3 over both; the root project folds the root's alone). The root's
  dependencies reach every project (a workspace-wide tool, a shared
  toolchain): without it a root dependency bump moved no project's key
  and `--affected` selected nothing.
- **A project the file does not list** folds its nearest listed
  ancestor's digest, with the root's: it resolves that member's
  dependencies. Outside every member it folds the root's digest alone;
  a file with neither folds a constant.
- **`affected`** digests both sides and names the projects whose digest
  moved; a side that is absent (the file appeared or went) answers
  `undefined`, and so does `scope: 'workspace'`.
- **`digests`** answers each project's digest (its member's, or its
  nearest listed ancestor's, with the root's), the xxh3 of the file's
  bytes and the extra files the digests read, for `vx lock` to record;
  `scope: 'workspace'` and a missing file answer `undefined`.
- **`scope: 'workspace'`** folds the file's hash (with its extra
  files') into every task and never digests: the whole file, the
  coarsest key there is, read by the run itself, since `vx lock`
  records nothing for it. With `links` it still parses once per
  content.

`reachDigests` is a digest a parser may use: one hash per node over
everything the node reaches, Merkle-style, with the strongly connected
component as the unit (lockfiles carry cycles): iterative Tarjan,
children first, each component folding its members and its child
components' digests, both sorted. A member folds as its material AND the
materials its edges land on (a self-loop aside): every member shares the
component's digest, so a retarget between two members inside one cycle
must still move it. In a cycle, each member folds as a colour-refinement
label: its material and the child digests its edges leave for, then its
in-cycle targets' labels until no two labels part further, so two
members swapping copies of one version still move it. A singleton folds
as its material and its targets', so an acyclic digest is stable.
O(nodes + edges).

**A file the lockfile names but does not pin.** A lockfile may record a
patch or a path dependency by path, never a hash of its content, so an
edit to it leaves the lockfile byte-identical while the install uses the
new bytes. `extraFiles` names such files; their content hashes reach
`digest` and join the memo's identity and the workspace-scope key. The
memo records the files and their hashes, so a warm run re-hashes the
files it names and parses only when one moved. The claim's `extraFiles`
names them to core, from the memo when it holds those bytes:
`--affected` asks on every diff. `--affected` hands a changed one in
`change.extras`, so `affected` digests both sides with its bytes.

A named path may be a directory. Its hash covers every file under it but
`node_modules` and `.git`, following links, and the in-process gate uses
that hash as the directory's identity, since a directory's stat does not
move when a file in it is edited. A path outside the root is read too: a
path dependency beside the checkout is what a task reads.

`--affected` sees an extra file move that git lists no change to: a
file git ignores inside such a directory, or a directory outside the
repository. Selection hashes each extra file the base's
`.vx/dependencies.lock.json` records for a claimed file and hands one
whose hash moved to `affected` in `change.extras`, so only the projects
reaching it are selected. The hashes are the run's
(`FingerprintClaims.hashExtra`): the key reads the same ones.

### What it does NOT do

- Know any lockfile format or ecosystem. The parser is the plugin's; the
  shell hands it text and stores what it returns.
- Fold a project's own manifest: core keys no package file; a plugin
  adds it to its projects' cached tasks as an input.
- Decide edges. `links` records what the lockfile links, in the plugin's
  own shape; turning that into `discover` entries is the plugin's.

### Tests

`tests/lockfile-claim.test.ts` — the key (the recorded digest, no read
and no parse), `links` (served from the memo in a new process, kept
under `scope: 'workspace'` and not read by a project-scope claimant, a
run's read digesting nothing and `vx lock`'s adding the digests), the
memo (served across instances, a planted memo is what `vx lock` records,
a changed file or version ignores it, the claimant's identity), the
in-process gate (one parse for two projects), the root folded into every
project and the root fallback, `scope: 'workspace'`, the `affected` diff
(a root move names every project), and `reachDigests`. A non-JS lockfile
(`uv.lock`) is claimed end to end in
`private/vx-plugin-examples/fingerprint/uv.test.ts`; the JS formats
are pinned in `packages/vx-lockfile/tests`.

## `src/orchestrator/hit-restore.ts` — what a hit leaves behind

### Purpose

A confirmed cache entry, materialised: decide whether the tree is
already current (the output-directory proof, then the per-file
fingerprint proof) and skip the restore when it is; otherwise restore the
artifact in place and then remove the outputs it does not hold (pruning
only inside the declared trees, so a sibling's fresh directory stays;
inputs.md); mark the exact changed paths
against the git snapshot so a same-project consumer need not re-spawn
git; replay the stored output, both streams in order; build the cache-hit outcome. Moved out
of `execute-task.ts` on 2026-09-10 as pure code motion — the mirror of
`miss-save.ts`.

There is ONE restore path. `executeCachedTask` (a hit found in flight)
and the local short-circuit (a stable hit restored ahead of its deps)
both call `restoreHit`, so the two cannot drift.

**Stale-hit-critical.** A line changed here changes which bytes a green
run replays; treat edits like `execute-task.ts` ones.

### Public surface

```ts
export interface RestoreHitArgs {
  args: ExecuteArgs
  hash: string
  hit: CacheEntry
  /** `performance.now()` when the probe started — restore time counts from here. */
  cacheOpStart: number
  /** ns offset from run start for the outcome's wallclock window. */
  taskStartNs: bigint
}
export function restoreHit(restore: RestoreHitArgs): Promise<TaskOutcome>
// the hit's outcome as a thunk when its tree is current with no walk and no await, else undefined
export function currentHit(restore: RestoreHitArgs): (() => TaskOutcome) | undefined
```

`restoreHit` asks `currentHit` first: a hit that declares no outputs,
or whose recorded output directories and stamped files are all as the
entry left them, replays and returns. The run's scheduler settles such a
restore-tier hit in place through `settleProbedHit` (graph.md,
`settleNow`), so a warm hit costs no dispatch and no promise. Anything
else (no rows, a moved directory, a workspace output) walks.

`execute-task.ts` re-exports `restoreHit` and its args, so the entry stays importable from
where it was.

### In place, never clean-then-restore

Each file is renamed over the one it replaces, unless it already holds
the entry's bytes (compared byte for byte for entries up to 4 MiB; then
only its mode and mtime are set, through a descriptor that refuses a
link) (archive.ts stages every
entry in the workspace's `.vx/tmp/<pid>-0/` first, never in an output
folder, a missing folder built whole there and renamed in once; a
target on another filesystem goes through a temp beside it,
and a file takes the group its directory gives new files (setgid on
Linux, any directory on macOS); ACLs are not copied, a restored
file gets the default ACL of `.vx/tmp/`), so a reader of the output tree never
finds a declared output missing or half-written (a tree entry's file
copied into a folder that stands excepted: caching.md § Storage
layout), and a restore that fails
before its renames (a full disk, a damaged entry) leaves the outputs it
found as they were. Only a found output that blocks a rename goes first:
a file where the entry needs a directory, or a file under a path the
entry holds as a file. The rest the entry does not hold goes once the
restore has landed. On macOS the comparison is case-folded: a rename onto
`out.txt` replaces `Out.txt`, and removing the found name would remove
the restored file. The clean used to run first: a reader polling a 64 MB
output while ten hits restored met ENOENT on 153,336 of 204,411 reads
(Growth's parity probe, 2026-10-16), and a full disk left no outputs at
all (`tests/restore-in-place.test.ts`, `tests/disk-full.unsafe.test.ts`).
Each run first removes the staging a killed run left, never a live
run's (`sweepStaging`, `tests/restore-staging.test.ts`).

### Additive tasks (item 588)

Only with `run.rules.exclusiveOutputs: false` (X-53); by default the graph
refuses an edge-ordered overlap. An ADDITIVE task
(`node.addsToOutputsOf`) is judged current by its
recorded rows alone and its restore rewrites exactly those rows, never
touching what its glob, which also selects the upstream's files it adds beside. An
upstream that dependants add to (`node.outputsAddedToBy`, dependants
outside the run included: `markOutsideAdditions`) drops the
strays their globs could have added before it judges its own tree — on
both halves, project and root-anchored (`overlapping-outputs.test.ts`
holds each, item 638) — and never a row it recorded; its restore still removes them — the dependant
restores or runs after it, by the edge.

### Since the split

- A hit on a task with no declared outputs touches no artifact: nothing
  to clean, nothing to restore, the outcome says `restored: false`.
- The directory snapshot behind the next hit's skip-restore is queued
  (`outputDirSnapshots`) and taken at run end, not inside the restore —
  a directory written microseconds ago sits in the snapshot's racy
  window — and artifact writes overlap across concurrent restores.
- The outcome carries what the producing execution used (`storedCpuMs`,
  `storedPeakRssBytes`), read from the entry the artifact's sidecar
  filled, so a fresh machine behind a remote cache has the number too.

### What it does NOT do

- Decide whether the entry is a hit: the probe (`cache.get`, or the
  up-front `preProbed` entry) happens before.
- Save anything: a hit writes no rows and no artifact. The miss path is
  `miss-save.ts`.
- Restore a `workspaceFiles` output through the directory proof: a
  root-anchored output can land anywhere, so the proof is skipped and
  the glob walk decides.

### Tests

`tests/execute-task.test.ts` (direct-drive `restoreHit` classification:
entry shapes a run cannot produce), `tests/stale-hit.test.ts` (the
proofs against a changed, deleted or rewritten output; a same-size
same-second rewrite), `tests/output-dirs.test.ts` (the directory
proof), `tests/local-shortcircuit.test.ts` (a restore-tier hit ahead of
its deps), `tests/orchestrator-run.test.ts` (restores, cleaning, stdout
replay end to end).

## `src/orchestrator/task-hash.ts` — cache-key derivation

### Purpose

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

### Public surface

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
  probesAfterWrites?: ReadonlySet<string> // orchestrator.md: these tasks' probes are answered per task (`runtimeScope`)
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
  `hashCache.folds` and a `filesToken` (cache.md: a partition of
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
  `added` runs cache.md's `addedInput` over the listings the key was
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
  user's write during a cycle from the run's own, `RunHandoff.commandWindows`) such a write is hashed and compared instead. Returns the
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

### Invariants

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

### Tests

`tests/task-hash.test.ts` and `tests/task-hash-derive.test.ts` (what
the key folds and how it cascades), `tests/orchestrator.test.ts`
(cache-hit / invalidation end to end) and `tests/plan-predict.test.ts`
(predicted keys match executed keys).

## `src/orchestrator/upstream.ts` — upstream selection

### Purpose

Answer two related questions about a task's dependencies, which are
NOT the same question:

1. **Which upstream hashes the cache key folds** — per the task's
   `inputs.tasks` declaration. The patterns share
   `util/dependency-spec.ts`'s parser; this module owns the filter
   semantics (`*` / `^*` / negation).
2. **Which real tasks are in the input closure** — what an
   input-shipping executor must place in the input root. That is the
   `dependsOn` closure with GROUP tasks expanded into what they stand
   for, and it is deliberately NOT filtered by `inputs.tasks`.

### Public surface

```ts
// The upstream a KEY reads: the live outcomes plus `node.excludedUpstream`
// (the keys of dependencies --exclude-dependencies dropped). The run, the
// plan and the up-front classify all go through it.
// `node.orderOnly` edges are left out: they order the run and fold into no key.
export function keyUpstream(node: TaskNode, upstream: TaskOutcome[]): TaskOutcome[]
// A dependency as a key reads it (only `node` and `hash` matter): the
// synthetic upstream the plan, the stable keys and the excluded-dependency
// keys fold.
export function keyedOutcome(node: TaskNode, hash: string | undefined): TaskOutcome

export function filterUpstreamHashes(
  upstream: TaskOutcome[],
  filter: readonly string[] | undefined,
  selfProjectName: string,
  selfTaskId: string,
  standIns?: StandIns, // the task's standInsOf; see selectFoldedDeps
): Array<[upstreamTaskId: string, hash: string]>

export function expandGroupUpstream(upstream: readonly TaskOutcome[]): TaskOutcome[]
```

`filterUpstreamHashes` returns the hash-deduped list of upstream
entries that pass the filter, each paired with the id of the first
task seen at that hash (for `entry_inputs` row naming — the id is
never folded). Order is the iteration order of the internal `Map` —
the caller of `cache.key` sorts before folding, so order doesn't
affect identity.

`selectFoldedDeps` (`graph/folds.ts`, with `keyedDeps`, `foldedDeps`
and `refuseFiltersThroughGroups`) is the selection itself, over nodes,
split out on 2026-09-24 so the sandbox's keyed set (`keyed-projects.ts`)
walks the graph through the SAME matcher the hash path applies, and
moved into the graph on 2026-10-16 so `vx lock`'s input-overlap rule
reads it too — one copy of the rule, so what the key folds and what the
sandbox and the lock believe it folds cannot drift. The hash path passes each upstream with its hash as the
unit; the graph walk passes a structural stand-in (a task's id, which
its key includes; a group's sorted member ids as `keyUpstream` reads them,
since two groups over the same members hash alike). A negation drops
only the upstreams it names, and the dedup runs after the last entry, so
a unit another selected upstream still carries stays folded:
`['^*', '!c#build']` dropped b#build's group with c#build's when both
grouped the same members, and a change beneath them replayed the old hit.

### Groups are transparent to the input closure

A group task has no `exec`, so it produces nothing and has no cache
entry: its hash is a synthetic roll-up (`computeGroupKey`). That is
correct for the KEY — a dependent cascades through the roll-up, and
anything changing beneath the group moves it. It is wrong for the
INPUT CLOSURE, where asking the local index what the group produced
returns an empty list.

Locally that is invisible: the members' outputs are already on disk,
put there by their own tasks. Remotely it is fatal — that list IS the
input root, so `dependsOn: ['install']` shipped a worker an action
containing none of what `install` chains.

`expandGroupUpstream` walks a group's `TaskOutcome.groupUpstream`
(set by the group's own execution, the only place that knows what it
chained), descending into nested groups on an explicit stack (a chain
of groups is as deep as the graph, and the builder takes 50,000; a
recursion per level threw `RangeError` into the consumer), expanding a
group reached along two paths once (a group `build` whose `^build`
meets a package diamond read its members once per path, doubling per
layer), and de-duplicating by task id.
The expansion is never folded: it reaches the executor as
`CacheKeyInput.upstreamGraft` → `TaskInputs.upstream`, while the key
still folds only the group's roll-up hash, so no existing entry moves.

### The key filter does not filter the input closure

`inputs.tasks` is an INVALIDATION statement — the schema defines
it as "which upstream tasks' cache keys participate in this task's
key". What a task may READ is `dependsOn`, and locally every
dependency's outputs are on disk before the command runs however the
filter is written.

So the closure is built from the unfiltered dependency set. Deriving
it from the filtered one instead would mean a task decoupled from an
upstream's key silently loses that upstream's BYTES when it runs
remotely, while behaving correctly on the machine that submitted it —
the same conflation as the group case, arrived at from the other side.
`tests/execute-task.test.ts` pins both directions: an upstream
excluded from the key is still in the closure, and a CONTROL that the
filter still decouples the key.

### Defaults

- **`filter === undefined`** → every upstream contributes
  (`[...].filter(u => u.hash).map(...)`). Most common.
- **`filter === []`** → empty result; fully decoupled task.

### Pattern semantics

| Form         | Matches                                        |
| ------------ | ---------------------------------------------- |
| `'*'`        | every same-project upstream                    |
| `'^*'`       | every dep-workspace upstream                   |
| `'name'`     | same-project task `name`                       |
| `'^name'`    | `name` task in any dep workspace               |
| `'pkg#name'` | specific package's `name` task                 |
| `'!<form>'`  | exclude — applies to whatever the form matches |

A `name` (and the package side of `pkg#name`) holding `*` is a
pattern (`isTaskPattern`): `'build.*'` is every same-project upstream
whose task name matches, `'^check.*'` the same in the dep workspaces,
`'@acme/*#build'` a package pattern — `*` is any characters, anchored.

**Last write wins.** Patterns are applied in order; a later include
re-adds a previously excluded hash; a later exclude removes a
previously included one. So `['*', '^*', '!^noisy']` reads
"all upstream, then drop deps' `noisy` task hashes".

### Error surface

Invalid spec strings are refused at load (`vx lock` too) by the
shared `parseDependencySpec`, naming the config, the task and
`inputs.tasks`; one a plugin's `graph` or `key` stage writes is
refused when the run plans, prefixed with the task id.

### Tests

`tests/orchestrator.test.ts` covers the cache-key delta cases for
`*` / `^*` / specific / `pkg#task` / `!form` / `[]` / undefined.
The pattern parser itself is tested in
`tests/task-graph.test.ts` (shared module).
`tests/execute-task.test.ts` pins group expansion end to end — a
dependent of a group receives the tasks beneath it WITH their output
lists, and a CONTROL asserts the dependent's cache key does not move
when the group carries members. `tests/upstream.test.ts` §
"expandGroupUpstream" holds the order, a 50,000-deep chain of groups,
and sixteen stacked diamonds reading each group's members once.

### What this does NOT do

- **Doesn't add tasks to the graph.** That's `graph/task-graph.ts`.
  This module filters which already-completed upstream outcomes'
  hashes are folded in.
- **Doesn't validate that filter entries reference real tasks.** A
  filter for `!ghost` is silently a no-op if no upstream task named
  `ghost` exists.

## `src/orchestrator/affected-tasks.ts` — the tasks `--affected` reaches

### Purpose

`--affected` selects tasks, not projects (2026-10-04). The diff
(`affectedChanges`, affected.md) seeds tasks:

- a group seeds nothing (it runs nothing), but for the default `build`;
- a task with no `inputs` seeds when a changed path lies in its project
  (`changes.paths`) or the project is reached whole, never only because
  another task of it declares a changed root file (`workspaceFiles`
  owners join `changes.projects` alone);
- a task with `inputs`, cached or not, seeds when a changed path is one of them
  (`declaresInput`, cache.md; an untracked path, `changes.untracked`,
  under its own outputs is none, as the key says), or its `workspaceFiles` may reach into a
  changed nested repository (`changes.nested`, `workspaceFilesReachInto`), or when its project is reached whole: the
  diff named it whole, a changed path is `package.json` or a `vx.config.*`,
  or no task of the project declares a changed path.

A requested bare task runs when its `dependsOn` closure holds a seeded
task, so a change reaches another project only along a task edge such as
`^build`. The default `build` (projects.ts) is the one keyed group: it
seeds as a cached task with `**` as input. A `^name` edge the graph
passes through a package it loaded no config for reaches it the same way:
any change there reaches the task. An anchored `pkg#task` always runs. `prepareRun` drops the rest
and returns `empty: 'none-affected'` when nothing is left. The closure
walk keeps its own stack, so a chain as deep as the builder takes
(50,000) is walked, where a recursion per edge threw `RangeError`.

A task's `workspaceFiles` is asked of every node, not only of the
changed projects' (whose owners the selection found from the staged
configs), so an input a `graph` hook gave it counts.

With a `graph` plugin the selection follows the FINAL graph: `prepareRun`
runs the hooks first, over every candidate (the CLI widens the
candidates to every project), asks `affectedRoots` of the edited nodes,
and prunes the graph to the `dependsOn` closure of the kept requests
plus what a hook added or marked requested; a request only a kept task
pulls in is demoted, as a rebuild from the kept requests would leave it.
Without one the graph is rebuilt from the kept requests and the hooks
run after. The hooks are `applyGraphStage` (`graph-stage.ts`), the run's
`graph` stage with its per-plugin config check.

`keptByAffected` is the rule both callers apply: a request survives when
the user named it, another include selected its project outright (X-10),
or `affectedRoots` reaches it. `affectedTaskProjects` is `vx show <task>
--affected`'s question asked the run's way: the candidates' graph, the
`graph` stage when a plugin has one, then `keptByAffected`, with no cache
opened and no key derived, so the list is the projects the run keeps
(X-147).

Given an `AffectedExplain` (`planRun` passes one as `RunHandoff.affectedReasons`),
both record why each kept request survived: the seed's changed file or
package, and the `dependsOn` chain that carried it. Without one no map
is filled and the walk does what it did.

### Public surface

```ts
export function affectedRoots(
  nodes: ReadonlyMap<string, TaskNode>,
  ids: readonly string[], // requested task ids, in order
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
  packageGraph: PackageGraph, // the `^name` walk, for the packages it passes through
  workspaceRoot: string, // a reason's project-relative file, an untracked path's own outputs
  explain?: AffectedExplain, // `--dry` only: fills each kept id's reason
  byKeys?: boolean, // a changed path no task declares reaches no task
): string[] // the ids whose closure the change reaches

export interface AffectedReason {
  kind: 'input' | 'project' | 'workspace' | 'package' | 'named' | 'selected'
  file?: string // workspace-relative
  project?: string // the changed package, kind `package`
  via?: string[] // the `dependsOn` chain, nearest first, to the seeded task
  wide?: true // `workspace`: the file reached every project; the text label's, never on the JSON wire
}

export interface AffectedExplain {
  reasons: Map<string, AffectedReason>
}

export function keptByAffected<R extends { project: string; task: string }>(
  nodes: ReadonlyMap<string, TaskNode>,
  requested: readonly R[],
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
  packageGraph: PackageGraph,
  workspaceRoot: string,
  keep?: { named?: ReadonlySet<string>; outright?: ReadonlySet<string> },
  explain?: AffectedExplain,
): R[] // the requests `--affected` keeps, in order

export async function affectedTaskProjects(args: {
  task: string
  candidates: readonly string[] // the projects the filters selected
  changes: AffectedChanges
  outright?: readonly string[] | undefined
  projects: Map<string, ProjectEntry>
  packageGraph: PackageGraph
  projectMetas: readonly ProjectMeta[]
  plugins: readonly VxPlugin[]
  workspaceRoot: string
  cacheDir: string
  rules?: WorkspaceRules | undefined
  warn: (message: string) => void
}): Promise<string[]> // the projects whose `task` the run keeps

export async function applyGraphStage(
  plugins: readonly VxPlugin[],
  nodes: Map<string, TaskNode>, // edited in place
  args: {
    workspaceRoot: string
    cacheDir: string
    projectMetas: readonly ProjectMeta[]
    warn: (message: string) => void
    rules?: GraphRules | undefined
  },
): Promise<void>
```

## `src/orchestrator/excluded-keys.ts` — keying a dependency that does not run

### Purpose

`--exclude-dependencies` changes what RUNS, never what a key is. The
dependant's key folds its dependencies' keys (`caching.md` step 8),
and before 2026-09-24 dropping the edge dropped the fold with it: the
dependant keyed on nothing of the dependency, so it missed for no
reason, and once the dependency changed it hit an entry built against
the old one (nx#35234, reproduced on vx: `app#build` replayed `L1`
while `lib/dist` held `L2`).

`excludeDependencies` (graph) takes the edges out of the schedule and
returns the dropped tasks with their `deps` intact. This module derives
each one's key without running it and sets it on the dependant as
`TaskNode.excludedUpstream`, which `keyUpstream` (`orchestrator.md`) folds
next to the live outcomes at every key site.

### Public surface

```ts
export interface KeyExcludedArgs {
  nodes: Map<string, TaskNode> // the scheduled graph
  keyOnly: ReadonlyMap<string, TaskNode>
  dropped: ReadonlyMap<string, readonly string[]>
  cache: CacheLayer
  workspaceRoot: string
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: ReadonlyMap<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
}
export async function keyExcludedDependencies(args: KeyExcludedArgs): Promise<void>

export function excludedTaint(nodes: ReadonlyMap<string, TaskNode>): {
  seeds: ReadonlySet<string> // tasks whose key folds a dropped dependency's key
  unsaved: number // cacheable tasks the taint reaches, for the run's one line
}
```

`keyExcludedDependencies` runs in `prepareRun`, after the `graph` and
`key` stages have seen the whole graph (so a dropped task carries the
same plugin key material a full run gives it). Keys are derived over
the whole graph as it stands at the start of the run, once per task: a
dropped task's own dependencies, scheduled or not, fold theirs, and a
scheduled task that is itself a dropped dependency folds what IT lost.
A persistent task is keyed as a task with no `cache` (on its `inputs`,
or keyless), as on the live path; a group rolls its members up (`computeGroupKey`).

The walk is a post-order on an explicit stack: each task's key promise
is made after its dependencies' promises exist, so nothing recurses
once per edge, and the keys still resolve concurrently. A dropped chain
is as deep as the graph, and the graph builder takes 50,000 (item 737);
keying one by recursion overflowed the call stack. `excludedTaint`
walks the dependant edges once from its seeds for the same reason: a
fixpoint that re-scanned every node per hop was quadratic on a chain
seeded at its bottom (100 s at 50,000).

### Why the dependant does not save

Folding the key makes the dependant's entry claim "built against that
dependency at its current inputs". The dependency did not run, so its
outputs on disk may predate those inputs, and a save would file stale
bytes under the key the next full run derives — a stale hit that run
would replay. `excludedTaint` names the tasks whose key folds a
dropped key (a group folds all of its dependencies; an exec task what
its `inputs.tasks` selects), `run()` seeds the taint tracker with
them (`orchestrator.md`), and the save is withheld for them and everything
built on them. A read is still correct: an entry under the full key was
built by a run whose dependency matched it. A task with
`inputs.tasks: []` folds none and saves as usual. `run()` says
once how many cacheable tasks the taint reaches; a persistent task or
one with no `cache` saves nothing anyway and makes no line.

### Tests

`tests/exclude-dependencies-key.test.ts` › "--exclude-dependencies keys on the
dependency it skips": the dependant's key is the same with and without
the flag, and it hits; a change to the dependency is a miss; a lazily
keyed dependant (one waiting on a same-project producer) folds it too;
a requested dependency that lost an edge itself is keyed on what it
lost; a dependency two hops below the dropped one reaches the key
through it (its key must exist before the dropped one's is derived);
and what a run builds on an out-of-date dropped dependency, or on a
group that dropped one, is not saved. `tests/local-shortcircuit.test.ts`
› "restore-tier dependent reports cache-hit even when its dep FAILS" is
the `tasks: []` control: excluded, it still saves.
`tests/prepare-run.test.ts` keys a 50,000-deep dropped chain and holds
the typo refusal under the flag; `tests/taint-tracker.test.ts` ›
"excludedTaint" counts a 50,000-deep chain seeded at its bottom.

### What this does NOT do

- Verify a dropped dependency's outputs against its key. Proving a tree
  current is `hit-restore.ts`'s job on a hit; here the conservative
  answer (no save) costs one re-run on the next full run.
- Hide the dropped dependency from an executor. `excludedUpstream`
  reaches the executor with the live upstream, so an input-shipping
  executor's `TaskInputs.upstream` lists it with the key a full run
  derives and whatever outputs the local index records under that key.
  The no-save rule is core's (`taintedUpstream` withholds core's save);
  an executor that keeps its own record of executions under the cache
  key is not told, the same as for `--continue=always`'s taint.
- Hide the dropped tasks from plugins. The `graph` and `key` stages see
  the whole graph, as a full run shows it; only the `schedule` stage
  and later see the narrowed one.

## `src/orchestrator/plan.ts` — `--dry` planning

### Purpose

Walk the task graph, compute every task's cache key, and probe the
cache to predict what `vx run` would do — _without executing_. Drives
the `--dry` and `--dry=json` output formats.

### Public surface

```ts
export type CacheStatus =
  | 'hit-local' // entry exists locally
  | 'hit-remote' // remote layer has it (would be fetched)
  | 'miss' // caching enabled but no entry
  | 'no-cache' // task opts out (no `cache: true`) or --no-cache
  | 'group' // no `exec`; aggregator only
  | 'not-started' // a server every dependant of which restores early: never spawned

export interface PlannedTask {
  node: TaskNode
  hash: string
  cacheStatus: CacheStatus
  deps: readonly string[]
  p50Ms?: number // typical duration from history, on a task that would run
  executor?: string // the executor's name, when the workspace declared a choice
  download?: 'deferred' // outputs would stay remote (`--cache-download`)
  remoteBytes?: number // what restoring its remote hit downloads, when the remote sized it
  affected?: AffectedReason // why `--affected` kept this requested task (affected-tasks.md)
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string } // a `skipped` task's own platforms, and this machine's
  blockedBy?: string // a `skipped` task's root: the task off this machine's platform it depends on
}

export interface PlanPrediction {
  wallMs: number // critical path over the would-run tasks' p50s
  workMs: number // their sum
  unknownCount: number // would-run tasks with no history
  criticalPath: string[] // would-run tasks with history on the wallMs chain
}

export interface RunPlan {
  tasks: PlannedTask[]
  predicted?: PlanPrediction // present when history gave something to say
  unresolvedTasks?: readonly string[] // requested specs that matched no project — an abandoned plan
  unresolvedHint?: string // what `vx run` appends to that refusal: the nearest names, or how to declare one
  noneAffected?: string // `--affected` left nothing to run: the line the run prints, and why
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
}

export interface PlanArgs {
  nodes: Map<string, TaskNode>
  downloadOf?: (id: string) => 'eager' | 'deferred' | 'never' | undefined
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
  workspaceRoot: string
  cache: CacheLayer
  cachePolicy?: CachePolicy // a no-read policy predicts misses
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache?: GitFilesCache
  hashCache?: HashCache // the run's memo — the same keys the run would derive
  history?: HistoryProvider // p50s and the prediction; absent, no footer
  executorOf?: (id: string) => string | undefined // placement labels (`orchestrator.md`)
  restorable?: ReadonlySet<string> // what the run would restore ahead of its deps on a local hit
  otherPlatform?: ReadonlyMap<string, readonly string[]> // tasks `exec.platforms` leave this machine out of, each → its platforms
}

export async function plan(args: PlanArgs): Promise<RunPlan>
```

### Algorithm

Piggybacks on `runGraph` with `concurrency: 1` and a planning
`execute` closure:

1. For each node in topo order, compute the same cache key the real
   run would (`computeTaskHash` for normal tasks, `computeGroupKey`
   for groups), through the run's `hashCache` memo.
2. Probe `cache.has(hash)` — a presence check, never a fetch:
   `'local'` → `'hit-local'`, `'remote'` → `'hit-remote'`, nothing →
   `'miss'`. Prediction keys off READS: a no-read policy predicts
   without probing, `'miss'` when it still writes (`--force`). The
   keys are probed after the walk: `remoteHasMany` once for all of
   them, then `has` for each, `networkConcurrency()` at a time, so a
   remote that cannot batch, or whose batch failed, costs one
   round-trip (or timeout) for the plan, not one per key
   (`tests/dry-remote-failfast.test.ts`).
3. Group tasks short-circuit to `'group'`. A persistent task is keyed
   as on the live path and reads `'no-cache'`; the plan and the run must
   key it alike, or `--dry` calls its dependants misses under a key the
   run never looks up (item 766, `tests/stale-hit-git.test.ts` › "`--dry`
   calls a dependant of a persistent task by the key the run uses").
4. Tasks with no `cache: true` OR a policy that reads and writes
   nothing (`--no-cache`, `--cache-policy=local:`) → `'no-cache'`:
   `ranNoCache` (`events.ts`), the predicate every run surface labels by,
   so the plan and the run agree.
   A server the run would leave idle (`idleServers`: not requested, and
   every dependant a `restorable` hit, local or remote, through unrequested groups and servers) → `'not-started'`; `planRun`
   fills `restorable` by the run's own gates (`shouldShortCircuit`,
   stable keys, `restoreTierExclusions`) only when a server could idle
   (WD-17).
5. With a `history`, attach each would-run task's p50 and predict the
   run (a task labelled `noop` does not run: the run skips a remote-only
   task no remote executor takes) (`predicted`: the critical path's wall time, the work sum, the
   tasks without history); a broken history read fails open — the
   plan stands without the footer.
6. Attach the executor label (`executorOf`) and the download mode
   (`downloadOf`) each task would get, and the gate's downgrades.
7. Return a `RunPlan` with one `PlannedTask` per node, preserving the
   `TaskNode.deps` graph for downstream rendering.

### Side effects

None: `cache.has` bumps nothing (the `accessed_at` column moves on a
fetch, which a plan never makes), no spawn, no `cleanOutputs`, no
`restoreOutputs`. With no remote to probe, `planRun` opens the local
cache to read only (`prepareRunLocked`'s `planning`, `Cache` mode
`'preview'`): no cache directory, index, `.gitignore` or file-hash memo
row is made, and an index of another schema reads as the empty one the
run's reset leaves (`tests/dry-no-writes.test.ts`). The one write: with a
remote, the hits its probe finds are kept in the index (made for them if
need be), so the `vx run` that follows GETs them before its own probe
answers (`tests/orchestrator-remote.test.ts` › "plan then run").

### Why concurrency: 1

Planning is fast (no spawn, just a hash + DB lookup) and sequential
is easier to reason about. Topological ordering is what the
underlying `runGraph` provides; we keep it. Parallel planning could
shave milliseconds; not worth the complexity.

### Tests

`tests/plan-format.test.ts` covers the formatters consuming
`RunPlan`; `tests/plan-predict.test.ts` the p50s, the prediction and
that predicted keys are the executed keys; `tests/orchestrator.test.ts`
covers `planRun` end-to-end (workspace discovery + graph + planner).
Specific cases:

- `--no-cache` flips every task to `'no-cache'`.
- Local cache hit predicted correctly after a real run.
- Remote hit prediction (LayeredCache + remote stub).
- Group task status.
- Empty plan when no projects declare the task.

### Replacing this module

This is a thin wrapper around `computeTaskHash` + `cache.has`, plus
the history, placement and download decorations. A richer plan
extends `PlannedTask` and the formatters (`cli.md`) together;
the JSON form enumerates its fields, so a new one is not on the wire
until it is added there.

## `src/orchestrator/placement.ts` — where each task runs

### Purpose

The placement of a task graph over the resolved executors, and the
plan-mode view of it. Split from `run.ts` on 2026-09-10 (pure motion):
`run()` decides what to run and in what order; this module decides
where each task lands, and `--dry` asks it the same question without
running anything.

### Public surface

```ts
export function pinnedLocalSet(
  nodes: Map<string, TaskNode>,
  sandbox?: boolean,
  servers?: boolean,
  runtime?: boolean, // false for a `runtime` executor
  exclusive?: boolean, // an `exclusive` executor: nothing pins, servers included
): Set<string>
// the exec.interactive tasks when `tty`, else none; throws UserError when two would read the keys at once
export function terminalHolders(nodes: Map<string, TaskNode>, tty: boolean): Set<string>

export interface Placements {
  executors: Map<string, TaskExecutor> // every placed task → the executor that took it
  remoteOnlyNoop: Set<string> // `remote: 'only'` tasks no remote executor took
  belowNoop: Set<string> // tasks that depend on one of those, directly or through others: none saves
  remoteOnly: Set<string> // `remote: 'only'` tasks a remote executor took
  servers: Map<string, TaskNode[]> // task on a `servers` executor → the persistent tasks it starts there
  carried: Set<string> // persistent tasks every dependant carries: never started here
  otherPlatform: Map<string, readonly string[]> // placed here, `exec.platforms` leave this machine out → its platforms
  unroutable: Map<string, readonly string[]> // of those, ones a routing executor could not take → platforms on offer
}
export function placeTasks(
  nodes: Map<string, TaskNode>,
  executors: readonly TaskExecutor[],
): Placements
// whether a task's executor is not `remote` — it writes in place
export function locallyPlaced(placements: Placements): (id: string) => boolean
// the run's word on `otherPlatform`: refuse (an unroutable task, or CI), warn and skip, or nothing
export function platformVerdict(
  placements: Placements,
  ci: boolean,
): { refuse: string } | { warn: string } | undefined

export async function planExecutorOf(
  prepared: PreparedRun,
  log: Logger,
  policy: 'all' | 'toplevel' | 'none', // the run's --cache-download policy
  ci: boolean, // a platform refusal throws in CI, as the run's does
): Promise<{
  executorOf?: (id: string) => string | undefined
  downloadOf?: (id: string) => 'eager' | 'deferred' | 'never' | undefined
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
  otherPlatform?: ReadonlyMap<string, readonly string[]>
}>

export function hasPooledExecutor(executors: readonly TaskExecutor[]): boolean
export function poolOfPlacement(
  placements: Placements,
): (id: string) => { name: string; capacity: number } | undefined
export const UNPLACED_EXECUTOR: TaskExecutor

// core's local executor for a plugin that runs tasks itself; arms the sandbox outside a run
export interface LocalFloor {
  execute(req: ExecuteRequest): Promise<ExecuteResult>
  stop(taskId: string): Promise<void>
  close(): Promise<void>
}
export function localFloor(
  sandboxes?: readonly SandboxConfig[],
  onServer?: (taskId: string, pid: number | undefined) => void,
): LocalFloor
```

- `localExecutor()` — the floor at the tail of every executor list.
  Runs the command on this machine; what a plugin declining a task
  hands it back to. A request whose `signal` is already aborted (a stop
  that landed during the output clean) spawns nothing and returns the
  signal's exit: the command ran after the teardown had swept the run's
  children, and a Ctrl-C took 7.6 s (B-55). A sandboxed request asks
  again after its own awaits (the runtime, the tracer probe, the wrap),
  just before the spawn: a stop landing there ran the task (B-72). Internal, not on `@vzn/vx`.
- `isLocalExecutor(executor)` — whether it is core's own, by identity (a
  plugin may name its executor 'local'): core bounds a plugin's
  `execute` after the request's abort, never the local one's (H-14).

### Rules

- **Pinned to this machine**: a task that transitively depends on a
  persistent one (a worker cannot reach a port on the submitter), unless
  its executor declares `servers` and the server is carriable (no
  `sandbox`, no `exec.remote: false`, not requested): then
  `Placements.servers` names the servers each such task starts where it
  runs, and `Placements.carried` the ones no task placed here needs, which
  are never spawned here; a
  sandboxed task and its dependants (the sandbox is this machine's
  machinery; a boundary "verified" where it is not enforced passes
  vacuously; an executor that declares `sandbox` enforces it where it
  runs and is offered them), `exec.remote: false`, or a task whose key folds a runtime
  probe (`inputs.runtime` / `workspaceRuntime`: this machine's
  answer, which a worker's own runtime may not match, unless the executor
  declares `runtime` and checks it there; its dependants stay free, C-2). Pinned tasks never reach a remote
  executor;
  `selectExecutor` is told so and a remote executor declines. A
  sandboxed task is offered to no executor that does not declare
  `sandbox`, remote or not (`barred`): the local floor runs it in its
  sandbox instead of a plugin running it with none. A
  persistent task itself, like a group, is not placed at all — it runs
  on this machine outside the executor list. An `exec.interactive` task
  goes to core's local executor without asking a plugin: only it can
  hand over this terminal. Its dependants stay free. The pin flows up the
  dependant edges from the tasks that pin themselves, one walk on an
  explicit stack (a recursion per edge threw `RangeError` from
  `vx run --dry` on a 50,000-deep chain); a graph where nothing pins
  itself builds no edge index at all.
- Everything else asks the executors in declaration order
  (`selectExecutor`); the local floor takes what nothing claimed.
- `exec.remote: 'only'` with a remote executor that accepts it runs
  there and its outputs stay remote (`remoteOnly`); with no remote
  executor it is a **no-op** on this machine — never executed, outputs
  never cleaned or restored (`remoteOnlyNoop`) — and the run says so.
  Its key is the one a real run has (`remote` is not in it), so every
  task that depends on it, directly or through others (`belowNoop`),
  saves no entry: one under a key folding it would hold output built
  without its outputs, where a run over them looks.
- A pooled executor (one with `capacity`) hands the scheduler its pool
  through `poolOfPlacement`, so it can run more tasks at once than the
  local worker count. Each executor is its own pool: the scheduler counts
  a pool by name, so a second executor with a taken name (one package
  declared twice) gets `<name>#2`, where the two shared one capacity.
- `UNPLACED_EXECUTOR` is the sentinel behind a task that reached an
  executor without being placed: an internal error, never a fallback.
- `planExecutorOf` resolves the executors for a plan and places the
  graph; a failing hook does not fail the plan (a plan never fails
  over a label) but is said on the status line in the plugin's name.

### Tests

`tests/placement.test.ts` (the pin rules, a 50,000-deep chain pinned
at its bottom, `placeTasks`' gates); `tests/plugin-capabilities.test.ts` (placement end to end: pins,
decline-and-fall-through, `'only'` taken / no-op / said, pools, `--dry`
labels and the failure notice); `tests/download-policy.test.ts` (the
download modes placement feeds); `tests/plan-predict.test.ts`.

## `src/orchestrator/signals.ts` — a signal reaches every child

### Purpose

A SIGINT, SIGTERM or SIGHUP to the vx process mid-run forwards the
signal it received — SIGINT as SIGINT, SIGTERM as SIGTERM, SIGHUP as
SIGTERM — to every live child's process group and every ready
persistent task's,
waits the kill grace (2 s) for those GROUPS to go,
SIGKILLs every group with a member left, lets `run()` leave through its
own end-of-run path (a stopped run records what finished, and `vx last`
does not list it), and dies
of the signal it received, so its parent sees 130 / 143 / 129; a second
signal SIGKILLs and does the same at once.

Dies of it, not `process.exit(128 + signo)`: a shell running vx in a
script stops the script on Ctrl-C only when its child died of SIGINT,
and takes a child that exits 130 to have handled it, so Ctrl-C of
`vx run a; vx run b` ran `b` and a `for` loop over `vx run` could not
be stopped. The exit hooks (the run lock's entry, the sandbox's temp
files) run first: the handler calls `process.exit` and re-raises the
signal, its listeners removed, from the last `exit` listener. The one
exception is a run that handed the terminal to a task
(`exec.interactive` on a TTY, `handsTerminal`): that task may have left
it raw or without echo, and Bun puts back the terminal it started with
when it exits, not when a signal kills it, so that run exits 128 +
signo.

The signal stops the run the way `RunOptions.signal` does (item 849):
`run()` holds one `AbortController`, which the embedder's signal and the
process handler both abort, so the scheduler dispatches nothing more and
the abort listener runs `terminateChildren` and kills the run's running
`inputs.runtime` probes (C-65), whose answers nothing needs now and
which a Ctrl-C used to wait out. `run()` awaits that teardown
before it leaves, then the handler waits for `done` (bounded by
`boundMs`: the grace, one telemetry flush and each plugin's teardown bound, and 2 s of slack) and for stdout to drain, and
exits. Until item 849 the handler exited straight after the kill:
`process.exit` runs no `finally`, so a Ctrl-C skipped every sink's flush
and every plugin's teardown, which `orchestrator.md` promises at the end of
every run, and the summary raced the exit
(`tests/plugin-teardown.test.ts` › "SIGINT flushes the sinks and tears
the plugins down before vx exits 130").
The run hears signals from the moment it goes for its run lock
(`holdSignals`), not only once `forwardSignals` is on: every plugin's
setup runs in between, so a slow one held the window open for seconds,
and a Ctrl-C in it killed vx by the default action, with no teardown,
no flush and the lock's entry left behind (2026-11-07). Until plugin
setup begins (`arm()`), a signal leaves at once through `process.exit`,
whose hooks release the lock: nothing before it waits on a stop, and a
held one waited out a git listing (`tests/git-listing-temp.test.ts`).
From setup on, the held listener notes the first signal. `forwardSignals` takes the listeners over
and replays a signal already heard, so the stop is the one above; a run
that leaves before it (a refusal, a setup that threw) exits of the
signal from `run()`'s finally (`exitOfSignal`), its plugins torn down
and its lock released. A setup or executor factory that never settles
does not hold the first signal: `unlessStopped` ends its wait, and the
run tears every plugin down and exits of the signal. It held it, so only
a second signal (a CI's KILL after its TERM) ended vx, with no teardown
(2026-11-07). A second signal in the window exits at once
(`tests/plugin-teardown.test.ts` › "a signal during a plugin setup
tears it down, leaves no lock, and exits 130", "one SIGTERM during a
setup that hangs tears every plugin down and exits 143", "a signal heard
before a setup throws still exits 130", "a signal while waiting for the
run lock leaves before any plugin setup").

The group, not the pid (`exec/kill-tree.ts`, item 236): a task is
spawned into its own session, so what it forked dies with it — and so
the terminal closing reaches vx alone, which is why SIGHUP is handled
like the other two. Without the forward, a programmatic signal
to the process alone — CI cancellation, `kill <pid>` — orphaned every
running child; terminal Ctrl-C only worked through the process group.
Without the escalation (2026-09-10) a child that trapped TERM outlived
the run. Split from `run.ts` on 2026-09-10 (pure motion).

The received signal, not SIGTERM for all (2026-09-24): a task runs in
its own session, so a terminal's Ctrl-C reaches vx alone, and vx sending
SIGTERM in its place skipped every cleanup bound to SIGINT only — Node's
`process.on('SIGINT')`, a shell's `trap … INT` (turborepo#444, #12652,
#13097 and nx#23585, each reproduced on vx). A task hears the Ctrl-C
once, from vx. A hang-up forwards SIGTERM, because to many servers
SIGHUP means "reload". One consequence is the terminal's own: a
non-interactive shell starts what it backgrounds (`server & wait`) with
SIGINT ignored, so on a Ctrl-C such a server waits out the grace and is
SIGKILLed, exactly as it would outlive a Ctrl-C in a plain terminal;
give it a SIGINT trap, or `exec` it. `forwardedSignal` is the rule, and
`RunOptions.signal` follows it through its abort reason: aborted with
the reason `'SIGINT'` (the watch loop's Ctrl-C) the children get
SIGINT; any other reason, SIGHUP's included, sends SIGTERM. A reason
naming a signal (`'SIGINT'`, `'SIGTERM'`, `'SIGHUP'`) is also a stop as
the handler's is, so the run records no history (item 854): a watch
cycle a Ctrl-C stopped read in `vx last` as FAILED with 0 tasks
(2026-10-28).

`terminateChildren` is that teardown on its own, minus the exit: the
process handler, `RunOptions.signal` (an embedder aborting a run — the
watch loop's Ctrl-C) and the foreground keep-alive all run it. It
re-reads the registries after the grace, so a child the still-live
scheduler spawned during it goes too. The wait is for each group
(`untilGroupsGone`), not its leader: a shell that died at once on the
signal ended the grace, and the server it had backgrounded was
SIGKILLed mid-cleanup (2026-09-24). A child is signalled once even when
the registries list it twice: a ready server sits in both, and its group
got the Ctrl-C twice (`abort.test.ts` › "a stop signals each group
once, a ready server included").

### Public surface

```ts
export const SIGNAL_SHUTDOWN_GRACE_MS = 2000
export type StopSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' // what the process handler received
export type ForwardedSignal = 'SIGINT' | 'SIGTERM' // SIGHUP forwards as SIGTERM
export function forwardedSignal(received: unknown): ForwardedSignal // a SIGINT stays one; SIGTERM, SIGHUP, anything else → SIGTERM
export async function terminateChildren(
  live: () => Subprocess[],
  signal?: ForwardedSignal, // default SIGTERM
  graceMs?: number,
): Promise<void>
export function forwardSignals(args: {
  enabled: boolean // RunOptions.handleSignals
  log: Logger
  cache: { close(): void }
  liveChildren: ReadonlySet<Subprocess> // the runner's in-flight children
  persistentRegistry: ReadonlyMap<string, Subprocess>
  stop: (signal: StopSignal) => void // aborts run()'s own controller
  done: Promise<void> // settles once run() has left its finally
  boundMs: number // how long a signal waits for `done`
  handsTerminal?: boolean // a task holds the terminal: exit 128 + signo, never die of the signal
  held?: HeldSignals // taken over once these listeners are on; a signal it heard is replayed
}): SignalForwarding // { remove(): void }
export interface HeldSignals {
  readonly signal: AbortSignal // aborted by the first signal
  takeOver(): StopSignal | undefined // removes the listeners, once; the signal heard
  arm(): void // from plugin setup on, a stop is held; before, it exits at once
}
export function holdSignals(): HeldSignals // from the run lock on; a second signal exits at once
export async function exitOfSignal(signal: StopSignal): Promise<never> // stdout drained, then die of it
export function unlessStopped<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> // rejects once signal aborts
```

A vx started with SIGHUP ignored (`nohup`, a supervisor) installs no
SIGHUP handler, here or in `vx watch`: a handler replaces the inherited
`SIG_IGN`, and `nohup vx run` stopped its run and exited 129 when the
terminal closed (2026-10-08). `hangupIgnored` (`util.md`) reads
the disposition once, before the first handler.

Under a parent that relays stops (the Node launcher, a handing-off vx,
Bun's `bun vx` runner), a stop sent to the whole group arrives twice; the
copy is the same stop, not "now" (`util.md`).

Ctrl-Z (SIGTSTP) stops the terminal's foreground group, which is vx's
alone: a task runs in its own session, so vx stopped and its tasks ran
on, an interactive one still reading the terminal the shell had taken
back. The handler SIGSTOPs every task group (`pauseTree`, straight to
the group: a Linux sandbox's watcher passes one signal and is gone, so
there it stops bwrap and the command blocks once its pipe fills), then
vx itself; SIGCONT (`fg`, `bg`) continues them. Proven in
`tests/signal-handling.test.ts` ("Ctrl-Z (SIGTSTP) during vx run").

The two registries stay with `run()`, which hands them to the runner
around every spawn; this module only reads them when a signal lands.
`remove()` runs in `run()`'s finally so repeated runs in one process (a
test suite, an embedder) never stack listeners. An embedder that owns
the process's signals passes `handleSignals: false`.

### What it does NOT do

- Return: the process handler exits once `run()` has left (or its bound
  has passed). The end-of-run shutdown of dependency-only persistent
  children is `persistent.ts`, with the same grace.
- Clear the live region on the first signal: the stop marks its rows
  `aborting` (`log.runStop`, run.ts) and the run's own end replaces it
  with the footer. A second signal's exit calls `runEnd` then `runDone`,
  so a TTY keeps no frozen region.

### Tests

`tests/task-tree-kill.test.ts` (a timeout, SIGINT, SIGTERM and SIGHUP
each reap a task's backgrounded grandchild; each fails on a pid-only
kill; a grandchild's cleanup gets the grace after its shell exits, and
the wait ends when the group is gone; a SIGHUP gives the grandchild its
SIGTERM cleanup, the one thing that tells the handled hang-up from a vx
the hang-up killed, whose group guard SIGKILLs the task anyway; a vx
started with SIGHUP ignored runs on through one and exits 0);
`tests/watch-signals.test.ts` (the same for `vx watch`);
`tests/signal-handling.test.ts` (SIGINT → 130 and SIGTERM → 143 with
the one-shot child and the ready persistent child dead; a child that
ignores TERM is SIGKILLed after the grace; a second signal skips the
grace; the in-process lifecycle: handlers removed after every run,
`handleSignals: false` installs none; a one-shot and a ready persistent
task each hear the signal as vx forwards it, a Ctrl-C as SIGINT; a
task is its own session leader); `tests/plugin-teardown.test.ts` (a
SIGINT flushes the sinks and tears the plugins down before the exit; a
second signal does not wait for a teardown that hangs; a signal during a
plugin's setup, before a setup that throws, or in the lock's wait exits
130 with the plugins torn down and no lock left); `tests/abort.test.ts`
(`RunOptions.signal`: the running child and its dependents `aborted`,
a stubborn child SIGKILLed, an already-aborted signal runs nothing);
`tests/keep-alive.test.ts` (one requested server exiting ends the
foreground session: the other is torn down, exit 1 on a crash, 0 on a
clean exit); `tests/cache-hygiene.test.ts` (an interrupted run
publishes nothing).

A sweep of this file (item 861, 19 mutants) found the group guard
(`exec.md`) standing in for two of its guarantees: without the
SIGHUP handler, or without the second signal's SIGKILL, the guard's
kill at vx's exit took the tree down, and the rows saw a dead
grandchild either way. Each is held as a pair with the guard off, and
the SIGHUP handler alone by the cleanup row. Equivalent: the persistent
registry in the second signal's sweep (a ready server is in
`liveChildren` for its whole life) and `runEnd` before the stop (the
run's own end clears the region, and the handler waits for it). The
cache close on that exit survived too and is not proven equivalent: no
row observes it, and it stays as the one close a second signal gets.

## `src/orchestrator/admission.ts` — dedup and taint between scheduler and task

### Purpose

The scheduler hands `run()` a ready task; `executeTask` runs it. Two
rules stand between them and neither changes what the task is:

- **In-flight dedup.** An embedder running concurrent delegated runs
  in one process (a daemon built on the façade; core ships none)
  supplies an `inflight` registry (`RunOptions.inflight`). A cacheable
  task whose key a sibling is already computing waits for the sibling,
  then cache-hits on what it saved. A sibling that saved nothing (it
  failed) releases its joiners to run the task, one at a time: each
  takes the barrier in turn, never two in one directory at once. A stateless `vx run` passes no
  registry and takes the untouched path: no key derivation before
  execute.
- **Continue-taint.** Under `continueMode: 'always'` a task runs
  although an upstream failed. Its key is the healthy one (pure-input
  hashing) but its bytes are not, so its save is withheld
  (`taintedUpstream`) and the taint propagates through every success
  built on it — otherwise a grand-dependent would cache the same
  partial tree one hop later. Only that mode executes a task behind a
  failure; a default run carries no check. `--exclude-dependencies`
  seeds the same taint (`seeds`): a task whose key folds a dependency
  that did not run (`orchestrator.md`) has bytes nothing vouches for,
  and so does everything built on it. Under `always`, `run()` also seeds
  a task that starts while a server it depends on (through groups and
  servers too, `deadServerBehind`) has died: the server's outcome says `success`
  until the run ends, so no settled outcome holds that failure yet. In
  any mode, a task such a server died UNDER (it was ready at dispatch)
  is seeded just before its save (`ExecuteArgs.serverDiedUnder`), which
  withholds that save; a graph with a server therefore keeps the check on
  (`seedsLater`). So is a task whose shell left a process running
  (`RunContext.leftRunning`): its dependents read a tree it may still
  write. `run()` turns the check on at that first leftover, before the
  task settles, so the tracker it makes then has every outcome a
  dependent's taint is read from. No seed, no server and no `always`
  keeps the check off. A task's taint is read from its deps' SETTLED outcomes
  (the scheduler's `onFinish` feeds `settled`), not from what it saw at
  dispatch: a restore-tier hit dispatches before its deps settle, saw
  holes, and passed nothing on, so its dependent saved a failed dep's
  partial tree on its healthy key (C-1). Its dependents are released
  only once its deps have settled (scheduler.ts, item 963), so the
  answer is complete by the time anyone asks. The walk is iterative
  and memoized once every dep has settled. Every edge counts, order-only
  ones too: `judge` gets the key's upstream, which drops them, so it
  reads their settled outcomes itself; otherwise a task ordered after a
  failure by `--exclude-dependencies` saved what the run without the flag
  withholds.

Split from `run.ts` on 2026-09-10 (pure motion).

### Public surface

```ts
export interface TaintTracker {
  judge: (node: TaskNode, upstream: TaskOutcome[]) => boolean
  cause: (node: TaskNode, upstream: TaskOutcome[]) => string // the root blocker, a row's blocked_by
  settled: (outcome: TaskOutcome) => void // the scheduler's onFinish
}
export function taintTracker(
  continueAlways: boolean,
  seeds: ReadonlySet<string>,
  nodes: ReadonlyMap<string, TaskNode>,
  seedsLater?: boolean, // seeds may be added while the run goes on
): TaintTracker

export interface AdmissionArgs {
  inflight: Map<string, Promise<void>> | undefined
  policy: CachePolicy
  shortCircuit: ShortCircuit
  hashArgs: Omit<ComputeHashArgs, 'node' | 'upstream' | 'nestedProjectDirs'> & {
    nestedDirsByProject: ReadonlyMap<string, string[]>
  }
  buildExecuteArgs: (node, upstream, reuseProbe?: boolean) => ExecuteArgs
}
export function admitTasks(
  args: AdmissionArgs,
): (node: TaskNode, upstream: TaskOutcome[]) => Promise<TaskOutcome>
```

`admitTasks` returns the scheduler's `execute` callback. Dedup applies
only when it can help: a non-group, non-persistent task with a `cache`
block, under a policy where the sibling will WRITE and this task can
READ (`localRead || remoteRead` and `localWrite || remoteWrite`). A
restore-tier task (a confirmed local hit the scheduler runs ahead of its
deps) is never deduped: it restores rather than executes, and its live
`upstream` is incomplete, so a key recompute would be wrong. A task
that joins a sibling drops its up-front probe (`reuseProbe: false`) —
the probe predates the sibling's save and would report a stable miss.
A task whose probed hit vanished before its restore rejects with
`RestoreDemoted` (execute-task.md); admission deletes its `preProbed`
entry on the way to the scheduler, so the second dispatch probes afresh
instead of restoring the same gone artifact again. It stays in the
restore-tier set, so that dispatch still skips dedup.

The executor registers its barrier with no `await` between `get` and
`set`, so at most one executor exists per hash. The barrier is lifted in
a `finally` on every exit — but not before the save has landed: a miss's
save runs off the execution slot (the save lane, `orchestrator.md`), and a
joiner released before the entry existed would probe a miss and run the
task again, so the `finally` reads the lane's landing promise
(`ExecuteArgs.deferredSaves`, keyed by task id) and lifts on it; with
no lane, at once.

### What it does NOT do

- Decide WHERE a task runs (`placement.ts`) or whether it is a hit
  (`execute-task.ts`, `local-shortcircuit.ts`).
- Withhold the save itself: the tracker only answers; `execute-task`'s
  miss path reads `taintedUpstream` (see `orchestrator.md`).

### Tests

`tests/inflight.test.ts` (two runs sharing a registry execute a key
once and leave it empty; the joiner hits; joiners behind a failed
sibling run in turn; a restore-tier task, a
write-only and a read-only run do not join),
`tests/continue-taint.test.ts` (the tainted task runs and does not
save; taint reaches the grand-dependent; a hit between the failure
and the dependent carries it; so does an order-only edge),
`tests/taint-tracker.test.ts` (each poisoning status, a seed with no
failure upstream, a hit judged before its deps settled, a 50,000-deep
chain of hits).

## `src/orchestrator/run-artifacts.ts` — `--profile` writer

### Purpose

Write the optional `--profile[=<path>]` artifact: Chrome-trace JSON for
`chrome://tracing` / Perfetto. A no-op when `RunOptions.profile` is
undefined.

### Public surface

```ts
export interface ProfileArgs {
  target: string // 'profile.json' default chosen by CLI parser
  cwd: string
  outcomes: readonly TaskOutcome[]
  runStartNs: bigint // hrtime at the run's start: every event is shifted onto the tasks' clock
  executors?: readonly (readonly Record<string, unknown>[])[] // TaskExecutor.profile(), each
  spans?: readonly Record<string, unknown>[] // the run's own events (the cache probe)
}

export function writeRunProfile(args: ProfileArgs): Promise<string> // returns final path
```

It returns the absolute path written; the orchestrator prints it above
the footer.

### `writeRunProfile`

Chrome-trace format. One `ph: 'X'` event per task with `ts` and
`dur` in microseconds derived from `timing.startNs` /
`timing.endNs`. Tasks with missing hrtime data (group tasks) are
skipped.

Each project gets its own `tid` so overlapping tasks across packages
render on distinct lanes. The shared `pid: 1` is arbitrary.

`cat` carries the task's final status (e.g. `cache-hit`, `failed`)
so trace viewers can color-code.

Each executor's own events (`TaskExecutor.profile`, `ts` on
`performance.now()`) follow: its processes are moved past the ones
before it and its times onto the runner's hrtime clock, and the run's
own process is named `run`.

### Errors

The writer throws on FS failure. The orchestrator catches and surfaces
it but does NOT fail the run — the work already happened.

### Tests

`tests/run-artifacts.test.ts` (profile written and parseable, tasks
without hrtime spans skipped) and `tests/contract-profile-wire.test.ts`
(the trace's shape).

## `src/orchestrator/prepare.ts` — shared run/planRun setup

### Purpose

`run()` and `planRun()` both go through an identical workspace-
discovery → config-load → graph-build → cache-open sequence before
they diverge into "execute" vs "predict". `prepareRun` centralises
that shared work; the two callers stay thin.

### Public surface

```ts
export interface PreparedRun {
  workspaceRoot: string
  workspaceConfig: WorkspaceConfig | null
  plugins: readonly VxPlugin[] // the workspace's declared plugins, in declaration order; nothing is added
  cacheDir: string
  cache: CacheLayer // caller owns close()
  localCache: Cache // the local handle `cache` may wrap; raw SQLite readers use it
  hasRemoteLayer: boolean // `cache` is more than the local handle — the remote policy axes mean something
  cachePolicy: CachePolicy // `--cache-policy`, `VX_CACHE_POLICY` or the workspace's `cache.policy`
  cacheScope: string | undefined // the run's scope, named on the summary's info row
  remotes: ResolvedRemote[] // the run's remotes in declared order; `openRemotes` turns one whose `open` threw off
  cacheRefs: readonly string[] // the refs the run reads, in order (`CacheContext.refs`)
  priorities: ReadonlyMap<string, number> // the `schedule` stage's weights; empty without one
  branch: () => string | null // the run's branch: history records it, a forecast reads it first; learned once on first ask
  cacheFor: (plugin: string) => PluginCache // each plugin's `ctx.cache`: the run's layers under its policy and scope
  keepRunEntry: ((name: string, bytes: Uint8Array) => Promise<boolean>) | undefined // keep run bytes in the writing remotes (run-store.ts); undefined when none writes
  nodes: Map<string, TaskNode> // empty if `empty !== null`
  keyOnly: ReadonlyMap<string, TaskNode> // what --exclude-dependencies keyed but did not schedule
  /**
   * Requested specs that matched NO project — a typo, or a stray
   * positional from an `=`-only flag written with a space. Non-empty
   * means the caller must refuse: `run()` returns NOT-ok, `planRun()`
   * returns an abandoned plan carrying the same list.
   */
  unresolvedTasks: readonly string[]
  declaredElsewhere: readonly string[] // bare names only projects outside a scoped run declare
  projects: ReadonlyMap<string, ProjectEntry> // the loaded projects: the workspace, or a scoped run's closure
  hintProjects: ReadonlyMap<string, ProjectEntry> // a typo's measure: every project when a `pkg#task` named none loaded
  anyProjectConfig: boolean // some package has a vx.config.* at all, whatever the scope
  taskless: (name: string) => boolean // a workspace project that declares no task
  unlockedConfig: () => string | undefined // a config the lock lacks, so the fix is `vx lock`; asked only by a refusal
  fingerprintWatch: FingerprintWatch // the claimed root files: has a task rewritten one? (fingerprint-watch.md)
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache // per-run memo of `git ls-files`, by project dir
  workspaceProjectCount: number // every project discovery found, in or out of scope
  hashCache: HashCache // per-run memo of derived digests (see task-hash.md)
  dependents?: ReadonlyMap<string, number> // the dependents count, taken beside git (Steps, 5)
  /**
   * Reason `nodes` is empty:
   *   - `null`                — graph is non-empty, ready to execute.
   *   - `'no-tasks-declared'` — `requested.length === 0` after
   *                              resolving the user's task names
   *                              against `projects`. CI footgun;
   *                              `run()` returns NOT-ok.
   *   - `'none-affected'`     — as `'no-tasks-declared'`, but the
   *                              scope came from a diff and every name
   *                              is declared elsewhere in the
   *                              workspace; `run()` returns ok.
   *   - `'empty-graph'`       — `requested` was non-empty but
   *                              `buildTaskGraph` produced no nodes.
   *                              Defensive; unreachable under current
   *                              builder semantics.
   */
  empty: null | 'no-tasks-declared' | 'none-affected' | 'empty-graph'
}

export function prepareRun(options: RunOptions, log: Logger): Promise<PreparedRun>
// run() alone, before setup: each remote's `open` the policy allows, in order; true when none is left
export function openRemotes(
  remotes: readonly ResolvedRemote[],
  ci: boolean,
  secrets: SecretBroker,
): Promise<boolean>
// The config `vx lock` would find at the directory `name` reads as, or in an unlocked directory whose package.json is named `name`, where no project is: a run and `vx show` refuse with "run `vx lock`"
export function unlockedDir(
  name: string,
  metas: ReadonlyArray<{ dir: string }>,
  workspaceRoot: string,
): Promise<string | undefined>
```

### Steps

1. **Workspace discovery** — `findWorkspaceRoot`, then
   `discoverProjects`: the directories `.vx/projects.lock.json` records
   with the plugin `discover` stage as `vx lock` recorded it (no hook
   runs; a run never walks for configs); the
   workspace config arrives evaluated and with the `config` stage
   applied (`RunOptions`, from `cli/workspace-config.ts`), and
   `loadWorkspacePlugins` gives the declared plugin list — or, for a
   reused discovery, the load the CLI made before it
   (`pluginsOfDiscovery`), so the `config` stage runs once per run.
2. **Project config load** — `loadProjects` ([`orchestrator.md`](#srcorchestratorprojectsts--the-project-config-load)),
   the load `vx show` shares: scoped to the seeds and their package
   closure, from the lock, with the plugin `project` stage as `vx lock`
   recorded it (no hook runs). A project a `discover` plugin added has no config:
   it is kept in the graph (for its edges) and contributes no tasks
   unless a plugin fills the `project` stage, or the default `build`.
3. **Package + task structure** — `buildPackageGraph`,
   `computeNestedProjectDirs` (once for the key, and once more with the
   nested workspaces the lock records, `nestedWorkspacesOf`, for the
   output readers: `outputWallsOf(nestedDirsByProject)` returns it, the
   map itself when there is none), `expandRequested` (plus
   `unresolvedRequests`, the same predicate run in reverse to name the
   specs that resolved to nothing).
4. **Cache + fingerprint** — `new Cache(dir)` on `--cache-dir` or
   `resolveCacheDir(root, workspaceConfig)`. One this user cannot write
   serves hits and saves nothing, with one line saying so; an empty one
   is refused up front with the directory named (`readOnlyNotice`).
   A plan with no remote to probe (`prepareRunLocked`'s `planning`) opens
   it in `'preview'` mode instead and writes nothing (`orchestrator.md`).
   Then the layer resolution: an injected `RunOptions.remoteCache`
   composed into a `LayeredCache` wins; else `resolveCache` layers
   every plugin's `cache` remote over the local store, in declared
   order, under the run's policy — one remote is one `LayeredCache`,
   two or more are chained, and none leaves the local store unwrapped
   as the floor.
   `readClaimedFiles` reads the root files the plugins claim
   (`VxPlugin.fingerprint`) once, for the `FingerprintWatch`; core
   folds none of them into a key.
5. **Build the task graph** — `buildTaskGraph(...)`, the whole graph;
   the `graph` and `key` stages see it all. A `^name` no project in the
   workspace declares is refused (`undeclaredDepsError`), with or without
   `--exclude-dependencies`; when the load was scoped (a config it left
   out, asked by name: a config-less project in the closure does not
   make it whole, X-182), the builder cannot
   see the whole workspace, so it hands such a name back
   (`undeclaredDeps`) and `refuseUndeclaredDeps` reads the locked configs
   the scope left out — only then, and never for a name something loaded
   declares — refusing if none of them declares it either. One of them
   failing to load leaves the name unjudged, since an out-of-scope broken
   config does not fail a scoped run. An `--exclude-dependencies` name no
   project declares is refused the same way (a `UserError` with a
   near-miss hint, item 1026). Then `--exclude-dependencies`
   narrows the schedule (`excludeDependencies`) and
   `keyExcludedDependencies` keys each dropped dependency on that whole
   graph, so the dependant folds the key a full run gives it.
   Under `--affected` the selection (`orchestrator.md`) prunes the
   graph; with a `graph` plugin the hooks run before it, so it sees
   their edges and inputs, else after the git enumeration.
   While the enumeration's blob-size check runs (`cache.md`), the
   dependents count (`graphCounts`, `graph.md`) is taken and handed
   back as `PreparedRun.dependents`, which `run` reads instead of
   counting before its first task (40 ms of a cold 8,002-task run that
   waited ~80 ms on `cat-file`). Not when anything after the graph can
   edit the nodes: a `graph` hook still to run, a `key` hook, or
   `--exclude-dependencies`; `run` counts then. Only a run asks for it
   (`prepareRunLocked`'s `countDependents`): a plan never reads it.

The cache + fingerprint are constructed even when the result will be
empty so callers always have a uniform `try { ... } finally {
cache.close() }` shape.

### Why a single shared module

Before: `run()` and `planRun()` each duplicated ~50 lines of setup,
slowly diverging (different error messages, different defaults,
`planRun` opened the cache without a logger context for the cache-layer
resolution, etc.). After: one function, one path; the two callers handle
only what's actually different (execution vs prediction).

### Extension points

- **Reshaping projects between config load and graph build** is the
  `project` pipeline stage (`VxPlugin.project(config, ctx)`): a
  plugin edits each loaded project's tasks in place and core
  re-validates. That is where a target-defaults or named-inputs
  expansion would live IF it were wanted — workspace-level
  `namedInputs`, `globalInputs` and `globalEnv` are owner-rejected
  non-goals (CLAUDE.md § Rejected): configs are TypeScript and compose
  through shared presets instead.
- **Observing the run** is the `telemetry` seam (`VxPlugin.telemetry(ctx)`)
  and the raw bus (`setup(ctx)`); both are constructed by the run, not
  here, and reach every task through the context.
- **Anything that needs the prepared graph** (priorities, resources,
  extra key material) has its own stage: `graph`, `schedule`, `key`.
  See `docs/design/pipeline-2026-09.md`.

### Tests

`tests/prepare-run.test.ts` pins its rules directly: scoped config
loading reaches every project a run can need, a `^name` no project
declares is refused in a scoped run too, `--exclude-dependencies` keys
a deep dropped chain, and the empty-run reason. Also covered
transitively by `tests/orchestrator.test.ts` and `tests/cli.test.ts`.

## `src/orchestrator/projects.ts` — the project-config load

### Purpose

One code path for "which tasks exist, resolved": `prepareRun` (a run,
a plan) and `vx show` both call `loadProjects`, so what `show` prints
is what a run would see — the plugin `config` and `project` stages
included. Before this, `show` read config files raw and printed
`(no vx config)` for a project `turbo()` gives tasks to.

Only `vx lock` runs the `project` stage's hooks (`lock: true`); it
records what they left in the lock (`Lockfile.projectStage`), and every
other load reads that record and calls no hook, so a run reads nothing
a mapping reads (turbo.json, a manifest, git, the environment). It
follows the record blindly, whatever plugins the workspace declares now:
a project the record holds loads its recorded config, any other its
locked one, or `{ tasks: {} }` with no config file (2026-11-11: "we
never relock during runs ... it should always follow the lock blindly").
`vx lock --check` names the drift.

`loadWorkspacePlugins` runs the `config` stage on a copy of the
workspace file's export (its plugins kept as they are): the export is one
object per process, and hooks that edited it in place saw the last load's
edits on the next (the CLI's selection pass, then the run; each `vx
watch` cycle).

A project whose config and plugins declare no `build` gets one, after the
`project` stage: a group with `dependsOn: ['^build']` keyed on `**`
(2026-10-04; `computeGroupKey`, task-hash.md), the graph module's
`DEFAULT_BUILD` (task-graph.md).

### Public surface

```ts
export function loadWorkspacePlugins(
  workspaceRoot: string,
  warn: (m: string) => void,
): Promise<{ workspaceConfig: WorkspaceConfig | null; plugins: readonly VxPlugin[] }>

// The lock's directories (lockedProjects; a run never walks for configs),
// with the `discover` stage `vx lock` recorded (Lockfile.discoverStage)
// applied: added projects, names, deps and reach. No hook runs. An edge
// to no project, a recorded name that clashes, or a `projectStage` config
// for no project is refused as an invalid lock. Then checkProjectNames.
export function discoverProjects(
  workspaceRoot: string,
  lock: () => Promise<Lockfile>,
  git?: LazyGitEnumeration, // the run's enumeration, which `--affected` reads and starts
): Promise<ProjectMeta[]>
// `vx lock`'s discovery, the one place a `discover` hook runs: the lock's
// directories through the stage (skipped when no plugin has it), its edges
// onto the metas (linkDiscoveredEdges), checkProjectNames, and what to record
// (`stage`: each project the stage added, renamed or gave edges, with the
// plugins that filled it; absent with no `discover` plugin).
export function lockDiscovery(
  workspaceRoot: string,
  lock: () => Promise<Lockfile>,
  plugins: readonly VxPlugin[],
  cacheDir: string,
  warn: (m: string) => void,
): Promise<{ projects: ProjectMeta[]; stage?: DiscoverStageLock }>
// The enumeration a discovery registered, by the array it returned (G-75).
export function gitOfDiscovery(projects: readonly ProjectMeta[]): LazyGitEnumeration | undefined
// The run's extra-file hashes (`ExtraHashes`, lockfile-claim.md), by the same array:
// `discover`, the `project` stage, `--affected` and the key hash a `file:` directory once.
export function extraHashesOfDiscovery(projects: readonly ProjectMeta[]): ExtraHashes | undefined
// The lock that discovery read, by the same array: a later config load reads no second copy.
export function lockOfDiscovery(
  projects: readonly ProjectMeta[],
): (() => Promise<Lockfile>) | undefined
// The nested workspace roots (absolute) that lock records, by the same array;
// none for an array no discovery made. A run's outputs stop at each.
export function nestedWorkspacesOf(projects: readonly ProjectMeta[]): readonly string[]
// The package graph a selection pass built over that array whose task edges
// added none: the graph a run reusing the discovery would build again.
export function keepDiscoveryGraph(projects: readonly ProjectMeta[], graph: PackageGraph): void
export function graphOfDiscovery(projects: readonly ProjectMeta[]): PackageGraph | undefined
// The workspace (`loadWorkspacePlugins`) the CLI loaded before that discovery:
// a run reusing the array runs the `config` stage no second time.
export function keepDiscoveryWorkspace(
  projects: readonly ProjectMeta[],
  workspace: Awaited<ReturnType<typeof loadWorkspacePlugins>>,
): void
export function pluginsOfDiscovery(
  projects: readonly ProjectMeta[],
): Awaited<ReturnType<typeof loadWorkspacePlugins>> | undefined
// The refusal a task gets when it cannot spawn because its locked
// project's directory is gone: run `vx lock`.
export function lockedDirGone(root: string, name: string, dir: string): string
// Why a project a `discover` plugin added has no config while its directory
// holds one git ignores (`config`, looked for when not given), naming the
// plugin, or undefined: `vx lock` refuses it, and a run says it instead of
// "run `vx lock`", which reads only what git lists.
export function ignoredConfigRefusal(
  root: string,
  meta: { readonly name: string; readonly dir: string },
  config?: string,
): string | undefined

// The graph is read only for the closure, so only a closure load needs one.
export type LoadProjectsArgs = LoadProjectsBase &
  ({ closure: true; packageGraph: PackageGraph } | { closure: false; packageGraph?: PackageGraph })
interface LoadProjectsBase {
  workspaceRoot: string
  cacheDir: string
  plugins: readonly VxPlugin[]
  projectMetas: readonly ProjectMeta[]
  seeds: 'all' | Iterable<string> // 'all' is `configured`; unknown names ignored
  configs: (() => Promise<Lockfile>) | 'evaluate' // the lock, asked only when a config is read; 'evaluate' is `vx lock`'s alone
  warn: (m: string) => void
  lock?: boolean // `vx lock`'s audit: the one load that runs the `project` hooks
  staged?: ReadonlyMap<string, ProjectEntry> // entries a load in this process already produced
}
export interface LoadedProjects {
  projects: Map<string, ProjectEntry>
  configured: readonly ProjectMeta[] // every project that can carry tasks
  stage?: Map<string, ProjectConfig> // with `lock`: each config the hooks left, by dir, before the default build
}
export function loadProjects(args: LoadProjectsArgs): Promise<LoadedProjects>

/** A reader's view: from the lock (no lock is NO_LOCK), every stage applied, no closure. */
export function loadResolvedProjects(
  workspaceRoot: string,
  opts?: { scope?: 'all' | readonly string[]; warn?: (message: string) => void },
): Promise<Map<string, ProjectEntry>>
// The lock, read once on first ask; no lock is NO_LOCK.
export function lockReader(workspaceRoot: string): () => Promise<Lockfile>
```

### Algorithm

1. **Who can carry tasks.** A project with a config file; and, when
   any plugin declares `project`, every project — one a `discover`
   plugin added, with no config, loads as `{ tasks: {} }` for the stage
   to fill. `configured` is that set.
   Boundary geometry fences every workspace project, configured or not
   (`prepare.ts`, X-57).
2. **Seeds.** `'all'` is `configured`; named seeds load as named. With
   `closure`, each seed's `packageGraph.transitiveDeps` join, a
   config-less one too: it loads as `{ tasks: {} }` and gets the
   default `build`, so a dependant bundling its source is keyed on it
   behind `^build` (X-9). The closure is skipped when every project is
   already pending.
3. **Rounds to a fixpoint.** Each round reads its config files from
   the lock (or, for `vx lock` alone, evaluates them in one
   `loadProjectConfigs` batch),
   applies the `project` stage per project — under `lock`, the hooks,
   re-validating after EACH plugin under an `(after plugin '<name>')`
   label; otherwise the lock's record of them — then queues any project a
   `pkg#task` dependsOn entry names — the package graph cannot see
   the cross form. No cross deps → one round. A project present in
   `staged` is taken as is — no evaluation, no stage — and still
   contributes its cross deps; seeding and scoping do not change. The
   CLI's selection pass (`resolveFilters` → `taskEdges`, or the tags a
   `tag:` filter reads) is the producer: before it, a graph-walking filter loaded every config
   twice per run.

Only `vx lock` and `vx lock --check` pass `configs: 'evaluate'`
(`tests/module-boundaries.test.ts`). `prepareRun` passes `closure: true`
and the run's lock. `vx show`, `vx info`, `vx watch`'s config sweep, the
picker and the CLI's selection pass read the lock too, through
`cli/workspace-config.ts` (`closure: false`; no lock is `NO_LOCK`) or
the doctor's own load (no lock counts zero). `loadResolvedProjects` is
the same read for an embedder — `@vzn/vx-history` calls it,
and `@vzn/vx` exports it — with discovery and the plugin load folded
in: `scope` is every project or a list of names, no closure.

### Tests

- `tests/prepare-run.test.ts`, `tests/plugin-pipeline.test.ts` — the
  run path (scope, closure, cross deps, the `project` stage).
- `tests/project-stage-lock.test.ts`, `tests/staged-once.test.ts` — a
  run follows the stage `vx lock` recorded and calls no hook; an edit
  maps at the next `vx lock`, and `--check` names the drift.
- `tests/show-info.test.ts` — `show` through the same load: a
  config-less package under a `project` plugin shows its tasks.

## `src/orchestrator/plugin.ts` — the VxPlugin interface + installer

### Purpose

The integration seam. A plugin is `definePlugin(import.meta, hooks)`
— its name is the name of the package it is defined in, read from the
nearest `package.json` that has a name (a nameless one, such as the
`{ "type": "module" }` a dual build writes into `dist/esm/`, is passed) and
stamped where the workspace loader checks, never a field — with at least
one capability; `defineWorkspace({
plugins: [...] })` activates it. Core
consults capabilities at fixed points and otherwise ignores plugins —
behavior lives in the plugin package (vite-style), not in core. A
`package.json` that does not parse is refused naming the file (X-20),
and a key on the plugin that names no hook (`excutor`) is refused by
the workspace schema with the nearest hook hinted (X-19). The hooks are a
plain object: a class instance is refused, since its methods live on its
prototype and the copy `definePlugin` makes would drop them.

A factory that takes options calls `refuseUnknownOptions('name()',
options, kinds)` first: Bun strips a config's types, so a misspelt option
(`reapi({ endpont })`) reached the factory as unset and the plugin
declined with no word, and a value of the wrong kind (`process.env.X`
where a boolean or a number belongs, a number where a string does) was
misread or threw a bare TypeError. It refuses the key as core refuses an
unknown config field, naming the allowed keys and the nearest one, and a
value of the wrong kind naming the kind. `kinds` is a
`PluginOptionKinds<Options>`: each option with the one kind its type
allows (`'array'` for a list, `'any'` for a union of kinds), derived from the interface, so the
type checker refuses a missing option, an extra one or a wrong kind.
Every first-party factory calls it. Its third argument was a list of
names until 0.0.397; it is the kinds record since.

### Capabilities

| Capability             | Consulted by                         | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config(ws, ctx)`      | every verb, first                    | edit the workspace config in place before anything is derived from it (`cache.dir` too); re-validated after EACH plugin; `ctx.setBranch` names the branch's cache scope and base (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `discover(ctx)`        | `vx lock`, after core's discovery    | return `DiscoveredProject[]` (`{ dir, name?, deps?, reach? }`): a `name`d directory that is not a project becomes one; an existing one keeps its name (another is refused). `deps` (order: `^task`; reach: `--filter`, `--affected`) and `reach` (reach only) are directories, unioned over plugins after the stage, the only project edges core has (with none returning `deps`, a `^task` is refused); a target that is no project is refused; `ctx.projects` is core's and earlier plugins', `ctx.cacheDir` the run's, `ctx.worktreeChanges()` the paths the run's own `git status` lists (null outside git), so a plugin keyed on the worktree walks it once with core. The lock records the result (`discoverStage`); every other verb reads that and calls no hook. Refusals name the plugin      |
| `project(cfg, ctx)`    | per loaded config                    | add/remove/edit a project's tasks in place; core re-validates after EACH plugin, by name; `ctx.lock` is true in `vx lock`'s pass, the place to report what a mapping could not say (a run checks nothing)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `graph(nodes, ctx)`    | after graph build                    | edit `deps`/`requested`/`config` in place; the builder's checks run again (item 981), each task config is re-validated after EACH plugin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `key(task, ctx)`       | per task, at hash                    | a plain `{ name: value }` record folded into the key and named in `vx why`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fingerprint`          | claim, static                        | `{ files, affected(change, ctx) }`: the workspace-fingerprint files this plugin keys per project; one claimant each; `affected` answers names from `ctx.projects`, else it is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `measures(nodes)`      | once, before `schedule`              | measure id (`<plugin>#<name>`) → definition hash: what the plugin times that is no task (a worker's warm-up). Every `schedule` gets the union as `ctx.measures`, so a history plugin fetches them with the tasks; `ctx.measure({ id, def, durationMs, cores? })` reports one in the run, heard as `onMeasure`; core keeps the run's last of each as a task's timing, read back by `localHistory(…).measuresFor(ids)`                                                                                                                                                                                                                                                                                                                                                                                    |
| `schedule(nodes, ctx)` | once, if a task will start           | task id → weight, merged over the structural baseline; later plugin wins per task. Awaited before the first task, so it answers from what is at hand; `ctx.refs` are the refs the run reads, as `CacheContext.refs`; `ctx.refine(weights)` replaces the plugin's weights later and re-ranks the tasks not yet started (fetched timings), never holding the run; `ctx.onRefine(listener)` calls back when another plugin refines, so a plugin that read history here reads it again; `ctx.refine(promise)` promises weights, and `ctx.refining()` settles once every promised refine has landed, so a plugin that sizes the run by fetched data (vx-dte's workers) waits for it; `ctx.flaky(taskIds)` names tasks a shared record knows as flaky, so a failing one gets the one retry a known flake gets |
| `admit(task, ctx)`     | every local dispatch                 | `false` holds a ready task beside `ctx.running` until something finishes (with nothing running, it is overridden, by name); a persistent task leaves `ctx.running` at ready, when it frees its worker; sync, cheap; a throw, a Promise or an answer not `true`/`false`/`undefined` admits from then on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `commands`             | unknown CLI verb                     | `{ verb: { description, run(argv, ctx) } }` (`ctx.cache` read-only, opened on first use; `ctx.artifacts` saves and restores task entries by key under a run's policy and scope; `ctx.artifactsFor(facts)` does it under another run's refs and lent access, the `CacheContext.lent` a plugin's remote reads); a core verb's name, an empty one or one opening with `-` is refused; `vx help`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `executor(ctx)`        | `plugin-host.ts`                     | return a `TaskExecutor` or decline; ALL kept in order, first accepting runs; `ctx.artifacts` (`TaskArtifacts`) saves and restores task entries by key in the run's cache, for a task another machine ran; `ctx.cacheFacts()` is what that machine reads the cache under (`CacheFacts`: the run's refs and each remote's `lend`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cache(ctx)`           | run setup                            | return a `RemoteCacheLayer` or decline; core layers each over the local cache, in declared order, under the run policy (plugin-host.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `telemetry(ctx)`       | `telemetry-host.ts`                  | return sink(s) or decline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `output(ctx)`          | `output-host.ts`, before `run:start` | return a `Logger` that draws the run, or decline (`OutputContext`: `ctx.isTTY`, `ctx.ci` say where it would draw); first one wins; one that does not answer within the teardown bound is passed over with a warning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `setup(ctx)`           | `installPlugins`                     | validate config; throw `UserError`; `ctx.cache`, `ctx.ci`, `ctx.branch` (below), `ctx.secret` (util-secrets.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `teardown(run?)`       | end-of-run                           | flush/close; crash-isolated, 3s-bounded; `RunReport` when the run ran to its end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### The installer

```ts
installPlugins(args: InstallPluginsArgs): Promise<() => void> // runs each setup; resolves to the uninstall
interface InstallPluginsArgs { plugins; workspaceRoot; cacheDir; bus: EventBus; warn?; cache?(plugin): PluginCache; ci?; branch?; secrets?; step?; signal? }
// What setup(ctx) receives: on(hook, handler) subscribes a lifecycle hook.
interface PluginContext { workspaceRoot; cacheDir; warn(message); bus; cache: PluginCache; ci: boolean; branch: string | null; on<K extends PluginHookName>(hook: K, handler: PluginHookHandlers[K]) }
type PluginHookName = keyof PluginHookHandlers
// 'onRunStart' | 'onTaskStart' | 'onTaskStdout' | 'onTaskStderr' | 'onTaskComplete' | 'onRunStatus' | 'onRunEnd'
```

### `ctx.cache`

`setup` and `schedule` receive the plugin's own entries in the cache the
workspace declares (`PluginCache`, `cache/plugin-cache.ts`; design
`design/shared-timings-2026-10.md`): `get(name, scoped?)`, `put(name, bytes)`,
`has(name, scoped?)`, `hasMany(names, scoped?)`. The local store (the shared store's
`plugin_blobs`) answers first, then each remote in declared order, under
the run's policy (a read-only remote is never written) and scope: a
scoped run writes only the scope's entry and reads one, the scope's, or
with `scoped` false the default (base branch) entry. Core
derives each key from the plugin's name and the entry's
(`xxh3('vx-plugin\0' + plugin + '\0' + name)`), so a plugin reaches no
other plugin's entries and no task's. A `put` never replaces an entry:
the local store keeps the first, and core sends each remote the `put`
alone, asking no `has` first; a remote keeps what it holds. An entry is at most 1 MiB; a remote
body over that is a miss, read no further. Every failure is an absent
answer, never a throw or a warning; `hasMany` is `null` when a readable
remote has no batch probe. With no remote, `get` is a local lookup.
`schedule` runs after `setup` (only a run that starts a task schedules).
`tests/plugin-cache.test.ts`.

### Run report and run bytes

A run that writes a remote (CI by default) keeps its own bytes there
(`cache/run-store.ts`): the log of a task that saved no entry, and a
failed task's log and a tar of the files its declared outputs left when
`cache.upload.failures` (`'ci'`, the default; `'local'`; `'always'`)
covers the run. Each task's bytes leave when it ends, off its path; the
run waits for them where it waits for its uploads (shown as `vx:uploads`
when it does), and the footer counts the task under `remote ↑`. A task that saved an
entry keeps its log in the entry; nothing goes to the local cache, where
`vx last --log` and the tree already hold it. Names are
`run/<runId>/<taskId>/log|outputs`, each key derived in its own
namespace (no task key or plugin entry shares it), scoped as tasks are,
uncapped. A run that ran to its end then calls each `teardown(run)` with
a `RunReport`: `runId` (its history rows' `run_id`), `commit`, `ciRun`
(`detectCi`: provider, run URL, change, pipeline, job, attempt), `ok`
and every task (`id`, `status`, `durationMs`, `key`, and `log` /
`outputs` names when kept). `ctx.cache.getRun(name)` reads one from the
first readable remote. Core writes no manifest: a plugin that wants a
run record writes one from the report with `ctx.cache.put`. The report
is frozen, so every teardown reads the same one; a run a stop ended
(Ctrl-C, an embedder's `signal` aborted with a signal's name) passes none,
as plugin.ts says.

```ts
interface RunReport {
  runId: string
  commit: string | null
  ciRun: CiContext
  ok: boolean
  tasks: readonly RunReportTask[]
}
interface RunReportTask {
  id: string
  status: TaskStatus
  durationMs: number
  key?: string
  log?: string
  outputs?: string
}
```

`tests/plugin-run-facts.test.ts`; `tests/plugin-run-record.test.ts` builds
a run explorer's record on this API and reads it back through a verb.

### Invariants

- **Decline-fast**: every capability must return `undefined` cheaply
  when unconfigured — a plain run with declared-but-unconfigured
  plugins is zero-overhead (measured ~116ms unchanged).
- A throw in `setup`, a stage (`config`, `discover`, `project`, `graph`,
  `key`, `fingerprint`'s `affected`, `schedule`) or an `executor` /
  `cache` factory fails the run in one
  line naming the plugin and the hook: what a plugin shapes is
  load-bearing. The observers are isolated (observability never breaks a
  run): a `telemetry` factory or sink, a `ctx.on` handler or `ctx.bus` subscriber (switching off its whole plugin, not its package) and `teardown`
  are warned and switched off,
  and a throwing `admit` (or one that answers a Promise, or anything not
  `true`, `false` or `undefined`) admits from then
  on. An async hook's rejection counts as its throw. `ctx.on` with a
  hook name it does not know fails the load (H-16), as does a handler (or
  a `ctx.bus.subscribe` subscriber) that is not a function.
- **What a plugin observes is read-only** (`read-only.ts`,
  `tests/plugin-read-only.test.ts`): a `ctx.on` handler, a `ctx.bus`
  subscriber and an `output` Logger get read-only views of the run's
  events (a node, an outcome and all they hold: a write throws a
  TypeError naming the property, in any mode), telemetry records and the
  summary are frozen once for every sink, the `RunReport` is frozen, and
  a `project` hook's `ctx.projects` is frozen, entries too. So is what a
  stage reads but does not edit: the task a `key` or `admit` hook gets and
  `ctx.running`, the nodes a `schedule` hook gets (and its map), and
  `discover`'s `ctx.projects` (one view from `discover` to `project`, so a
  plugin keyed on its identity, nx(), sees one list). A plugin executor's
  request carries frozen copies of its `outputs`, `envDefine` and
  `forwardArgs`. The write's
  throw is the plugin's own: a stage fails the run naming the plugin, an
  observer is switched off with one warning. Before it, a handler that set
  a failed outcome's `status` to `success` passed the run, an
  `onTaskStart`, `schedule` or `admit` hook rewrote the command a task ran
  under its key, a `project`, `discover`, `key` or `admit` hook that moved
  a project or task into another's directory ran it there (its outputs
  clean emptied that one's), an executor that emptied its `outputs` saved
  an empty artifact a later hit restored, one that set its `envDefine` ran
  the next task declared alike with it, and a sink that cleared a record's
  array crashed a green run. The views are proxies made once per object,
  not copies: ~1 us per task a hook hears (a frozen deep copy was ~5 us),
  ~0.5 us per task in `key`, ~0.2 us per `admit` ask (10,000 tasks); no
  plugin, no view.
- `teardown()` and every telemetry sink's `flush()` ARE invoked at
  end-of-run, each under try/catch and a time bound — plugins may rely
  on them to drain buffers. A run a SIGINT/SIGTERM/SIGHUP stops is no
  exception (item 849), nor is one that never started its schedule (a
  refused setup, a factory that threw, an unresolved name) or a plan
  (item 1021); a second signal, or a `kill -9`, is. A signal during a
  setup or executor factory that never settles tears every plugin down,
  that one included, and exits. So does a run a hook strands (one that
  never settles, from the stage after the factories on): the loop
  drains, `bin.ts` names the plugin and hook and exits 1 once the
  teardowns end. A plugin whose own `setup` threw is not
  torn down. Its `ctx.on` handlers and telemetry
  sinks are released just before `teardown()`, so it hears nothing after
  it, a server vx keeps in the foreground included (C-66). (The older `eventSink` seam is gone since
  pipeline v2; `setup(ctx)` on the bus and `telemetry` are the two
  observe paths.)
- **No defaults, one floor.** Core applies no plugin on its own; its
  local executor is the tail of every executor list and its local cache
  is asked first in every cache chain (see plugin-host.md), so a
  workspace that declares nothing
  runs and caches here.

### Branch facts

A CI knows what git may not: the branch a detached checkout builds and
the commit a pull request is compared with. The `config` stage says so:

```ts
export interface BranchFacts {
  scope?: string // the cache scope, `<owner>/<repo>:<branch>`; VX_CACHE_SCOPE beats it
  base?: string // the commit a bare --affected and the scope split diff from
  trusted?: boolean // no scope, whatever git names: only the default keys (a merge queue)
  refs?: readonly string[] // the refs a remote reads, in order; unset, git's (cacheRefs)
}
export interface ConfigContext extends WorkspaceHookContext {
  setBranch(facts: BranchFacts): void // a later plugin's field wins; a bad scope, base or ref is refused
}
```

## `src/orchestrator/plugin-host.ts` — capability consultation

### Purpose

Runs the pipeline stages: `config`, `project` and `graph`, where each
plugin edits the object in place in declaration order, and `discover`,
`key`, `fingerprint` (`claimedAffected`), `schedule` and `admit`, which
answer (`hasHook` is the zero-cost gate that skips a stage nobody
declares). It consults the
run-level capabilities (`executor`, `cache`), and runs each plugin's
`teardown()` at the end of the run, crash-isolated and time-bounded.
A hook's throw reads `plugin '<p>' failed in <hook>: <message>`; a bug
(a `TypeError`, `ReferenceError`, `RangeError` or `SyntaxError`) adds
`(at <file>:<line>:<col>)`, the first frame outside vx. What a hook
answered is read and checked the same way (`reading`): a getter or Proxy
trap in it that threw crashed vx with a raw stack (2026-11-07). A
`discover` entry, a `key` record, a digest's `projects` and an
`affected` list are copied as they are checked, and core uses the copy,
so a getter cannot answer the check one value and the run another
(`tests/plugin-hostile-answers.test.ts`, `tests/discover-stage.test.ts`).
After the `graph` stage the graph is re-checked the way `vx lock`
checks the builder's (`checkGraph`: each node under its own id, every dep a
node, no cycle, no two tasks deleting each other's outputs, no input
reading another task's outputs, the addition marks derived again) and a
violation is reported against the last plugin that ran. A run checks
it unlocked too, though it skips those walks over a graph the lock
checked: a hook that edited only a run's graph (by `ctx.requested`)
made two tasks write one file, and both ran and saved
(`tests/plugin-pipeline.test.ts`, "an overlap a hook makes only in a
run"). No `graph` hook, no walk. A dep listed twice is dropped to one, as the builder dedupes
its own: the key folded the upstream twice, and a server held on the
remote's answer waited on one answer too many, so the run never settled. Only the first two were checked until item 981: a plugin that
dropped the edge between two overlapping outputs lost one task's files
under a green run, and one that moved a node to another key crashed
the scheduler with a raw TypeError. Before that, after EACH plugin,
every entry must be an object whose `deps` is an array (X-15): a hook
that set `deps = null` was refused as "null is not an object", naming
neither the task nor the field. Its `projectName` and `taskName` must be
names and its `projectDir` an absolute path (X-94): a node a hook added
without one failed at its run as an internal error (a TypeError from
`path`), and a relative one keyed and ran against vx's own cwd. Its `id`
must be `projectName#taskName`: a copy under a new id kept the old
`taskName`, which `--exclude-dependencies` read while the key read the id.
Its `projectName` must name a project of the workspace and its
`projectDir` be that project's directory (`graph-stage.ts`): a node under
a directory no project owns ran, keyed and cleaned its outputs there.

Every capability is resolved inside `prepareRun`/`run()` from the declared
list (`prepared.plugins`). (A whole-run `backend` capability was resolved
by the CLI layer before `run()` started, until that seam was removed in
2026-08 — it moved the scheduler server-side, which is exactly what core
does not do. `executor` replaced it at the per-task grain.)
Core's floor is always there: `resolveExecutors` puts `localExecutor()`
at the tail of the list and `resolveCache` asks the host's local `Cache`
first, before each remote in declared order (dropped when a declared
layer already wraps it and comes first), so a workspace that declares
nothing runs and caches here.

### Public surface

- `hasHook(plugins, hook)` — the zero-cost gate: does any plugin
  declare the stage.
- `applyConfigHooks` / `applyDiscoverHooks` / `applyProjectHooks` / `applyGraphHooks` /
  `applyKeyHooks` / `applyScheduleHooks` — the pipeline stages, run in
  declaration order only when some plugin declares them.
- `fingerprintClaims(plugins)` → claimed file → its one claimant (the
  schema refused a second, so this only indexes);
  `claimedAffected(plugin, change, ctx)` asks the claimant which
  projects a change to its file reaches — `undefined` is every project,
  and a non-iterable answer is refused by name;
  `claimedExtraFiles(plugin, file, bytes)` → the files the claimant
  names from that file's bytes (`undefined` when it names none), a
  non-list answer refused by name;
  `claimedDigests(plugin, file, ctx)` → the claimant's per-project
  digests, the hash they came from and each extra file they read with
  its hash now (`hashExtra`, as a run checks it; `undefined` when it
  keeps none), a malformed answer or an unknown project name refused by
  name.
- `resolveExecutors(plugins, ctx)` → `TaskExecutor[]` (ordered, the
  local executor last; the first to accept a task runs it; a throwing
  factory aborts).
- `executorLabel(executor)` — how a message names a resolved executor:
  `plugin '<name>' (executor '<name>')`, or `executor '<name>'` for the
  local floor. A throwing `accepts` or `demand` is named by it.
- `executorDemand(placed, warn)` → `ExecutorDemand` — tells each
  executor with a `demand` hook the task ids it still has left: first at
  `settle(hits, missed)`, once the cache has said what it holds (the local
  probe, or the remote prefetch's answer), without those, and which it
  surely lacks (`missed`, passed narrowed alongside); then as each
  `finished`, and when a left-out task is `executing` after all. A
  throwing `demand` is warned once and not asked again. With no such
  executor every call does nothing.
- `nameExecutorFailure(executor, err)` — a plugin executor's throw from
  `execute` as a `UserError` reading `<label> failed in execute: <reason>`
  (C-63), the plugin's error as its `cause`: printed plainly, as every
  stage's throw is, never as vx's internal error, and the plugin's own
  error is never renamed (C-85). The floor's is untouched.
- `executorFailedOn(err)` — the executor's name on an error
  `nameExecutorFailure` made, else `undefined`: `run()` sets it as the
  task's `where`, whose row read `local` though the task was placed on
  the plugin's executor.
- `resolveCache(plugins, host)` → `CacheLayer`. `host` is a
  `CacheHost`: the hook's `CacheContext` (with the run's `scope`) plus
  the `localCache` and `policy` core keeps from plugins. Each plugin's `cache`
  hook returns a remote (`RemoteCacheLayer`); core puts every remote, in
  declared order, behind `host.localCache` in one `LayeredCache`, each
  gated by `host.policy` alone, and names the plugin
  in its warnings. No remote leaves the local store unwrapped.
  `REMOTE_CACHE_METHODS` is what a returned remote must carry; an optional
  `open`, `lend`, `hasMany` or `missing` that is there must be a function.
- `buildAdmission(plugins, nodes, concurrency, warn)` → the scheduler's
  `admit(id, running)` predicate, or undefined when no plugin declares
  `admit` (the scheduler then tracks nothing). Every declaring plugin is
  asked with the running tasks' nodes and the worker count, all must
  admit; a throw is warned once, naming the plugin, and that plugin
  admits from then on. A refusal while nothing local is running is
  overridden with one warning per plugin: only a completion asks
  again, so it stalled the run for good (item 1023). Both warnings say
  `[vx]` first, as every plugin warning on the status line does
  (`admit-warning-prefix.test.ts`).
- `teardownPlugins(plugins, warn)` — end-of-run, in declaration order,
  a plugin with a `cache` capability after every other (a teardown may
  write through the cache; one that revoked its token first refused the
  write, main 7bdbf01): each plugin's `teardown()` under try/catch and a time bound
  (`teardownTimeoutMs()`: 3 s; a
  call that never settles is warned by name, never awaited past the
  bound). A throw is warned as every stage names one (C-84):
  `plugin '<p>' failed in teardown: <reason>`; the run's verdict stands.
  Runs on every exit of a run once `prepareRun` has called the
  plugins' factories (an early return, a refused setup, a throw before
  or during the schedule, a hook that never settles) and at the end of
  a plan, and `prepareRun`
  itself tears down and closes the cache when a stage or refusal after
  the factories throws (item 1029); a plugin whose own
  `setup` threw is left out (item 1021). Telemetry sinks are flushed by
  the telemetry host, not here.

Every export above is named in this section; `tests/module-shape-drift.test.ts`
holds the list to the file.

### Invariants

- What a hook hands back is checked once, at the seam, and refused by
  plugin and hook: a `cache` / `executor` return missing the
  contract's methods, a `key` return that is not a record of strings
  or names a part with a NUL (the fold's delimiter, A-57), or holds a
  lone UTF-16 surrogate in a part (the fold's UTF-8 writes each as U+FFFD),
  a `schedule` return that is not a `Map`. A stage's edit is
  re-validated after EACH plugin (the `afterEach` of `applyConfigHooks`,
  `applyProjectHooks` and `applyGraphHooks`, the last over each node's
  task config), so the refusal names the plugin whose edit broke the
  config (H-13).
- A capability factory or stage that throws becomes a clean
  `UserError` naming the plugin and the hook: what a plugin does is
  load-bearing, never silently degraded (telemetry sinks are the
  observe-only exception, isolated in `telemetry-host.ts`).
- The finally-path disposers only unsubscribe; teardown is the flush
  point.

## `src/orchestrator/telemetry.ts` — canonical telemetry export contract

### Purpose

THE versioned, serializable contract every telemetry consumer speaks
(`TELEMETRY_SCHEMA_VERSION = 4`). Exporters (otel, a custom sink) receive
these records instead of re-deriving facts from the rendering-oriented
`WireEvent` stream — `cacheSource` is derived once (`none` for a task
that never engaged the cache, and for a `failed` hit whose restore threw:
neither a miss nor a hit), git/CI/host context
is pre-folded, bigint wallclock spans are decimal strings.

### Public surface

- `TelemetryRecord` — per-event union: `run.start` / `task.start` /
  `task.log` / `task.sample` / `task.end` / `run.end`.
- `RunSummaryRecord` — one per run: `RunContextRecord` + totals +
  per-task `TaskTelemetry[]`. What every telemetry sink receives at
  end of run. `abortedCount` (v3, item 851) counts the tasks a
  shutdown signal or an embedder's abort killed once started, each in
  `tasks` as `aborted`; `notRunCount` the ones the stop reached before
  they started, which are not. Without them a stopped run read as a
  failure with nothing failed; they count as the terminal's `1 aborted ·
1 not run` does, and `taskCount` as its `total` does, both included.
- `assembleRunSummary(run, tasks, timing)` — builds the `RunSummaryRecord`
  from the context and the `TaskTelemetry[]`, the per-task tallies
  derived from `tasks`, so a DTE run and a local one produce
  the same summary.
- `taskTelemetryOf(outcome)` — the one projection of a `TaskOutcome` into
  `TaskTelemetry`, used by the streaming `task.end` record and the
  summary's `tasks[]` alike, so the two cannot drift (item 660).
- `createTelemetrySource({ sinks, run, warn?, owners?, nodes?, every? })`
  → a `TelemetrySource` — projects the bus once and fans out to sinks.
  `run` is the `RunContextRecord` stamped on `run.start`; `owners` names a
  nameless sink by its plugin; `every` is the sampler's interval (default
  `setInterval`, unref'd), which a test ticks by hand.
- `TelemetrySink` — what a `telemetry` plugin returns: an optional
  `name`, a `wants` list of record kinds (the source checks it BEFORE
  projecting, so a sink pays nothing for kinds it declines), and
  `onRecord` / `onRunSummary` / `flush`. Every one is crash-isolated and
  `flush` is deadline-bounded. A warning names the sink by its `name`,
  else by its plugin's (`org/p`, or `org/p #2` for the second of a
  list), else by its place in the source's list (`#2`; item 1027).
- `TelemetryContext` — what the hook is handed: `workspaceRoot`,
  `cache.dir` (a STRING, not a Cache handle — a sink cannot reach the
  cache) and `warn`.
- `TelemetrySource` — the live projection: a bus `subscriber`,
  `emitSummary`, `flush` and `endServers(final, keep?)`, which sends the
  held `task.end` of each persistent task not in `keep`, read from
  `final`.
- The status vocabulary every record carries (`TaskStatus`,
  `CacheSource`, `isPassStatus`, `isCacheHit`) is graph's
  (`graph/task-status.ts`, scheduler.md).
- `TELEMETRY_SCHEMA_VERSION` — bumped when a record's shape changes, so a
  receiver can refuse what it cannot read.
- `taskLogMasks` — each running task's secret mask, which
  `execute-task.ts` sets; `task.log` masks the live chunks again through it.

### Records

What a sink receives, field by field (`TELEMETRY_SCHEMA_VERSION` 4;
held to the source by `telemetry-doc.test.ts`). An optional field is
additive: a consumer treats it as absent when a producer predates it.

```ts
interface RunContextRecord {
  runId: string // ULID shared by every record of one run
  vxVersion: string
  command: string // the command line; what follows `--` counted, never quoted
  requestedTasks: readonly string[]
  cachePolicy: string // the --cache-policy spec, e.g. 'local:rw,remote:r'
  concurrency: number
  flow: 'focused' | 'broad' | null
  workspaceId: string // from the normalized git remote (v2)
  workspaceName: string
  repository?: string // the origin remote, normalized: `github.com/org/repo`
  workspacePath?: string // the workspace root inside its git work tree, `.` at the top
  commitSha: string | null
  branch: string | null
  defaultBranch: string | null // a trunk run: branch === defaultBranch (v2)
  dirty: boolean | null
  ci: boolean
  ciProvider: string | null
  ciRunUrl?: string // the CI provider's page for this run
  ciChange?: string // the pull or merge request number (a merge queue or train run's too)
  ciPipeline?: string // the CI workflow or pipeline name
  ciJob?: string // the CI job (or step)
  ciAttempt?: number // 1 on a first run, 2 on its first re-run
  host: string | null
  os: string
  arch: string
}

interface TaskTelemetry {
  taskId: string
  project: string
  task: string
  status: TaskStatus
  cacheSource: CacheSource
  exitCode: number
  durationMs: number
  hash?: string
  cpuMs?: number
  peakRssBytes?: number
  where?: string // an executor's placement; absent when run here
  carried?: true // a persistent task its dependants' executor started where they ran: no execution of its own
  outputs?: 'deferred' // the outputs stayed remote (`--cache-download=none`)
  attempts?: number // more than one: the task retried
  blockedBy?: string // on a skipped task, the failure at the root of it
  otherPlatform?: { needs: readonly string[]; host: string } // on a skipped task, its `exec.platforms` leave the machine out
  timedOut?: true // on a failed task, vx's own timeout killed it
  sandboxViolations?: number
  notReady?: 'timeout' | 'exited' | 'spawn' // a persistent task never ready
  failedAttempts?: readonly FailedAttempt[] // a retried task's attempts that failed, in order
  flaky?: { passes: number; failures: number } // proved flaky this run: its key's record
  sandboxViolationLines?: readonly string[] // one per sandbox denial
  storedDurationMs?: number // on a hit: the stored run's time, what the hit saved
  storedCpuMs?: number // on a hit: the stored run's CPU and peak memory
  storedPeakRssBytes?: number
  admissionHeldMs?: number // how long an `admit` policy held it once ready
  queuedMs?: number // how long it waited ready for a worker, any admission hold included
  inputFiles?: number // on a cacheable task that ran: the files its key read
  inputChanges?: InputChanges // and what its key changed since the last saved entry, ten named
  artifactBytes?: number // the artifact's compressed size: a hit's entry, or a miss's save
  fetchMs?: number // a remote hit this run pulled: download + ingest
  saveMs?: number // a miss that saved: the save's own time
  restored?: boolean // on a hit: outputs restored (true) or already up to date (false)
  wallclockStartNs?: string // bigint ns from the run's start, as a decimal string
  wallclockEndNs?: string
}

interface RunSummaryRecord {
  v: number
  run: RunContextRecord
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number // every task, as the terminal's total: `tasks` plus `notRunCount`
  failedCount: number
  abortedCount: number // started, then stopped by a signal or an abort; in `tasks` (v3)
  notRunCount?: number // the stop reached them first; not in `tasks`, absent when none
  hitCount: number
  hitLocalCount: number // hits by the layer that answered, up-to-date ones included
  hitRemoteCount: number
  upToDateCount: number // hits by what they did to the disk; the three sum to hitCount
  restoredLocalCount: number
  restoredRemoteCount: number
  exitOk: boolean
  tasks: readonly TaskTelemetry[]
  stages?: readonly RunStage[] // VX_DEBUG_TIMING's stages; those before the run lock end before startedAt
  uploads?: { count: number; bytes: number; ms: number; failed: number } // remote uploads once settled; ms summed
  machines?: readonly MachineReport[] // TaskExecutor.machines: each machine an executor ran tasks on, with what it did
  idealMs?: number // TaskExecutor.idealMs: the run's end placed perfectly, beside totalDurationMs
  advice?: readonly WorkerAdvice[] // TaskExecutor.advice: the workers that would have run it best
}

interface FailedAttempt {
  endedAt: number // epoch ms
  exitCode: number
  timedOut?: true
}

interface RunStage {
  name: string // a stage mark: startup, load configs, classify + probe, run graph, …
  startedAt: number // epoch ms, with a fraction
  endedAt: number
}
```

Each streaming record carries `v` and `kind`, and:

| `kind`        | Fields                                                             |
| ------------- | ------------------------------------------------------------------ |
| `run.start`   | `run`, `total`, `ts`, `startedAt`, `originAt` (the stages' start)  |
| `task.start`  | `runId`, `taskId`, `project`, `task`, `command`, `dependsOn`, `ts` |
| `task.log`    | `runId`, `taskId`, `stream`, `chunk`, `ts` (opt-in)                |
| `task.sample` | `runId`, `taskId`, `ts`, `cpuMs`, `rssBytes` (opt-in)              |
| `task.end`    | `runId`, `ts`, every `TaskTelemetry` field                         |

A task the stop reached before it started gets neither `task.start` nor
`task.end`, as it is not in the summary's `tasks`. A persistent task's
`task.end` (its `ts` still its ready) waits for its final outcome: the
end of the graph, or, for a server the foreground keeps, the end of
that session, with the summary, whose `endedAt` is then the session's.
A server that crashed after its ready reads `failed` there, and one a
stop took down in the session reads `aborted`, as a stop's tasks do
elsewhere (the run history keeps it a success).
| `run.end` | `runId`, `ts` |

### Invariants

- **Observe-only by construction**: sinks receive plain-data records and
  a read-only context. A record and the summary are one object every sink
  receives, frozen once and deep (`freezeDeep`), so a sink's write throws
  and switches that sink off: it reaches neither core (a `task.end` holds
  the outcome's own arrays) nor a later sink. No bus, no Cache, no path
  back into scheduling (`plugin-read-only.test.ts`).
- **Crash isolation**: a throwing sink is disabled for the run, never
  propagates, and so is an `async` hook that rejects; it is said once,
  however many rejections follow (`telemetry-async-hooks.test.ts`).
- `task.log` is opt-in via `TelemetrySink.wants` (default excludes it).
  Its chunks pass a second `mask.stream()` per task and stream
  (`taskLogMasks`): the live mask lets a held piece go after 25 ms, so a
  value printed slowly reached a sink in pieces it joined whole. This one
  holds the piece until more output, the task's `task:complete` or
  `run:end`, never on a timer.
- `task.sample` is opt-in the same way. Only when a sink wants it does the
  source offer `track(taskId, pid)`, which run.ts hands each task's
  executor as `ExecuteRequest.onSpawn`: one timer for the run samples each
  tracked task's live process tree every second (`sampleTrees`,
  `exec/proc-sample.ts`) and stops when nothing is tracked or the run
  ends. `cpuMs` is the tree's CPU so far (a descendant that exited leaves
  the sum), `rssBytes` its resident memory now. Stopping a track answers
  its `TreeLoad`: the most cores one interval burned and the mean memory
  over the looks, which the run history keeps (`runs.peak_cores`,
  `avg_rss_bytes`). No sink wanting it: no timer, no read
  (`proc-sample.unsafe.test.ts`).
- Version bumps are additive-or-bump: a record whose shape changes bumps
  `TELEMETRY_SCHEMA_VERSION`, an integer, which a receiver may check to
  refuse what it cannot read; no first-party sink checks it.

## `src/orchestrator/telemetry-host.ts` — telemetry capability consultation

### Purpose

Sibling of `plugin-host.ts` for the observe-only `telemetry` capability:
asks each declared plugin for its sink(s), and only if at least one
exists wires a `TelemetrySource` onto the run's event bus.

### Public surface

```ts
export interface TelemetryHandle {
  emitSummary(summary: RunSummaryRecord): void // to every sink, crash-isolated
  flush(): Promise<void> // every sink's flush, crash-isolated, time-bounded; each sink's signal aborts at the deadline
  dispose(): void // remove the bus subscription; idempotent
  readonly track?: (taskId: string, pid: number) => () => void // TelemetrySource.track, when a sink wants task.sample
}

export async function subscribeTelemetry(
  plugins: readonly VxPlugin[],
  bus: EventBus,
  ctx: TelemetryContext,
  run: RunContextRecord,
  extraSinks?: readonly TelemetrySink[], // an embedder's own sinks, ahead of the plugins'
  nodes?: ReadonlyMap<string, TaskNode>, // the task graph, for task.start's dependsOn through a group
): Promise<TelemetryHandle | undefined>
```

A plugin's `telemetry` may return one sink or an array. Each is checked
before it is kept: an object, `wants` an array of known record kinds when present, and at
least one of `onRecord` / `onRunSummary` a function — anything else is
refused with the shape that arrived named. A plugin that throws during
consultation is logged and skipped, and so is one whose `telemetry()`
does not settle within `teardownTimeoutMs()` (item 921: it held the run
before its first task, and a drained loop exited 0).

### Invariants

- **PERF INVARIANT**: zero registered sinks → returns `undefined`, no
  bus subscriber, no summary building — the hot path is byte-identical
  to a run with no telemetry plugin. A plugin that declines (e.g.
  `otel()` without an OTLP endpoint) costs nothing.
- Sink construction failures are isolated and warn; they never fail
  the run.

## `src/orchestrator/run-context.ts` — git/CI/host capture

### Purpose

The per-run context for the `invocations` header row and the telemetry
`RunContextRecord`: commit, branch, dirty, CI provider, host/os/arch —
and, for the telemetry schema's multi-workspace story, a stable
workspace identity and the repository's default branch.

### Public surface

```ts
export interface GitContext {
  commitSha: string | null // HEAD's commit, or null outside a repo / on failure
  branch: string | null // HEAD's branch, or null when detached
  dirty: boolean | null // passed in by the caller; null when unknown
}
export interface CiContext {
  ci: boolean
  provider: string | null // 'github' | 'gitlab' | 'buildkite' | 'circleci' | 'generic' (bare `CI`), or null
  runUrl?: string // the provider's page for this run
  change?: string // the pull or merge request number
  pipeline?: string // the workflow or pipeline name
  job?: string // the job (or step) within it
  attempt?: number // 1 on a first run, 2 on its first re-run
}
export interface HostContext {
  host: string | null
  os: string
  arch: string
}
export interface WorkspaceIdentity {
  id: string // stable 16-hex id — the same for every checkout of the same repo
  name: string // the repo (or root dir) basename
  repository?: string // the origin remote, normalized: `github.com/org/repo`
  path?: string // the root inside its git work tree, `.` at the top; absent outside git
}

export function captureGitContext(
  workspaceRoot: string,
  dirty?: boolean | null,
  env?: NodeJS.ProcessEnv,
): GitContext
export function captureDefaultBranch(env: NodeJS.ProcessEnv, workspaceRoot: string): string | null
// A checkout's cache scope from `.git` alone: `<owner>/<repo>:<branch>`, the
// branch it tracks on that remote's repository, else its own on origin's;
// undefined on the default branch (as cacheRefs finds it), a detached HEAD or with no remote URL.
export function localBranchScope(
  workspaceRoot: string,
  baseBranch: string | undefined,
  env?: NodeJS.ProcessEnv,
): string | undefined
// The run's scope: VX_CACHE_SCOPE (empty: none), else the plugin's
// (setBranch; null: trusted, none), else, with a cache plugin, localBranchScope.
export function resolveCacheScope(
  workspaceRoot: string,
  pluginScope: string | null | undefined,
  hasRemote: boolean,
  baseBranch: string | undefined,
  env?: NodeJS.ProcessEnv,
): string | undefined
// The refs a remote reads, in order: a plugin's (`setBranch`; github()
// and gitlab() on CI), else git's current branch, then the default
// branch: `baseBranch`, else captureDefaultBranch's, else the first of
// origin/main, origin/master, main, master that exists (a clone whose
// `git push -u` wrote no origin/HEAD). Core reads no CI env for them.
// `turboCache()` sends them.
export function cacheRefs(
  workspaceRoot: string,
  baseBranch: string | undefined,
  pluginRefs: readonly string[] | undefined,
  env?: NodeJS.ProcessEnv,
): string[]
/** The run's branch: `run.branch` if set, else HEAD's, else CI's for a detached checkout. */
export function currentBranch(
  workspaceRoot: string,
  workspace?: unknown,
  flag?: string,
  env?: NodeJS.ProcessEnv,
): string | null
export function detectCi(env: NodeJS.ProcessEnv): CiContext
export function captureHostContext(): HostContext
export function normalizeRemoteUrl(raw: string): string
export function captureWorkspaceIdentity(
  workspaceRoot: string,
  originUrl?: string | null, // the enumeration's `git var -l` answer; undefined asks git
): WorkspaceIdentity
```

- `captureGitContext(root, dirty, env)` — reads `HEAD` from the `.git`
  files first (a `.git` directory or a linked worktree's `gitdir:` file,
  a symbolic or detached HEAD, loose refs and `packed-refs`): no spawn
  on a familiar layout. A repository in reftable ref storage (a
  `reftable/` directory; its HEAD file names `refs/heads/.invalid`) is
  never read from its files, and anything else unfamiliar falls back
  to ONE
  `git rev-parse HEAD --symbolic-full-name HEAD` spawn (commit on line
  1, ref on line 2; the full name, so a tag named like the branch cannot
  make it `heads/main`), behind try/catch. A branch with no commit yet
  still reports its name (a second `git symbolic-ref` spawn when the
  files cannot say). A detached HEAD takes the branch the CI
  environment names, when one does. `dirty` is passed in — the run's
  `GitFilesCache` populate already ran `git status --porcelain`, so no
  second status spawn. Each field degrades to null independently.
- `captureDefaultBranch(env, root)` — the branch whose runs feed the
  shared scheduling baseline (an experiment on a branch must not count
  into main). Ladder: GitLab's `CI_DEFAULT_BRANCH`; GitHub Actions'
  event payload (`repository.default_branch`, one best-effort JSON
  read); else `refs/remotes/origin/HEAD` read from its ref file, or
  `git symbolic-ref --short refs/remotes/origin/HEAD` when the file
  cannot answer (packed, reftable), with the `origin/` prefix stripped. Null when none resolve — the consumer
  then counts every run. Never throws.
- `detectCi(env)` — the provider matrix, first truthy variable wins
  (present and not `0` / `false`): `github`, `gitlab`, `buildkite`,
  `circleci`, and a bare `CI` as `generic`.
- `captureHostContext()` — hostname/os/arch.
- `captureWorkspaceIdentity(root, originUrl?)` — the same id from any machine's
  checkout of the same repo: the `origin` remote URL normalized
  (`normalizeRemoteUrl`: `git@github.com:o/r.git`,
  `ssh://git@github.com/o/r` and `https://github.com/o/r.git` all
  reduce to `github.com/o/r`; no credential survives: the userinfo ends
  at its last `@` and a query or fragment is dropped) and hashed; no remote → a salt persisted
  at `<root>/.vx/cache/workspace-id`, beside a `*` `.gitignore` of its own (`ignoreDir`, writing util's `IGNORE_ALL`)
  (a cache elsewhere leaves no `.vx/.gitignore` naming it); an unwritable `.vx/cache/` → the root path
  itself. The URL comes from the enumeration's `git var -l` when given,
  else one `git` spawn behind try/catch; called only when telemetry is
  active. Never throws.

### Invariants

- A plain run pays no git spawn here: the context reads `.git` directly,
  and the identity is captured only for a telemetry-bearing run (one
  spawn then, two if `.git` is unfamiliar). Never fails a run.

## `src/orchestrator/stable-keys.ts` — shared stable-key derivation

### Purpose

Identifies tasks whose cache key is provably independent of any
upstream's OUTPUTS — the only tasks safe to probe/restore ahead of the
schedule. Factored out so remote-prefetch and the local short-circuit
can never drift on the stability gate.

### Public surface

- `rederiveKeys(args, keys, dirty)` — the keys `deriveStableKeys` would
  make, from the last derivation under the same graph (`orchestrator.md`'s
  delta row): each `dirty` task's key derived again over its deps' keys,
  in the walk's order, the rest kept. Given `keys`, `deriveStableKeys`
  fills it with every key it makes, in that order.
- `deriveStableKeys(args: DeriveStableKeysArgs): StableKey[]` — `StableKey`
  is `{ hash, node }`; topo walk deriving every task's key the
  same way execute-task does; returns stable+cacheable non-group tasks
  with their keys. A persistent task is keyed as on the live path (the
  two paths must agree, item 727: a key only one path had gave its
  dependents a second key a `--force` run never saved under;
  `keyed-projects.test.ts` R4 compares them). Given `uncachedKeys`, it
  also fills in each uncached task's key when nothing upstream may
  write into its project or anywhere (no transitive producer or
  unfolded rewriter there, no workspace writer, no unstable dependency):
  an uncached key reads its whole project, so `dependsOnSiblingOutputs`,
  which answers false for it, is not that gate
  (`uncached-key-once.test.ts`). Given `groupKeys`, it records every
  unkeyed group's key with the synthetic upstream it folded, stable or
  not: execute-task compares that upstream with the live one before
  reusing the key (`group-key-once.test.ts`).
- `gatedOutputs(nodes, workspaceRoot)` / `askIgnoredOutputs(gated, workspaceRoot, nodes)`
  — the outputs some reader's inputs reach (its own project's, and any
  project's for a `workspaceFiles` reader), and one `git
check-ignore` over their directories (`util/git-ignored.ts`) that
  `prepare` starts beside the git enumeration and settles into
  `GitFilesCache.ignoredOutputs` once the listing is in: a deep glob
  (`**/dist/**`) counts only when the listing holds no file it matches
  (a tracked output, a directory a `!` rule takes back). Nothing reached:
  no spawn. The same spawn asks of every directory a task names outright
  (`namedOutright`) whether git ignores a new file in it, settled by
  `GitFilesCache.answerNewFilesIgnored`, so the key spawns no
  `check-ignore` of its own; a spawn git refuses (a path past a symlink)
  asks the outputs again alone.
- `dependsOnSiblingOutputs(node, upstreamOutputProjects, hasWsOutputUpstream, dirByProject?, sameProject?)`
  — the conservative gate, fed the TRANSITIVE-upstream output producers
  `deriveStableKeys` accumulates in topo order. The key is preliminary
  (→ unstable) when a same-project upstream declares `outputs.files`
  its input globs can meet (literal prefixes, ancestor or equal; A-20:
  a `test` reading `src/**` after a `build` writing `dist/**` is stable;
  X-54: an output the task's own `!` inputs take back whole, by
  `outputTakenBack`, does not count, so `['**/*', '!dist/**']` is too;
  nor does an output git ignores whole, `sameProject.readableOf`, from
  `GitFilesCache.ignoredOutputs`),
  when a same-project upstream may write undeclared (every input), when
  its own `outputs.files` meet another same-project task's (M-5: restored
  early, it raced the producer's restore), when ANY upstream declares
  `outputs.workspaceFiles` (it may land in this project), or the task
  reads `inputs.workspaceFiles` whose literal prefixes reach an
  upstream `outputs.files` producer's outputs: their globs, less what
  git ignores whole unless an entry starts inside it, as for a
  same-project reader; the producer's whole directory when it may
  write undeclared there, or without `sameProject`.
  Transitive because a producer reached through a no-output intermediate
  still poisons the key. A task with no `cache: true` is a producer too,
  where `undeclaredWriteReach` (`orchestrator.md`) says it may write:
  its own project counts as an `outputs.files` project, the rest of the
  workspace as an `outputs.workspaceFiles` producer, and a sandboxed one
  with no write grant as nothing; a sandboxed one's grants in its project
  are checked against a same-project reader's inputs as declared outputs
  are (`grantedWriteGlobs`: a server granted `node_modules/.vite/` leaves
  an e2e reading `e2e/**` stable, so a hit no longer boots it, 2026-11-12)
  (item 743: an uncached `gen` writing a
  same-project `build`'s declared input was classed stable, and seeds
  A,B,B,A replayed B on the fourth run, turborepo#13788).

  A **cached** task may rewrite its own inputs in place (a formatter with
  `outputs: []`), and `commandWriteReach` says where: it counts only for
  a reader whose key does not fold its key, on some path of folds
  (`tasks: []`, or a filter that leaves it out, a keyed group's own
  filter included: read as folding everything, a keyed group's
  `tasks: []` hid the rewriter and its reader was restored). A key that folds the
  rewriter's names what it writes, since what it may rewrite are its own
  inputs; a key that does not was taken over the bytes before it (item
  750: the cached twin of 743's A,B,B,A, replaying B on the fourth run).
  So `deriveStableKeys` carries two sets per task: the projects of every
  cached rewriter upstream, and the subset its key does not fold. A
  dependency it does not fold hands over the whole first set, one it
  folds only its own uncovered subset (a rewriter behind an unfolded
  edge stays uncovered however many folds follow). A cached rewriter
  whose reach is every project — a sandbox grant elsewhere in the
  workspace, or a fingerprinted root file (`mayWriteFingerprint`) —
  makes an unfolding reader unstable; one it folds is already unstable
  itself and inherited. An **uncached** task that may rewrite a
  fingerprinted file (a root `pnpm install`) makes every reader after it
  unstable, folding or not: every key folds the fingerprint, and the
  run re-checks it before a lazy probe (`orchestrator.md`).
  Only a key that leaves some dependency's key out can be preliminary
  for a cached rewriter, so a graph with no `inputs.tasks` filter
  builds none of the sets: building them cost about 2 ms (median) of a 27 ms memoised walk
  over the 3,000-task bench.

- `probesAfterWrites(nodes, workspaceRoot): ReadonlySet<string>` — the
  cached tasks with `inputs.runtime` / `workspaceRuntime` probes
  behind a writer their key does not fold (X-34). A probe is a shell
  command and may read anywhere, so its answer taken up front is the
  previous run's bytes. A writer is an upstream whose command may write
  (`commandWriteReach`) or that declares outputs; "does not fold" is
  `graph/folds.ts`' `foldedDeps`, transitively (a writer behind a
  folded dependency that leaves it out counts; so does a folded writer
  that is not cached, whose writes its key does not follow). `deriveStableKeys`
  takes no key for such a task (unstable, so never probed or restored
  ahead of its writer, and its probe is not spawned up front), and
  `ComputeHashArgs.probesAfterWrites` answers its probes for it alone.
  A key that folds a cached writer's keeps the run's shared answer: an early
  answer then costs a spurious miss on the run after the bytes change,
  never a stale hit. Memoised per graph; a graph with no probe walks
  nothing.

The helpers (`synthUpstream`, `foldedBy`, `topoOrder`) are internal and
not exported.

### Invariants

- When unsure → unstable (lazy read-through is always correct).
- Reuses the run's `hashCache`; touches NO cache layer (keys only).

## `src/orchestrator/run-keys.ts` — a warm run's keys, read back whole

### Purpose

The up-front pass (`orchestrator.md`) derives every stable key and every
reusable uncached key one task at a time. With every fold memo row
answering, that walk still cost 250 ms of a 1,070 ms warm run at 9,600
tasks (2026-10-22). The run key memo stores the pass's result under one
token for the whole selection and hands it back when the token matches,
so a warm run that changed nothing derives no key. A run after an edit
derives only the keys the edit reaches (the delta row, below): one file
changed at 200 tasks keyed all of them again, 22 ms of a 120 ms run
where Turbo took 109 (2026-10-28).

### Public surface

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
// The code that derives keys, as a stamp (orchestrator.md shares it).
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
  output adders and files token's hash (`cache.md`, the fold memo's), and the
  declared env values. When the nodes are a remembered graph no plugin
  or flag edited (`hashCache.graph`, graph-memo.md), that graph's token
  stands for each task's project, edges, config and adders, and a task
  adds only its id, `requested` and files token hash. It answers undefined, and the run derives as
  before, when there is no fold memo, or any task is keyless, has an
  excluded upstream, declares `runtime` or `workspaceRuntime` inputs,
  or has no files token (an untrusted input, an ignored path a
  declaration reaches). A `workspaceFiles` declaration is in the files
  token (`cache.md`): refused, every key of a repo whose tasks read a
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

## `src/orchestrator/graph-memo.ts` — the task graph, read back whole

### Purpose

Building 1,206 tasks' graph was 4.5 ms of a warm run (2026-10-23), nearly
all of it code a short process runs cold. The graph memo stores the graph
a run built in `fold_memo` and reads it back when nothing it is built from
moved: half the cost. Its token also names every node's config and edges
for the run key memo (`orchestrator.md`), which then serializes no config.

### Public surface

```ts
export interface GraphMemo {
  folds: FoldMemo
  lock: string // lockDigest of the lock the configs were read from (lockfile.md)
  metas: readonly ProjectMeta[]
}
export function memoGraph(
  options: Parameters<typeof buildTaskGraph>[0],
  memo: GraphMemo | undefined,
): { nodes: Map<string, TaskNode>; token: string | undefined }
```

- `memoGraph` — `buildTaskGraph`, answered from the memo on a token
  match. The token is the code (`codeIdentity`), the lock's bytes, the
  root, the rules, whether edges have a source, the requested tasks, each
  discovered project's name, directory, config path and direct deps, and
  the loaded project names. The row holds each node's project, task,
  `requested`, deps, addition marks and stand-ins (`standInsOf`); a row naming a task no loaded
  config declares reads as absent. `token` is undefined, and the graph is
  built as before, with no memo or a scoped load (`undeclaredDeps`).

`prepareRun` passes a memo only when every config is the lock's: a fold
memo, no staged configs, a lock read, and no `project` plugin. It sets
`hashCache.graph` to the token, and clears it once a `graph` or `key`
plugin or `--exclude-dependencies` edits the nodes.

Tests: `tests/graph-memo.test.ts` (a read-back graph is the built one,
addition marks and stand-ins (`standInsOf`) included; a hit reads no config; another lock, edge or
project builds afresh; a scoped load is not remembered) and
`tests/graph-memo-run.test.ts` (a planted wrong graph is read when nothing
moved, and a task config edit, an env value a config reads, a workspace
file edit, a `project` or `graph` plugin and another selection each plan
the real one).

## `src/orchestrator/fingerprint-watch.ts` — has a task rewritten the lockfile?

### Purpose

The files the plugins claim ([`workspace.md`](./workspace.md#srcworkspacefingerprintts--claimed-root-files)) are
read once per run, before any task, and every key folds what their
claimant takes from them (a lockfile plugin's per-project parts). A task in the root
project may rewrite one of them: `pnpm install` without
`--frozen-lockfile` updates `pnpm-lock.yaml` and the installed tree. Every
key taken before that names a lockfile the tree no longer holds, and a
save under one filed bytes built against the new install under the old
lockfile's key, replayed whenever the tree went back to it (item 750).

The watch answers "has a claimed file moved since the run read it"
for the rest of the run, and re-learns the fact only after a task that
may have written one ran, so a run with no such task never touches the
files again.

### Public surface

```ts
export class FingerprintWatch {
  constructor(
    workspaceRoot: string,
    readonly names: readonly string[], // the claimed files
    read: ReadonlyMap<string, Uint8Array>, // the bytes of those present
    at: number,
  )
  wrote(): void
  moved(): readonly string[] | undefined
  say(log: Logger): void
}
```

- One per run, built by `prepareRun` from the claimed files it read
  (`readClaimedFiles`) and the moment it started reading them (`PreparedRun.fingerprintWatch`).
- `wrote()` — execute-task calls it after a command ran here for a task
  that `mayWriteFingerprint` (`sandbox.md`): an unsandboxed task
  in the root project, or a sandbox write grant covering a claimed
  file. With nothing claimed, no task does. A persistent one calls it once ready.
- `moved()` — the files that no longer hold what the run read, or
  undefined. Nothing is looked at until `wrote()` was called; then one
  `stat` per claimed file — following a link, as both reads do, so a
  symlinked lockfile rewritten through it is seen by its target's ctime
  (an `lstat` saw the link's, which never moved: a stale hit on every
  run after the link aged, item 760, `tests/in-run-writes.test.ts` › "a
  lockfile that is a symlink…") — and a file written since the read (by ctime,
  within `FILE_HASH_RACY_MS` as git judges its index, a second wider for
  a whole-second stamp, C-59) is read and
  compared with the bytes the run read.
  A file that appeared or went has moved. Once moved, the run stays
  moved: every key already taken folded the old bytes, even if a later
  task writes them back.
- `say(log)` — the run's one status line, however many tasks it
  withholds (below).

```text
[vx] a task rewrote `pnpm-lock.yaml` during the run, which a plugin puts into every key: nothing keyed before it is restored or saved from here on
```

### Where it is read

`execute-task.ts` asks before a lazy probe (a moved claimed file skips the
probe: the key would name the old lockfile) and before a save (a moved
claimed file withholds it). A task keyed up front never follows a writer:
the stability gate classes every reader after an uncached writer, and
every non-folding reader after a cached one, unstable (`orchestrator.md`).
The next run reads the new bytes and keys on them.

### Invariants

- Zero cost without a writer: `moved()` returns before any syscall.
- A task that writes a claimed file from outside the root project,
  unsandboxed, crosses a project boundary and is not watched.

## `src/orchestrator/download-policy.ts` — `--cache-download` modes + the deferral gate

### Purpose

Decides, ONCE per task at plan time, whether a remotely-executed task's
outputs come home. Two questions live here: what mode each task gets, and
which tasks are safe to defer at all. Both are answered before scheduling,
so `--dry` can show them and the scheduler never re-derives them.

See [`design/download-policy-cas-cache-2026-08.md`](../design/download-policy-cas-cache-2026-08.md).

### Public surface

```ts
export type DownloadMode = 'eager' | 'deferred' | 'never'

export function deferralEligibility(nodes: Map<string, TaskNode>): Map<string, string> // ineligible id → why
export function resolveDownloadModes(args: {
  nodes: Map<string, TaskNode>
  policy: 'all' | 'toplevel' | 'none'
  localPlaced: (id: string) => boolean // placed on a local executor — it writes in place
  remoteOnly: ReadonlySet<string> // `exec.remote: 'only'`
}): { modeOf: Map<string, DownloadMode>; downgrades: Map<string, string> }
```

- `resolveDownloadModes` — per task, in this order: `never` for
  `exec.remote: 'only'`; `eager` for policy `all` or a locally-placed
  task; `eager` for a requested or surfaced task under `toplevel`;
  `eager` for an ineligible producer, with the reason in `downgrades`
  (what `--dry` prints); else `deferred`. Groups get no mode. Under
  `all` neither a run nor `--dry` asks it: every task is eager, and no
  per-task map says so.
- `deferralEligibility(nodes)` → ineligible ids mapped to the reason.

### The gate

A dependent's key folds an upstream's KEY, never its output content
(pure-input transitive hashing), so deferral cannot move a key that way.
The one real channel is a task whose `inputs` can OBSERVE a
producer's outputs on disk — then its key differs by whether the bytes
arrived. Ineligible producers run `eager`; a refusal would break a
working build, so the gate is a DOWNGRADE, never an error.

Four ways to be ineligible, each conservative in the direction that
matters:

- a same-project reader whose input-glob static prefix can overlap one of
  the producer's output-glob prefixes (`src/**` vs `dist/**` cannot, and
  the coarse "same project" rule the design first sketched would have
  left `--cache-download=none` with nothing to defer);
- any task declaring `inputs.runtime` / `workspaceRuntime` — a
  shell command's reads cannot be bounded, and deferral SKIPS the output
  clean, so a stale prior build is exactly what it would sample;
- any task declaring `inputs.workspaceFiles` (boundary-free);
- the producer declaring `outputs.workspaceFiles` (root-anchored).

A leading wildcard yields prefix `.` and reaches everything; a task with
empty `inputs.files` counts as reading its whole project. A task with
`inputs` and no `cache: true` counts as a reader when a cached task
depends on it (the cached task folds its key); one with no `inputs` has
no key to read. The
prefixes are compared as PATHS, not as strings: `staticPrefix` normalizes
the spelling, because `./out/**` and `out/**` name one tree to the input
resolver and two different prefixes to a raw comparison — which deferred
a producer its own reader could see, and moved that reader's key with a
transfer flag (item 441).

### Invariants

- `--cache-download` is a RunOption, never task config, and never folded into a
  key — it is transfer tuning and cannot change what a command produces.
- `exec.remote: 'only'` is `never` in both directions; `--cache-download`
  cannot override it.

### Tests

`tests/download-policy.test.ts` (gate both directions incl. the
false-positive controls, mode resolution, the e2e lifecycle, and a
same-project reader whose key must not move with `--cache-download` however
its glob is spelled).

## `src/orchestrator/deferred-outputs.ts` — the deferred-output registry

### Purpose

Run-scoped home for tasks whose outputs were left in the remote store
(`--cache-download=none` / `toplevel`), plus the lazy materialisation that
fetches them when a locally-placed task turns out to need them.

### Public surface

```ts
export interface DeferredEntry {
  materialize: () => Promise<void> // fetches the producer's outputs into its project dir
  hash: string
  entry: { taskId: string; command: string; durationMs: number; stdout: string }
}

export interface DeferredOutputsArgs {
  nodes: Map<string, TaskNode>
  cache: CacheLayer
  workspaceRoot: string
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache?: GitFilesCache
  localWrite: boolean
  log: Logger
  commandWindows?: CommandWindows // the run's (command-windows.ts): the clean and fetch open a window under the producer's id, as a hit's restore does, so `vx watch` does not take the fetched outputs for the user's edit
}

export class DeferredOutputs {
  constructor(args: DeferredOutputsArgs)
  register(taskId: string, entry: DeferredEntry): void
  pending(): string[]
  materializeFor(node: TaskNode): Promise<void>
}
```

- `register(taskId, {materialize, hash, entry})` — execute-task calls this
  instead of saving, when a deferred result comes back.
- `materializeFor(node)` — fetch every deferred producer in `node`'s
  TRANSITIVE dependency closure. Which upstream bytes a command reads is
  unknowable (that is what `dependsOn` declares), so the whole closure is
  taken; each producer materialises at most once per run and they run
  concurrently. The closure is walked pre-order on an explicit stack: it
  is as deep as the graph, and a recursion per edge threw `RangeError`
  at 50,000. With nothing registered it returns before the walk: every
  miss of every run paid it, O(graph) a task.
- `pending()` — task ids whose outputs are still remote, for the run
  summary. An entry is cleared only on
  SUCCESS, so this covers both "nothing needed them" and "fetching
  them FAILED" — the second is exactly when a user needs telling
  their tree is not current.

### Invariants

- A deferred task writes NOTHING locally — no artifact, no `entries` row,
  no `output_files`. A row without an artifact is the corrupt-entry shape
  `restoreOutputs` refuses.
- Materialisation CONVERGES: clean → closure writes →
  `markOutputsChanged` → ordinary `cache.save`, mirroring `restoreHit`'s sequence
  so the two cannot drift. Afterwards the machine is indistinguishable
  from a `--cache-download=all` run, so no third storage state persists.
  A fetch that lands nothing under declared outputs gets the eager save's
  `outputs matched no files … an empty artifact is saved` warning.
- A failed fetch is the CONSUMER's failure, named with the producer and
  the remedy — executing against a half-materialised tree is the
  stale-input class with extra steps.
- Only core calls `materialize()`, and only before a locally-placed,
  cache-missing task. A cache HIT reads no inputs and triggers nothing;
  a remote-placed consumer grafts by reference.

### Tests

`tests/download-policy.test.ts` — no-local-entry, lazy materialisation,
memoisation (two consumers, one fetch), convergence to a local hit,
never-clean, fail-loud, the `--continue` interactions, and a producer
50,000 tasks below its consumer. `tests/deferred-output-empty.test.ts` — the
empty-fetch warning.

## `src/orchestrator/local-shortcircuit.ts` — restore-ahead classify

### Purpose

The up-front CLASSIFY behind the two-tier scheduler: derive every
stable, cacheable, local-read task's key and probe the local cache
ONCE. Confirmed hits become the RESTORE TIER (ready immediately, low
priority — they backfill idle workers while misses own the pool);
stable misses skip execute's lazy probe; unstable tasks stay dep-gated.

### Public surface

```ts
export interface ShortCircuitArgs {
  nodes: Map<string, TaskNode>
  cache: CacheLayer
  workspaceRoot: string
  claimedFiles: readonly string[] // the root files the plugins claim
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache // the run's memo — no double hashing
  concurrency: number // the probe pump's width
  localOnly?: boolean | undefined // `cache` is the local store before a remote: only hits are recorded
  remoteOnly?: ReadonlySet<string> | undefined // `exec.remote: 'only'` tasks a remote took: never probed
}
export interface ProbedEntry {
  hash: string
  hit: CacheEntry | null
}
export interface ShortCircuit {
  preProbed: Map<string, ProbedEntry> // every stable task's probe, hit or miss
  restoreTier: Set<string> // the confirmed local hits
  uncachedKeys: Map<string, string> // uncached task id → its reused key
  groupKeys: Map<string, UpfrontGroupKey> // unkeyed group id → its up-front key + upstream
  remoteAsk: Map<string, string> // behind a remote, each stable local miss → its key
}
export async function startLocalShortCircuit(args: ShortCircuitArgs): Promise<ShortCircuit>
// The tasks a workspace-output glob keeps out of the restore tier (`planRun` asks it too).
export function restoreTierExclusions(
  nodes: Map<string, TaskNode>,
  workspaceRoot: string,
): Set<string>
```

- `startLocalShortCircuit(args)` → `{ preProbed, restoreTier, uncachedKeys, groupKeys, remoteAsk }`.
- `uncachedKeys` — the up-front keys of uncached tasks that no upstream
  can change (stable-keys.md), minus every task `restoreTierExclusions`
  names (a root-anchored output may land in its project with no edge).
  execute-task uses one as `upfrontKey` instead of deriving it again:
  500 uncached tasks took 1,000 `task hash` calls (31.0 ms summed, min
  of 8) and now take 500 (10.6 ms); the wall moved within noise
  (B-91).
- `groupKeys` — every unkeyed group's up-front key with the upstream it
  folded (stable-keys.md). execute-task uses the key as `upfrontGroupKey`
  when the live upstream has the same ids and keys in the same order, and
  derives it otherwise: 1,090 `installDeps` groups were rolled up twice per
  warm run, ~30 upstream ids sorted, joined and hashed each time (X-149).
- `remoteAsk` — behind a remote cache, each stable task the local store
  missed, with its key: the remote may hold it. `held-servers.ts` holds a
  server whose every dependant is a local hit or in `remoteAsk` until the
  remote answers, and never starts it when all of them hit.
- `ProbedEntry { hash, hit }` — consumed by execute-task (probe reuse:
  the up-front probes ARE execute's probes, hoisted — no double work).

### Invariants

- Gated by `shouldShortCircuit` (run.ts): `localRead` on and at least
  one node. With a remote declared the classify probes the local store
  alone (`localOnly`): a local hit is certain and joins the restore tier
  as it does with no remote; a local miss is left out of `preProbed`, so
  execute asks the layers and the remote GETs stay on remote-prefetch's
  fire-and-forget path, never before the first spawn.
- An `exec.remote: 'only'` task a remote executor took (`remoteOnly`) is
  never probed: nothing here restores it. A held entry counted as a
  restore, so the run asked an executor's `demand` for no work and skipped
  the `schedule` stage, and a `@vzn/vx-dte` run waited on a worker it
  never started (2026-11-11).
- An `outputs.workspaceFiles` producer upstream takes its dependents out
  of BOTH tiers — not just the restore tier. A root-anchored output is
  boundary-ignoring, so it can land in a dependent's own project dir; and
  execute-task reuses a `preProbed` hash verbatim, which makes probe reuse
  a stale-hit path when the key is preliminary.
- On top of that, `restoreTierExclusions` keeps out of the restore tier
  every task whose project directory (or own `workspaceFiles` input
  prefix) a declared workspace output's static prefix reaches, and every
  transitive dependant of one; a prefix at the root reaches everything,
  which is the graph-wide rule item 584 replaced. The dependants are
  reached by one walk up the dependant edges on an explicit stack: a
  recursion per edge threw `RangeError` out of the classify, failing the
  run, on a 50,000-deep chain over a writer.
- Never throws — degrades to the normal schedule.
- Measured: mixed workload −6.6%; warm all-hit at parity.

## `src/orchestrator/remote-prefetch.ts` — background remote GETs

### Purpose

With a `LayeredCache`, remote GET latency would sit on each task's
critical path. This derives every STABLE task's pure-input key up front
(reusing the run's `hashCache` memo — no double hashing) and fires the
remote GETs concurrently before scheduling, so network overlaps
execution. `LayeredCache` ingests hits into local and de-dups against
the lazy read-through: at most ONE remote GET per key.

### Public surface

```ts
export interface PrefetchArgs {
  nodes: Map<string, TaskNode>
  cache: CacheLayer
  workspaceRoot: string
  claimedFiles: readonly string[] // the root files the plugins claim
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
  concurrency: number // the GET pump's width
  remoteRead: boolean // the policy's remote-read axis; false returns at once
  remoteWrite: boolean // with reads off: hand the keys to probeBeforeUpload
  held?: (ids: readonly string[], missed: readonly string[]) => void // once: the stable tasks a store holds, and those none does
  spans?: Record<string, unknown>[] // --profile: the keys' derivation and the batch probe
}

export function startRemotePrefetch(args: PrefetchArgs): Promise<void>
// The CacheGetContext a lookup passes: task id, masked command, declared outputs;
// shared with execute-task's own lookup
export function getContext(node: TaskNode, command: string): CacheGetContext
```

- `startRemotePrefetch(args)` → `Promise<void>` handle. Fire-and-forget
  for scheduling; `run()` awaits it before `cache.close()` only.

### Sequence

1. `deriveStableKeys` — the pure-input keys of every stable task
   (`orchestrator.md`); none, nothing to do.
2. The keys the local store already holds (`localHasMany`) are dropped:
   a run the local cache answers makes no remote call.
3. The hits the index kept from an earlier probe (`remoteKnown`, maybe
   another process's: `vx run --dry`, then `vx run`) are trusted now:
   their pulls start at once, waiting on no probe. `held` hears them,
   and every other key as missed, only when no batch probe follows.
4. One batched existence probe when the layer offers it
   (`remoteHasMany`): the hashes it reports absent are marked
   (`markRemoteAbsent`, so the lazy read-through skips them too) and
   only the present ones are fetched, except the first `concurrency`
   keys in graph order: those are pulled as the probe is sent, since on
   CI it answers after a GET does (~490 ms against ~250 ms), and their
   dependants then find their entries local. At most that many can 404.
   A task's own lookup waits on no probe: it GETs at once, since waiting
   made a hit two round-trips.
   Its whole answer is
   kept for the next run, and `held` hears it: a key the index lacked
   was often stored since (a PR's CI stores its merged tree), and
   calling it missed sized a run for work that restored. When the
   batch gives no answer and `held` is set, each key is asked on its
   own (`remoteHasEach`): with no answer demand counts every task left
   (main f71b377 asked 15 workers and cancelled 11).
5. `concurrency` pumps drain the list through the layer's `prefetch`
   (the hash, the task id and its command); a rejected fetch is
   swallowed.

### Invariants

- **Remote-only**: gated on the policy's `remoteRead` axis (the run
  passes it only when a remote layer is present); local runs never
  derive keys or probe anything here. With reads off and `remoteWrite`
  on (`--force`), the keys go to the layer's `probeBeforeUpload`
  instead: one `hasMany` per remote the run only writes that can
  batch (others ask `has` per upload), so an upload of a key it holds
  is skipped.
- Stability gate via `deriveStableKeys` — unstable (codegen-consumer)
  tasks stay on the lazy path.
- Never-fail: every path degrades to a miss.

## `orchestrator/doctor.ts` — the workspace doctor's facts

### Purpose

One collector for what `vx info` prints and its `--format json`
returns: the CLI renders, this gathers.

```ts
collectInfo(cwd, opts?: CollectInfoOptions): Promise<InfoFacts> // { cacheDir?, warn? }
stableSandboxReason(reason: string): string // the probe's reason with the pid-named socket path masked
```

`InfoFacts` is the typed object `vx info --format json` prints: `vx`,
`vxPath` and `handedOffFrom` (which vx ran, and the global one that
handed it the call, `index.md`), `bun`, `bunSupported` (false below `MIN_BUN` — `bun` itself stays the
bare version because this is a machine surface, and the prose goes in
the rendered row only), `git`, `gitStatusCache`, `workspaceRoot`,
`projects`, `tasks`,
`plugins` (`[{ name, seams }]`, the seams in `PLUGIN_HOOKS` order),
`workers` (`{ count, source, cores, cpuQuota }`), `memory`
(`{ usableBytes, totalBytes, cgroupLimitBytes }`), `cacheDir`,
`cacheVersion`, `schemaVersion`, `cacheEntries`, `cacheBytes`,
`settings` (`{ [path]: { value, source, plugin? } }`; source `plugin`, with its
name, for a value a plugin's `config` hook set),
`orphans`, `runs24h`, `hits24h`, `restored24h` (of those hits, the ones that restored outputs), `flakyTasks`, `lockfile`, `sandbox`
(`{ available, reason, declared, untraced }`: whether this host can run
an `exec.sandbox`, the probe's reason, how many loaded tasks declare
one, and why an available Linux sandbox cannot report the reads it
denies, else null). See
`docs/cli.md` § `vx info` for what each row means.

### Rules

- **The sandbox probe runs under the loads.** It asks nothing of the
  workspace, so it starts once the root and the workspace config are
  found (a refusal there comes first, with no probe ahead of it) and is
  awaited on every path, since the runtime it brings up holds the
  process open until it resets. The two git facts are asked while it
  runs: 113.8 → 107.3 ms median for `vx info` at 100 projects.

- **The task count is the run's.** It comes from the same staged load a
  run uses (`loadProjects` over the lock, plugin `project` stage
  applied). The doctor evaluates no config: with no lock, or one a run
  would refuse, the task and sandbox counts are zero and `lockfile` is
  the answer — a broken config is `vx lock`'s to report.
- **The machine as the process may use it.** `workers` and `memory` read
  `util/cgroup.ts`, so inside a container they say what the cgroup
  allows and name it as the source.
- **`cache.dir` follows the run's rule**: an override resolves against
  `cwd` exactly as `vx run --cache-dir` does, else the workspace's.

### Tests

`tests/show-info.test.ts` (the rows and the JSON facts end to end, the
`--cache-dir` override, the orphans row); `tests/info-lock.test.ts` (no
lock, and a config edited after the lock, are never evaluated).

## `src/orchestrator/task-log-buffer.ts` — bounded per-task log capture

### Purpose

The one bounded-tail buffer a telemetry sink uses to capture task
output, so the capping rules cannot fork between sinks. It lives in
core beside the telemetry contract for the same reason
`assembleRunSummary` does: two sinks each rolling their own buffer is
how the retention rule forks, and a forked rule means two sinks
disagree about which task's output survived. Core itself never
captures logs; today `@vzn/vx-otel`'s sink is the consumer.

### Public surface

```ts
export const LOG_WIRE_VERSION = 1
export const TASK_LOG_TAIL_CHARS = 128 * 1024 // per task, merged stdout+stderr
export const RUN_LOG_BUDGET_CHARS = 4 * 1024 * 1024 // per run, retained tails

export interface TaskLogEntry {
  taskId: string
  hash?: string
  status: 'success' | 'failed'
  content: string // the retained tail
  charsFull: number // what the task printed in all
  truncatedHeadChars: number // what the tail dropped from the front
}
export interface TaskLogBundle {
  v: typeof LOG_WIRE_VERSION
  runId: string
  workspaceId: string
  tasks: TaskLogEntry[] // failures first
}

export class TaskLogBuffer {
  append(taskId, chunk): void
  finish(taskId, status, cacheSource, hash?): void
  takeEntry(taskId): TaskLogEntry | undefined // one task, removed from the buffer
  drain(runId, workspaceId): TaskLogBundle // everything retained, failures first
  size(): number
  budgetUsed(): number // observability / tests
}
```

### The law

A log-spewing task can never OOM the capturer, and a cap always says
what it cut:

- **Per task**: only the last `TASK_LOG_TAIL_CHARS` are kept — whole
  chunks evicted from the head, no concatenation until drain, so a
  cache-hit replay (one big chunk) is one array push. A single over-cap
  chunk is sliced to its tail, never between a surrogate pair. `charsFull` and
  `truncatedHeadChars` ride with the entry, so "we truncated this"
  never reads as "this task printed nothing".
- **On finish**: a cache hit is DROPPED (the executed run already
  stored those bytes; a hit resolves by `hash` to that run);
  `skipped` / `aborted` are dropped; a success or failure that
  executed is RETAINED under the run budget.
- **Per run**: past `RUN_LOG_BUDGET_CHARS`, successes are evicted
  first (oldest first); failures go only when failures alone exceed the
  budget, newest first — the first failure is usually the root cause
  and the later ones its cascade. An evicted task degrades to a STUB
  (no content, everything counted as truncated), never disappears.
- The budget charges ~24 char-equivalents per retained chunk on top of
  the characters: measured on Bun 1.4, a million one-char chunks cost
  ~30 MB against ~1.4 MB for one chunk, so a pure char count would
  bound something other than memory.

### What it does NOT do

- Decide what a task's status or cache source is — the vocabulary is
  `TaskStatus` / `CacheSource` from the telemetry contract.
- Ship anything. A sink calls `takeEntry` per task or `drain` at the
  end and owns the transport.

### Tests

`tests/task-log-buffer.test.ts`: the tail cap, hit/skip dropping, the
two-tier eviction order, stub accounting
(`content.length === charsFull - truncatedHeadChars`), and the
charge/release symmetry `budgetUsed()` exposes — the invariant that
fails silently if a release does not match its charge.

## Plugins — core ships none

### Purpose

Core applies NO plugin on its own and ships none. Running a command
here and caching it on this machine (`~/.vx/<id>/cache`, or a named
`cache.dir`) are not plugins but core's FLOOR:
`resolveExecutors` appends `localExecutor()` (`src/orchestrator/local-executor.ts`)
to the tail of every executor list and `resolveCache` puts the host's
local `Cache` first in every chain, before each remote in declared order
(`src/orchestrator/plugin-host.ts`).
A `.vx/workspace.ts` that declares no plugin therefore runs and caches
(the file itself is required: it marks the workspace root), and a
plugin executor whose `accepts()` declines hands the task back to this
machine.

Every plugin is a package a workspace declares:

```ts
// .vx/workspace.ts
import { vxHistory } from '@vzn/vx-history'

export default { plugins: [vxHistory()] }
```

`src/plugins/` no longer exists. Its last occupant, the history-based
scheduler, moved to `@vzn/vx-history` on 2026-09-10; it had been
core's opt-in `predictive` mode until 2026-09-02 and a subpath export of
core until the move. What core keeps is what a plugin needs from the
façade: `localHistory` (rows, never a handle on cache.db) and the `HistoryTable` types for a
`schedule` plugin, `RemoteCacheLayer` for a cache plugin (core layers
it), the `TaskExecutor` contract for an executor.

### Isolation contract

- A plugin package imports core ONLY through the bare public specifier
  `'@vzn/vx'` (resolved inside this repo by the workspace link), never a
  `packages/*` path, never a sibling `@vzn/vx-*` — pinned by
  `tests/package-boundaries.unsafe.test.ts`.
- Core never imports a sibling package or any `packages/*` path: the
  dependency direction is plugin → core, never the reverse (same pin).
- `src/plugins/` stays absent: `tests/module-boundaries.test.ts` and
  `tests/package-boundaries.unsafe.test.ts` fail the day a directory
  appears there, so a new plugin starts life as a package.
- Every plugin package carries a root `index.ts` shim for compiled binaries built
  without `--compile-autoload-package-json` (vx 0.0.484 and older), which
  resolve packages by directory convention and ignore `exports`
  (`tests/package-entry-shims.unsafe.test.ts`). Core carries none: the
  binary serves `@vzn/vx` and `@vzn/vx/config` from its own copy.

### The packages

| Package            | Seam                              | What it does                                                                                                                                |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vzn/vx-history`  | `schedule` `admit` `commands`     | order ready tasks by the critical path learned from run history; pack the reservations learned from what they used; `vx history` shows both |
| `@vzn/vx-reapi`    | `executor`, `cache`               | Bazel REAPI: remote execution and remote cache                                                                                              |
| `@vzn/vx-otel`     | `telemetry`                       | OpenTelemetry export, no SDK dependency                                                                                                     |
| `@vzn/vx-cache`    | `cache`                           | `vxCache()`: the remote cache on a `@vzn/vx-cache-server` you host, written from CI jobs only                                               |
| `@vzn/vx-ci`       | `telemetry`                       | GitHub Actions job summary                                                                                                                  |
| `@vzn/vx-migrate`  | `project`, `fingerprint`, `cache` | `turbo()` / `nx()`: such a repo under vx with nothing written (`nx-exec` runs Nx executors); `turboCache()` / `nxCache()`: the wires        |
| `@vzn/vx-lockfile` | `fingerprint`, `key`              | `bun()` `pnpm()` `npm()` `yarn()`: the lockfile keyed per project — one install re-keys only the projects it reaches                        |
| `@vzn/vx-dte`      | `executor` `schedule` `commands`  | one run spread over workers the CI starts, through a relay; `vx dte worker`; `local()` workers in git worktrees                             |

### Tests

`tests/local-fallbacks.test.ts` (the floor: a workspace that declares no
plugin runs and caches; a declining executor falls back), the `NO PLUGINS` /
`CONTROL` e2e pins in `tests/plugin-capabilities.test.ts`, and each
package's own suite (CI's plugin-packages job).

## `src/orchestrator/migration.ts` — the migration seam

### Purpose

`applyMigration`, on the façade for any adoption tool: `workspace`'s
`writeMigration` renders, guards and writes the plan and runs the lock
step; `report`'s `drawMigration` draws what it did. Same name and shape
as before the split.

### Public surface

```ts
export function applyMigration(args: ApplyMigrationArgs): Promise<number> // the exit code
```
