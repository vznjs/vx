# `src/orchestrator/{index,run}.ts` — end-to-end glue

## Purpose

The orchestrator module's entry. `run.ts` hosts `run()` / `planRun()`;
`index.ts` is the module contract re-exporting them with
`RunOptions` / `RunSummary` ([`options.md`](./options.md)), `Logger` /
`defaultLogger` ([`logger.md`](./logger.md)), the `RunPlan` types
([`plan.md`](./plan.md)), and the plugin / telemetry / wire /
metrics surfaces the public API and `@vzn/vx-cloud` consume. Invoked
by `cli/run.ts` (via a `RunBackend`). Discovers the workspace, loads
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
export function shouldShortCircuit(nodes, policy, cache): boolean

// RunOptions highlights (full list in options.md):
//   cwd, tasks, projects?, concurrency?, cache?: CachePolicy, frozen?,
//   retries?, excludeDependencies?, forwardArgs?, outputLogs?, flow?,
//   summarize?, profile?, tags?, command?, report?, log?, bus?,
//   inflight?, handleSignals?

export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
}
```

## Algorithm — `run()`

1. **Color decision + event bus.** Programmatic logger → plain text;
   default logger → `detectColors()`. The renderer SUBSCRIBES to the
   run event bus (`terminalSubscriber`); `run()` emits through
   `busLogger` — it never calls the logger directly.
2. **`prepareRun(options, log)`** — shared setup: discovery, scoped
   config loading (lock-backed under `--frozen`), package + task
   graph, cache open (local policy slice; plugin `cache` capability
   or env-var remote wrap), bulk git populate, hash memo, optional
   predictive priorities. **Caller owns `cache.close()`.**
3. **Empty-case handling.** `no-tasks-declared` / `empty-graph` →
   log, close cache, return NOT-ok.
4. **Plugins.** When declared: `installPlugins` (setup hooks;
   fail-fast UserError) + `subscribeEventSinks` (deprecated raw-wire
   path), then run-context capture (one git spawn; dirty reuses the
   GitFilesCache status) and `subscribeTelemetry` — which returns
   `undefined` when zero sinks are contributed, so a plain run adds
   no subscriber and builds no records.
5. **Run-level state.** `runId` (ULID) + `runStartHrTimeNs` anchor +
   `liveChildren` set + `persistentRegistry` map. SIGINT/SIGTERM
   handlers installed here, removed in a `finally`.
6. **Sandbox init** (lazy — only when some node declares `sandbox`).
7. **`markSurfacedDeps(nodes)`** — transparent-group display marking;
   the footer run context is built (there is no top-of-run header).
8. **Cache acceleration.** LayeredCache → `startRemotePrefetch`
   (background, drained before close). Local-only + local reads on +
   ≥1 dep edge (`shouldShortCircuit`) → `startLocalShortCircuit`,
   producing `preProbed` (probe reuse) + `restoreTier`.
9. **`runGraph({..., priorities, restoreTier})`.** Two-tier schedule;
   each ready node runs `executeTask` (with its pre-probe when
   present). A service-supplied `inflight` map dedupes identical-hash
   tasks across concurrent delegated runs.
10. **Persistent cleanup.** Dependency-only persistent children are
    SIGTERMed and awaited. Persistent tasks the user REQUESTED (or
    that were surfaced) are KEPT ALIVE in the real CLI foreground
    (`options.log === undefined && handleSignals !== false`).
11. **Summary.** `formatPersistentList` rows for kept-alive tasks,
    then `formatRunSummary(list, totalMs, colors, runContext)` — the
    footer carries the run banner (wordmark rule + projects/tasks/
    cache meters + info + time).
12. **Optional artifacts.** `writeRunSummary` / `writeRunProfile`.
    Errors logged, exit code unchanged.
13. **`cache.recordRunBundle({ runs, invocation })`** — one
    transaction: a `runs` row per real task (group + `aborted`
    skipped) plus the `invocations` header row (command, policy,
    git/CI/host context, tags, counts).
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

`run()` installs SIGINT + SIGTERM handlers for its own duration
(unless `RunOptions.handleSignals === false`) and removes them in a
`finally`, so repeated `run()` calls never stack listeners. On
signal: SIGTERM everything in `liveChildren` + `persistentRegistry`,
close the cache, `process.exit(signalExitCode(signal))` (130 / 143).
Children killed this way classify as `aborted` — not counted, not
recorded. Watch mode passes `handleSignals: false`; the loop owns
signal disposition for its whole lifetime.

## Failure semantics

The orchestrator does NOT throw on task failure — the scheduler
already converts thrown errors into `failed` outcomes. The `ok` field
on the returned summary is `false` iff any outcome was `failed` or
`skipped`. CLI maps this to exit code 1. Setup throws (`UserError`
from discovery/loader/graph/plugin-setup) are caught at
`cli/run.ts:runCmd`.

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
is a plugin `backend`. Touch `run.ts` itself only for new run-level
lifecycle steps.
