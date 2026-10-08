# `src/orchestrator/{index,run}.ts` — end-to-end glue

## Purpose

Placement — which executor each task lands on, and the `--dry` view of
it — lives in `placement.md` since 2026-09-10; `run()` calls
`placeTasks` once and `planRun` calls `planExecutorOf`. Signal
forwarding (SIGINT/SIGTERM/SIGHUP to every child, exit 128+signo) is
`signals.md`; `run()` installs it before the graph and removes it in
its finally.

The orchestrator module's entry. `run.ts` hosts `run()` / `planRun()`;
`index.ts` is the module contract re-exporting them with
`RunOptions` / `RunSummary` ([`options.md`](./options.md)), `Logger` /
`defaultLogger` ([`logger.md`](./logger.md)), the `RunPlan` types
([`plan.md`](./plan.md)), and the plugin / telemetry / wire /
metrics surfaces the public API consumes. Invoked directly by
`cli/run.ts` — a run always executes in the `vx run` process, and the
scheduler never leaves it. Discovers the workspace, loads
configs, builds the task graph, opens the cache, installs plugins +
telemetry, fires cache acceleration (remote prefetch / local
short-circuit), schedules execution two-tier, manages persistent
subprocesses, writes optional artifacts, and records the run history.

Companion modules: [`plan.md`](./plan.md) for the read-only
`--dry` / `--graph` mirror; [`prepare.md`](./prepare.md) for the
shared setup; [`local-shortcircuit.md`](./local-shortcircuit.md) /
[`remote-prefetch.md`](./remote-prefetch.md) for the acceleration
passes; [`plugin.md`](./plugin.md) / [`telemetry.md`](./telemetry.md)
for the extension seams.

## Public surface

```ts
export function run(options: RunOptions): Promise<RunSummary>
export function planRun(options: RunOptions): Promise<RunPlan>
export function nxProjectTarget(spec: string, projects): string | undefined // Nx's `web:build` as `web#build`, when web declares build
export function projectNamed(typed: string, projects): string | undefined // `cart` as `@scope/cart`, when that is the one such project
export function shouldShortCircuit(nodes, policy, cache): boolean
export function invocationCommand(argv: readonly string[]): string // the args after `--` as `<n arguments>`
export function runLockPath(workspaceRoot: string, dir?: string): string // the lock directory
// The workspace's run lock (below); `vx cache prune` takes it too.
export function acquireRunLock(
  workspaceRoot: string,
  opts: { log: (line: string) => void; signal?: AbortSignal; dir?: string },
): Promise<() => Promise<void>>

// RunOptions highlights (full list in options.md):
//   cwd, tasks, projects?, concurrency?, cache?: CachePolicy, frozen?,
//   retries?, excludeDependencies?, forwardArgs?, outputLogs?, flow?,
//   summarize?, beforeFooter? (text above the footer), profile?, tags?, command?, log?, bus?,
//   inflight?, handleSignals?, signal? (AbortSignal: tear the run down and return),
//   holdPersistent? (return the requested persistent tasks still running)

