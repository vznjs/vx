// Run option/summary types live in a leaf file (not the module entry)
// so internals like prepare.ts can import them without an upward
// import of index.ts — the module entry must stay cycle-free.

import type { CacheFlags, CachePolicy, RemoteCacheLayer } from '../cache/index.js'
import type { ContinueMode } from '../graph/index.js'
import type { TaskOutcome } from '../graph/index.js'
import type { AffectedReason } from './affected-tasks.js'
import type { EventBus, Logger } from '../report/index.js'
import type { TelemetrySink } from './telemetry.js'
import type { CommandWindows } from './command-windows.js'
import type { AffectedChanges, ProjectEntry, ProjectMeta } from '../workspace/index.js'
import type { RunSettings } from '../config.js'

export interface RunOptions {
  cwd: string
  /**
   * Task specs to run. Each may be a bare task name (`'build'`) —
   * applied across `projects` to every project that declares it —
   * or an anchored `'pkg#task'` — added directly to the requested
   * set regardless of `projects`.
   */
  tasks: readonly string[]
  projects?: string[]
  /**
   * `--affected`'s diff: a bare requested task runs only when the change
   * reaches its `dependsOn` closure (`affected-tasks.ts`; owner). `projects` is
   * the candidate set it narrows.
   */
  affected?: AffectedChanges
  /** Worker slots: a positive integer; run() refuses anything else. */
  concurrency?: number
  /**
   * Cache directory override (`--cache-dir <path>`). Absolute, or relative
   * to `cwd`. Takes precedence over the workspace `cache.dir` field and the
   * `.vx/cache` default. A per-run knob — never folded into a cache key.
   */
  cacheDir?: string
  /**
   * Granular cache read/write control across the local + remote layers.
   * Each of the four axes (localRead / localWrite / remoteRead /
   * remoteWrite) is independent. Undefined → the workspace's
   * `cache.policy` with `cacheFlags` applied, else {@link FULL_CACHE_POLICY}
   * (everything on).
   */
  cache?: CachePolicy
  /**
   * With no `cache`: `--no-cache` (all four off) and `--force` (both reads
   * off), applied over the workspace's `cache.policy`.
   */
  cacheFlags?: CacheFlags
  /** This run's cache scope, above `VX_CACHE_SCOPE`, a plugin's and the branch's (an embedder's). */
  cacheScope?: string
  /**
   * Per-task output volume for the default logger; overrides the flow
   * default. 'full': frames for work, one-liners for quiet hits.
   * 'errors-only': only failures print. 'hash-only': one line per task
   * (outcome, id, key), no logs. 'none': nothing per task. Header and
   * summary always print.
   */
  outputLogs?: 'full' | 'errors-only' | 'none' | 'hash-only'
  /**
   * Where a remote task's outputs land. 'all' (default): each one's, as it
   * completes. 'toplevel': only requested tasks'. 'none': they stay remote,
   * fetched only when a local task needs them. Transfer tuning that cannot
   * change what a command produces, so never in a key. Local tasks ignore
   * it.
   */
  download?: 'all' | 'toplevel' | 'none'
  /** Remote downloads at once (`cache.concurrency.download`). */
  downloadConcurrency?: number
  /** Uploads at once, per remote (`cache.concurrency.upload`). */
  uploadConcurrency?: number
  /** Local hits restoring at once (`cache.concurrency.restore`); twice `concurrency` unset. */
  restoreConcurrency?: number
  /**
   * 'broad' iff `--all` / `--filter` / `--affected` was passed, else
   * 'focused'. Picks the default logger's per-task output when neither
   * `outputLogs` nor CI overrides it. Undefined (programmatic callers) acts
   * as 'full'.
   */
  flow?: 'focused' | 'broad'
  /**
   * `--retries <n>`: extra attempts after a failure, for tasks without their
   * own `exec.retries` (config wins, `retries: 0` too); unset,
   * `VX_RUN_RETRIES`, then the workspace's. Never in a key. A non-negative
   * integer; run() refuses anything else.
   */
  retries?: number
  /**
   * `--timeout 30m` in ms, for tasks without `exec.timeout`; unset,
   * `VX_RUN_TIMEOUT`, then the workspace's. Never in a key (a timed-out task
   * is never cached), so a `--timeout` run hits a plain run's entry. A
   * positive integer up to `2 ** 31 - 1`; run() refuses anything else.
   */
  timeout?: number
  /**
   * 'never' stops dispatch on the first failure (in-flight tasks finish,
   * queued ones skip), 'deps-ok' (default) skips only a failure's
   * dependents, 'always' runs them anyway, sound under pure-input hashing (a
   * failed outcome carries the upstream's input key). Bare `--continue` =
   * 'always'.
   */
  continueMode?: ContinueMode
  /** `--branch`; unset, `VX_RUN_BRANCH`, then git's, then the CI provider's. */
  branch?: string
  /** `run.schedule` from its flag; unset, `VX_RUN_SCHEDULE`, then the workspace's. */
  schedule?: NonNullable<RunSettings['schedule']>
  /**
   * Filter `dependsOn` expansion. `'all'` drops every edge (just the
   * requested task runs). A string array drops only those task names
   * from both `self` and `dependencies` buckets.
   */
  excludeDependencies?: 'all' | readonly string[]
  /** Forwarded to the last step of each task's exec array (shell-quoted). */
  forwardArgs?: readonly string[]
  /**
   * `false`: no footer, live or printed, and no blank line opening the
   * task log; the run is its task rows (`vx watch`, which frames each
   * cycle with its own line).
   */
  footer?: boolean
  /**
   * If set, write a Chrome-trace JSON profile of the run's wallclock
   * spans. Path is cwd-relative. Default `profile.json` is selected
   * by the CLI parser, not here.
   */
  profile?: string
  /**
   * Install SIGINT/SIGTERM handlers for the run: forward the signal to every
   * live child's group (SIGHUP as SIGTERM), close the cache, exit 128+signo.
   * Default true. The watch loop turns it off: it owns signals for its
   * lifetime, and a cycle must never exit the process under it.
   */
  handleSignals?: boolean
  /**
   * Abort the run from outside: live and persistent children get SIGINT for
   * reason `'SIGINT'`, SIGTERM otherwise, then SIGKILL after the kill grace;
   * nothing more is dispatched; killed and never-started tasks return
   * `aborted`. For an embedder owning its process instead of `handleSignals`
   * (the watch loop), so a cancel never orphans children. A reason naming a
   * signal is a stop as vx's own handler makes one: no history, only what
   * finished.
   */
  signal?: AbortSignal
  /**
   * vx's stdin is a terminal: each `exec.interactive` task is handed it,
   * alone (placement.ts `terminalHolders`). The CLI sets it from
   * `isatty(0)`; absent, an interactive task runs as any task.
   */
  tty?: boolean
  log?: Logger
  /**
   * The run's event bus. Given, the orchestrator emits onto it, so a caller
   * can subscribe before the run emits: the surface seam (the bus and
   * serializable `WireEvent` ship; renderers live outside). The terminal
   * renderer still subscribes. Default: a fresh bus.
   */
  bus?: EventBus
  /**
   * Shared in-flight registry keyed by task hash, from a long-lived embedder
   * (a daemon on the façade; core ships none), so concurrent runs dedup: a
   * task executing for one run is awaited by another, which restores the
   * saved artifact. `vx run` passes none.
   */
  inflight?: Map<string, Promise<void>>
  /**
   * Observe-only telemetry sinks merged with the plugins': a host running
   * others' runs attaches one without a workspace plugin. Undefined costs
   * nothing; with no sinks from either source the zero-sink invariant holds.
   */
  telemetrySinks?: readonly TelemetrySink[]
  /**
   * The command string for the `invocations` row (`'vx run build test
   * --all'`). Absent: `process.argv.slice(1).join(' ')`. Sinks get it with
   * what follows `--` counted, not quoted.
   */
  command?: string
  /**
   * An injected remote cache layer, as `telemetrySinks`: a host already
   * holding a wire client passes it and run() composes `LayeredCache(local,
   * injected)`. It wins over the plugin `cache` capability, which avoids
   * wrapping twice.
   */
  remoteCache?: RemoteCacheLayer
  /**
   * The largest artifact, decoded, the local cache saves, ingests or
   * restores; default 2 GiB. A seam for a test, which cannot produce 2 GiB
   * of output to prove the refusal: the CLI never sets it, and no config
   * or variable reaches it.
   */
  artifactCeiling?: number
}

