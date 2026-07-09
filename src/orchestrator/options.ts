// Run option/summary types live in a leaf file (not the module entry)
// so internals like prepare.ts can import them without an upward
// import of index.ts — the module entry must stay cycle-free.

import type { CachePolicy } from '../cache/index.js'
import type { ContinueMode } from '../graph/index.js'
import type { TaskOutcome } from '../graph/index.js'
import type { EventBus } from './events.js'
import type { TelemetrySink } from './telemetry.js'
import type { Logger } from './logger.js'

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
  concurrency?: number
  /**
   * Cache directory override (`--cache-dir <path>`). Absolute, or relative
   * to `cwd`. Takes precedence over the workspace `cacheDir` field and the
   * `.vx/cache` default. A per-run knob — never folded into a cache key.
   */
  cacheDir?: string
  /**
   * Granular cache read/write control across the local + remote layers.
   * Each of the four axes (localRead / localWrite / remoteRead /
   * remoteWrite) is independent. Undefined → {@link FULL_CACHE_POLICY}
   * (everything on). `--no-cache` sets all four false; `--force` sets
   * both reads false (re-execute, still refresh the cache).
   */
  cache?: CachePolicy
  /**
   * CI mode: load configs FROM the committed vx-lock.json instead of
   * evaluating them (frozen-env reproducibility). Requires the lock
   * to exist and pass its content-hash tripwire. Local runs default
   * to live evaluation — byte hashes can't see a config's import
   * closure, so a strict local mode would give false confidence.
   * Pair with `vx lock --check` in CI for the full evaluation audit.
   */
  frozen?: boolean
  /**
   * Explicit per-task output volume for the default logger. ALWAYS
   * overrides the flow default. 'full': frames for work + one-liners
   * for quiet hits. 'errors-only': only failed tasks print. 'none':
   * no per-task output at all. Status lines (header, summary) always
   * print.
   */
  outputLogs?: 'full' | 'errors-only' | 'none'
  /**
   * Run intent, derived by the CLI from selection flags: 'broad' iff
   * `--all` / `--filter` / `--affected` was passed, else 'focused'.
   * Drives the default logger's per-task output policy when neither
   * `outputLogs` nor a truthy CI env overrides it. Undefined
   * (programmatic callers) behaves like today's 'full'.
   */
  flow?: 'focused' | 'broad'
  /**
   * Run-level retry default (`--retry <n>`): max additional attempts
   * after a failed attempt, for tasks that don't declare their own
   * `exec.retries` (explicit config wins, including `retries: 0`).
   * Threaded as an option only — never folded into any cache key, so
   * the same run with and without `--retry` derives identical keys.
   */
  retries?: number
  /**
   * Cache-correctness verification (`vx run --verify`). When set, an
   * executed + cacheable task is re-run after its save and its outputs are
   * content-compared: a divergence means the task is non-hermetic and its
   * cache entry is provably unsafe (see docs/design/cache-correctness).
   * `fingerprint` computes + ships an output-tree fingerprint on executed
   * tasks (no re-run — the cross-machine diff feed; `--verify`/`=all` set
   * it too, for free). `allow` (from `--verify-allow=<pkg#task>,…`) exempts
   * known-nondeterministic tasks from failing the run. A pure side-channel —
   * never folded into a cache key; the re-run never saves. Undefined = off
   * (a plain run is byte-identical).
   */
  verify?: {
    determinism: boolean
    inputs: boolean
    fingerprint: boolean
    allow: ReadonlySet<string>
  }
  /**
   * Run-level default task timeout (ms), for tasks that declare no
   * `exec.timeout`. Highest of the run-level defaults: `--timeout` /
   * this option → `VX_TASK_TIMEOUT` env → workspace `timeout`. Per-task
   * `exec.timeout` always wins. Threaded as an option only — never
   * folded into any cache key (a timed-out task fails and is never
   * cached), so a `--timeout` run cache-hits a plain run's entry.
   */
  timeout?: number
  /**
   * Memory budget (bytes) that per-task `exec.resources.memory`
   * reservations pack against (`--memory <size>`). Defaults to
   * `os.totalmem()` — override it in cgroup-limited containers, where
   * totalmem() reports the HOST's RAM, not the limit. A per-run
   * scheduling knob only — never folded into any cache key.
   */
  memory?: number
  /**
   * Failure propagation: 'never' stops dispatch on the first failure
   * (in-flight tasks finish; everything queued skips), 'deps-ok'
   * (default) skips only a failure's dependents, 'always' runs
   * dependents even when an upstream failed — sound under pure-input
   * hashing (failed outcomes carry the upstream's input key). CLI:
   * `--continue[=never|deps-ok|always]`; bare `--continue` = 'always'.
   */
  continueMode?: ContinueMode
  /**
   * Filter `dependsOn` expansion. `'all'` drops every edge (just the
   * requested task runs). A string array drops only those task names
   * from both `self` and `dependencies` buckets.
   */
  excludeDependencies?: 'all' | readonly string[]
  /** Forwarded to the last step of each task's exec array (shell-quoted). */
  forwardArgs?: readonly string[]
  /**
   * If set, write a per-run JSON summary at end of run. Empty string
   * picks the default path `<cacheDir>/runs/<run_id>.json`; anything
   * else is treated as the literal file path (cwd-relative).
   */
  summarize?: string
  /**
   * If set, write a Chrome-trace JSON profile of the run's wallclock
   * spans. Path is cwd-relative. Default `profile.json` is selected
   * by the CLI parser, not here.
   */
  profile?: string
  /**
   * Install SIGINT/SIGTERM handlers for the run's duration: forward
   * SIGTERM to every live child, close the cache, exit 128+signo
   * (130/143). Default true. The watch loop disables this — it owns
   * signal disposition for its whole lifetime and a cycle must never
   * exit the process out from under it.
   */
  handleSignals?: boolean
  log?: Logger
  /**
   * Inject the run's event bus. When provided, the orchestrator emits
   * onto it instead of creating its own — letting a caller subscribe a
   * surface (e.g. the `--ui` devframe dev server) BEFORE the run starts
   * emitting. The terminal renderer is still attached as a subscriber, so
   * default output is unchanged. Default: a fresh internal bus.
   */
  bus?: EventBus
  /**
   * Shared in-flight execution registry, keyed by task hash. Supplied by a
   * long-lived service (`vx serve`) so concurrent runs DEDUP work: a task
   * already executing for one run is awaited by another (which then
   * restores the just-saved artifact from cache) instead of re-running.
   * A stateless `vx run` passes none and is byte-identical to before.
   */
  inflight?: Map<string, Promise<void>>
  /**
   * `--tag k=v` pairs (Tier-3). Persisted verbatim on the run's
   * `invocations` row (JSON object) so dashboards can filter runs by
   * label. CLI parsing is the CLI's job; the orchestrator just records.
   */
  tags?: Record<string, string>
  /**
   * Additional observe-only telemetry sinks, merged with whatever the
   * workspace plugins contribute. The embedder seam: a host executing
   * runs on behalf of others (a serve recording delegated runs
   * into its ingest store) attaches a sink without needing a workspace
   * plugin. Undefined → zero cost, identical to before; the telemetry
   * host's zero-sink invariant still applies when both sources are
   * empty.
   */
  telemetrySinks?: readonly TelemetrySink[]
  /**
   * The raw command string for the `invocations` row (e.g.
   * `'vx run build test --all'`). When absent, run() falls back to
   * `process.argv.slice(1).join(' ')` so programmatic callers still
   * record something useful.
   */
  command?: string
}

export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
}