export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
  persistent?: HeldPersistent // { ids, stop() }, set only under holdPersistent
  refused?: string // why the run refused to start; the caller prints it
}
```

## Algorithm — `run()`

1. **Color decision + event bus.** Programmatic logger → plain text;
   default logger → `detectColors()`. The renderer SUBSCRIBES to the
   run event bus (`terminalSubscriber`); `run()` emits through
   `busLogger` — it never calls the logger directly. The bus may be
   the caller's (`RunOptions.bus`) and outlive the run, so what `run()`
   subscribes on it leaves with the run: the renderer in the wrapper's
   finally (`runOnBus` is the body), a plugin's hooks and its direct
   `ctx.bus.subscribe` with `disposePlugins`, the telemetry source with
   its handle's `dispose()` (item 635).
2. **`prepareRun(options, log)`** — shared setup: discovery, scoped
   config loading (lock-backed under `--frozen`), package + task
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
   `liveChildren` set + `persistentRegistry` map. SIGINT/SIGTERM/SIGHUP
   handlers installed here, removed in a `finally`.
6. **Sandbox prepare.** `prepareSandbox(nodes)` — null when no node
   declares `exec.sandbox`; otherwise an armer whose probe + init run on
   the first sandboxed execution (sandbox-request.md).
7. **`markSurfacedDeps(nodes)`** — transparent-group display marking;
   the footer run context is built (there is no top-of-run header).
8. **Cache acceleration.** LayeredCache → `startRemotePrefetch`
   (background, drained before close). Local-only + local reads on +
   a non-empty graph (`shouldShortCircuit`) → `startLocalShortCircuit`,
   producing `preProbed` (probe reuse) + `restoreTier`.
9. **`runGraph({..., priorities, restoreTier})`.** Two-tier schedule;
   each ready node runs `executeTask` (with its pre-probe when
   present) through `admission.ts`: a service-supplied `inflight` map
   dedupes identical-hash tasks across concurrent delegated runs, and
   under `continueMode: 'always'` the taint of an upstream failure is
   tracked so the task's save is withheld.
10. **Persistent cleanup** (`persistent.ts`). `selectKeepAlive` picks
    the persistent tasks the user REQUESTED (or that were surfaced), and
    every persistent task a kept one depends on (directly or through
    groups: `vx run dev --filter app` keeps the `api#dev` its `app#dev`
    needs), to KEEP ALIVE in the real CLI foreground (`options.log === undefined
&& handleSignals !== false`); `shutdownPersistent` SIGTERMs every
    other persistent child's group and waits for the groups, SIGKILLing
    whatever is left after a 2 s grace (`VX_KILL_GRACE_MS` shortens it;
    see util-settle.md, kill-tree.md).
    Before the SIGTERM it returns the children that already ended on
    their own, not cleanly (`CrashedPersistent`: a non-zero exit or a
    signal): each fails the run, its outcome becomes `failed` with that
    code (a kept server that has already died likewise, item 1071), and
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
    Under `RunOptions.holdPersistent` (the watch loop) the same
    selection applies outside the foreground, and run() returns at
    once with the kept tasks on `RunSummary.persistent`: the caller
    owns them and its `stop()` is the same teardown. One that dies on
    its own after that is named (`vx: <id> exited with code <n>`,
    #2442), so a watch loop idling over a dead server says so; the
    teardown its `stop()` runs is not.
    `RunOptions.signal` aborts a run from outside through the same
    teardown: the scheduler dispatches nothing further (never-started
    tasks complete `aborted`) and run() returns to its caller.
11. **Summary.** `formatPersistentList` rows for kept-alive tasks,
    `formatOutcomeTable` when `summaryTable` (`--verbosity 1`),
    then `formatRunSummary(list, totalMs, colors, runContext)` — the
    footer carries the run banner (wordmark rule + projects/tasks/
    cache meters + info + time).
12. **Optional artifacts.** `writeRunSummary` / `writeRunProfile`.
    Errors logged, exit code unchanged.
13. **`assembleRunRecords` → `cache.recordRunBundle`**
    (`run-records.ts`). One pass over the outcomes builds the `runs`
    rows (one per real task; group + `aborted` skipped), the
    `invocations` header row (command, policy, git/CI/host context,
    tags, counts) and, only when a sink is active, the per-task
    telemetry mirror — so all three carry the same task count by
    construction. Written in one transaction.
14. **Telemetry summary.** When a sink is active: build + emit the
    `RunSummaryRecord`, await `flush()` (crash-isolated).
15. **Drain + close.** Await background prefetches/uploads,
    `cache.close()`, sandbox teardown.
16. **Keep-alive block.** If the user requested a persistent task,
    block on its exit AFTER everything above — Ctrl-C reaps the
    process group; the run stays in the foreground on purpose.

`planRun()` mirrors steps 1–3 via the same `prepareRun`, then
delegates to `orchestrator/plan.ts:plan(...)` inside a try/finally
that closes the cache. No scheduler, no spawn, no SIGTERM, no
recording.

## Forwarded-args scoping

`RunOptions.forwardArgs` are appended to user-requested tasks only.
A `TaskNode.requested === true` task sees the forwarded args appended
to its `exec.command` AND folded into its cache key; a dep-pulled
task ignores them entirely. (`surfaced` is display-only and does NOT
receive forwardArgs.) This keeps `vx run build -- --watch` from
leaking `--watch` into every dep's build AND keeps upstream cache
identity stable across CLI args.

## Persistent registry

`persistentRegistry: Map<taskId, Bun.spawn>` is owned here. The
scheduler sees persistent tasks as instant successes that resolve at
"ready"; the registry is the single place to tear them down — except
requested ones, which the foreground run keeps alive and blocks on at
the very end (the dev server IS the point of the run).

## Signal shutdown

`run()` installs SIGINT + SIGTERM + SIGHUP handlers for its own
duration (unless `RunOptions.handleSignals === false`) and removes them
in a `finally`, so repeated `run()` calls never stack listeners. On
signal: forward it (a SIGHUP as SIGTERM) to everything in
`liveChildren` + `persistentRegistry`, close the cache,
`process.exit(signalExitCode(signal))`
(130 / 143 / 129).
Children killed this way classify as `aborted` — not counted, not
recorded. Watch mode passes `handleSignals: false`; the loop owns
signal disposition for its whole lifetime.

## Failure semantics

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

## Tests

`tests/orchestrator.test.ts` — the heaviest test file in the repo:
runs, caching, cross-project graphs, forwarded args, failure
handling, persistent tasks, output cleaning, artifacts, boundary
enforcement, invocation + entry_inputs recording. Companions:
`tests/local-shortcircuit.test.ts`, `tests/orchestrator-remote.test.ts`,
`tests/telemetry.test.ts`, `tests/signal-handling.test.ts`,
`tests/output-flow.test.ts`.

## Replacing this module

To extend, you typically replace something downstream and leave this
module alone: a different scheduler consumes the same `runGraph`
signature; a different cache layering is a plugin `cache` capability;
telemetry is a plugin `telemetry` sink; a different execution venue
is a plugin `executor` (per task — the whole-run `backend` seam was
removed in 2026-08; the scheduler never leaves this process). Touch
`run.ts` itself only for new run-level
lifecycle steps.

## The run lock (`run-lock.ts`)

One run at a time per workspace, per machine. Two vx processes on one
workspace raced on every task's OUTPUT TREE (both clean and restore the
same `dist/`; a clean landing while the other run's restore is staging
takes its files out from under it, item 215), so `run()` takes the
workspace's lock just before it schedules — after the early exits,
which touch no tree — and releases it with its cache handle, before a
persistent task's wait. The lock is keyed by the workspace root's real
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
`[vx] waiting for another vx run (pid N) on this workspace to finish…`,
and reclaims a lock whose pid is gone. A signal exit is `process.exit`
(`signals.ts`), which runs no `finally`, so the process's `exit` event
also removes the entry this process still holds, synchronously: a
Ctrl-C left it for the next run to reclaim (item 848,
`tests/signal-handling.test.ts` › "a signal exit leaves no run-lock
entry behind"); a `kill -9` still does. A pid comes back, too: the temp
directory outlives a container restart, and the restarted container's
vx got the dead run's pid (1) and waited for itself forever (nx#36473,
reproduced on vx 2026-09-24). So a lock naming this process's OWN pid
is stale (a run of this process shares the lock and never meets its
entry), and on Linux the entry also carries the holder's start time
(field 22 of `/proc/<pid>/stat`), so a live pid another process now
wears is stale as well. A process inside a task of the run that holds
the lock (`VX_RUN_WORKSPACE` names the same lock) is refused rather than
left to wait for its own parent: `vx cache prune` in a task waited for
good (X-104). The start time is read once per process for
its entry and once per holder while waiting; elsewhere, where it
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
lock (`tests/syscall-repeats.unsafe.test.ts`). `vx cache prune` (not
`--dry-run`) takes the same lock before it evicts: a prune beside a run
removed the artifacts the run had just probed as hits, whose
`accessed_at` bumps were not flushed yet (nx#36688). The run survives
that now (a vanished artifact is a miss), but only by re-running the
task.