/**
 * What only vx's own CLI hands run(): what its selection pass already
 * learned, and `vx watch`'s plumbing. Not on the façade's RunOptions.
 */
export interface RunHandoff {
  /**
   * `projects` came from a git diff (`--affected`, a `[ref]` filter): a task
   * name the changed projects lack is not a typo when the workspace declares
   * it elsewhere, and a run with nothing to do is clean. Otherwise a
   * docs-only commit turned `vx run test --affected` red.
   */
  selectedByDiff?: boolean
  /**
   * The projects an include other than `--affected` selected (`--filter
   * other`): every include is a union, so their requested tasks run whether or
   * not `affected` reaches them.
   */
  selectedOutright?: readonly string[]
  /** Filled with why `--affected` kept each requested task; `planRun` (`--dry`) passes it. */
  affectedReasons?: Map<string, AffectedReason>
  /**
   * Configs a selection pass in this process already loaded and staged with
   * the same `cacheDir` (the CLI walks edges for `--filter 'app...'` and
   * `--affected`), reused instead of evaluated again. One run only: a config
   * can change between runs (`vx watch` drops it per cycle).
   */
  staged?: ReadonlyMap<string, ProjectEntry>
  /**
   * The projects a selection pass in this same process discovered under
   * `root` (`--filter`, `--affected`, the project a run from inside one
   * is in). The run takes them instead of
   * walking the workspace again when its root is the same. One run only,
   * as `staged` is.
   */
  discovered?: { root: string; projects: ProjectMeta[] }
  /**
   * The setting that asked for a remote axis (`'--cache-policy'`), named in
   * the warning: with no cache plugin the axes are inert, and a CI job that
   * thinks it fills a shared cache deserves one line saying it does not.
   */
  remoteRequested?: string
  /**
   * The default policy's remote write is off (`remote:r`): the CLI passes it
   * off CI (`CI` unset, `0` or `false`) unless `--cache-policy` or
   * `VX_CACHE_POLICY` names the remote. Dropped when the workspace's
   * `cache.policy` names the remote.
   */
  remoteReadOnlyByDefault?: boolean
  /**
   * Hand every persistent task still running (a dependency-only one too when
   * it declares `inputs.files`) back on `RunSummary.persistent` instead of
   * stopping it; the caller stops it with `stop()`. The watch loop sets
   * this: a dev server stays up while watch idles.
   */
  holdPersistent?: boolean
  /**
   * The run is a `vx watch` cycle: an input edited while a task ran starts
   * the next cycle, and the line withholding the task's save says so.
   */
  watch?: boolean
  /**
   * Servers an earlier `holdPersistent` run handed back. One still up that
   * this run would start again with the same resolved config (and,
   * dependency-only, the same key) is kept and reported ready; its output
   * reaches this run's renderer. The rest stop before the graph starts, so a
   * new one never meets the old one's port. The caller still stops the
   * earlier hand-back; that stops only what this run did not take.
   */
  keep?: HeldPersistent
  /**
   * Where the run records when each command ran (and each restore or deferred fetch)
   * and where it may write (command-windows.ts). The watch loop passes its
   * own, so a write that lands during the cycle and no command of it may
   * have made is the user's edit, whatever the file settles to.
   */
  commandWindows?: CommandWindows
  /**
   * Print the per-task table (`--verbosity 1`) just above the footer: the
   * footer is the run's last word, so the caller cannot print it after.
   */
  summaryTable?: boolean
}

/** run()'s argument inside vx: the public options and the CLI's hand-off. */
export interface CoreRunOptions extends RunOptions {
  handoff?: RunHandoff
}

export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
  /** The persistent tasks `RunOptions.holdPersistent` handed back; absent when none is running. */
  persistent?: HeldPersistent
  /**
   * Why the run refused to start, nothing having run (`ok` is false): a
   * requested task no selected project declares, with what is near. The
   * caller prints it; `vx run` writes it to stderr.
   */
  refused?: string
}

export interface HeldPersistent {
  /** The held tasks' ids, `pkg#task`. */
  ids: readonly string[]
  /** Send every held task a later run did not take `signal` (default SIGTERM), then SIGKILL after the kill grace; resolves once each is gone. */
  stop(signal?: 'SIGINT' | 'SIGTERM'): Promise<void>
  /** Each held server by id, for a later run's `RunOptions.keep`. */
  servers: ReadonlyMap<string, HeldServer>
}

export interface HeldServer {
  child: ReturnType<typeof Bun.spawn>
  /** The task's resolved config as the run that started it saw it: a later run keeps the server only while its own reads the same. */
  config: string
  /** A dependency-only server's key: a later run keeps it only while its own key for it is the same. */
  key?: string
  /** Where what the server writes goes; a run that keeps it points this at its own bus. */
  out: { bus: EventBus }
  /** A later run took the server (kept or stopped it): the hand-back's `stop()` and exit notice leave it alone. */
  handOver(): void
}
