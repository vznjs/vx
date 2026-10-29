// The per-task execution contract. `execute-task.ts` decides WHAT to run
// (command, env, sandbox baselines, capture) and hands a fully-resolved
// request here; an executor decides WHERE/HOW the process runs. Core's own
// `local-executor.ts` is the in-process spawn, and it sits at the TAIL of
// every executor list — what a plugin executor declines runs here.
// Persistent tasks (`exec.persistent`) never reach an executor as tasks: a
// worker cannot hand the submitter a listening port. A `servers` executor
// is handed a task's persistent dependencies instead (`ExecuteRequest.servers`)
// and starts them where it runs the task; the rest stay on `runPersistent`. An `exec.interactive` task reaches the local one
// only: no plugin can hand it this terminal.
//
// Lives in `exec/` (not `orchestrator/`) so the contract depends only on
// process primitives — the module-boundary matrix forbids `exec` → `cache`,
// which is why sandbox baselines arrive pre-resolved on the request.

import type { SandboxConfig } from '../config.js'
import type { CaptureConfig, RunResult } from './runner.js'
import type { ResolvedSandboxConfig, SandboxViolation } from './sandbox-runtime.js'
import { thrownMessage, UserError, type ui } from '../util/index.js'

/** Sandbox baselines + the user's resolved sandbox block, when the task is sandboxed. */
export interface ExecuteSandbox {
  readonly baseAllowRead: readonly string[]
  readonly baseDenyRead: readonly string[]
  /**
   * Only denials on a path under this directory are reported. A denial
   * outside it is still ENFORCED — the task cannot leave its project — but
   * that is the wall doing its job, not a finding to fail a run over.
   */
  readonly reportWithin: string
  /**
   * Canonical directories of the workspace packages core withheld from
   * this task's `node_modules` grant (its key does not answer for them).
   * A denial under one is reported too: the task reached for a dependency,
   * which is the finding, not the wall.
   */
  readonly reportLinked: readonly string[]
  readonly config: ResolvedSandboxConfig
  /**
   * A cached task's: the project directories its key answers for, which
   * an executor that builds the request again where it runs, on that
   * machine's paths and platform, hands `sandboxRequestFor`.
   */
  readonly keyed?: readonly string[]
}

/** One declared input file, as the cache key saw it. */
export interface InputFile {
  /** Workspace-relative POSIX path. */
  readonly path: string
  /** Git blob OID of the WORKTREE bytes — for a symlink, of its target string — the same digest the key folds. */
  readonly digest: string
}

/**
 * Everything the cache key folds for one task, with values — the set a
 * remote executor needs to reproduce the task somewhere else. Built on the
 * miss path only, from the same resolution that produced the key, so it can
 * never drift from what a hit would have matched. Held in memory for the
 * attempt and never persisted: `env` values and `runtime` output may be
 * secrets (cache.db stores only their digests).
 */
export interface TaskInputs {
  /** Declared `inputs.files` + `workspaceFiles` (own outputs excluded), sorted by path. */
  readonly files: readonly InputFile[]
  /** Declared `inputs.env` names with their resolved values; `undefined` when unset. */
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string | undefined }>
  /** `inputs.runtime` commands and the output that was folded — a toolchain expectation. */
  readonly runtime: ReadonlyArray<{ readonly command: string; readonly output: string }>
  /** `inputs.workspaceRuntime`, same shape. */
  readonly workspaceRuntime: ReadonlyArray<{ readonly command: string; readonly output: string }>
  /**
   * Dependencies whose cache keys are folded. `outputs` lists each one's
   * declared output files (workspace-relative POSIX, as stored with its cache
   * entry) — restored on disk before this task runs, so an input-shipping
   * executor can include them in the input root. Empty when the upstream's
   * entry is not in the local index (a non-cacheable dependency).
   */
  readonly upstream: ReadonlyArray<{
    readonly taskId: string
    readonly hash: string
    readonly outputs: readonly string[]
  }>
  /** Digest of the resolved task config. */
  readonly configDigest: string
}

/** A persistent dependency a `servers` executor starts where it runs the task, as `runPersistent` does. */
export interface ServerSpec {
  readonly taskId: string
  readonly command: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /** `exec.persistent.readyWhen`: ready at the first output line it matches; absent, at spawn. */
  readonly readyWhen?: string
  /** Bounds the readiness wait. */
  readonly timeoutMs?: number
  /**
   * Its `exec.sandbox`, and the directories of the projects nested in its
   * own (a wall its grants do not reach): it starts inside that sandbox,
   * built where it runs, as a one-shot task's.
   */
  readonly sandbox?: { readonly config: SandboxConfig; readonly nested: readonly string[] }
}

export interface ExecuteRequest {
  /** `${project}#${task}` — for executors that route or log by task. */
  readonly taskId: string
  readonly workspaceRoot: string
  /** Present for cacheable tasks (the miss path); absent when the task declares no `cache`. */
  readonly inputs?: TaskInputs
  /**
   * The task's cache key (present when the task is cacheable). An executor
   * that keeps its own remote record of executions — so a dependent's input
   * tree can reference this task's outputs without the bytes ever landing on
   * this machine — needs a stable address, and the key is that address.
   */
  readonly cacheKey?: string
  /**
   * Core saves no entry under `cacheKey` after this attempt: the run's
   * policy writes no layer (`--no-cache`, `--cache-policy local:r`), or an
   * upstream failed under `--continue=always`, ran unkeyed or is keyless.
   * An executor that saves a task's result for its dependants keeps it off
   * that key too: a distributed run's worker saved it, and the next run
   * hit an entry the user had said not to write (2026-10-24).
   */
  readonly unsaved?: boolean
  /**
   * Cache READS are disabled for this run (`--force` / `--no-cache`). An
   * executor that keeps its OWN remote record of executions must not serve
   * this request from it — the user asked for re-execution, and a private
   * cache that ignores the flag is still a cache.
   */
  readonly refresh?: boolean
  /**
   * `exec.remote: 'only'`: the task produces a REMOTE input tree. The
   * executor should not materialise outputs onto this machine's disk, and
   * may satisfy the request from its own remote record of a previous
   * execution under the same key.
   */
  readonly remoteOnly?: boolean
  /**
   * The platform to run it on, one of the task's `exec.platforms` and the
   * executor's `platforms`: its key includes it. Absent when the task names none.
   */
  readonly platform?: string
  /**
   * Whether this task's outputs must land on the submitter's disk now.
   * 'eager' (or absent) = materialise as today. 'deferred' = leave them
   * in the remote store and return `outputs: {kind:'deferred'}` with a
   * closure core can call if a local consumer turns out to need them.
   * A local executor ignores this — it writes in place by construction.
   */
  readonly download?: 'eager' | 'deferred'
  /** The declared output globs — project-relative `files`, root-relative `workspaceFiles`. */
  readonly outputs: {
    readonly files: readonly string[]
    readonly workspaceFiles: readonly string[]
  }
  readonly command: string
  /** Appended to `command`, shell-quoted, by the executor (forwarded CLI args). */
  readonly forwardArgs: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /**
   * `exec.env.define` verbatim — literal name=value pairs from the task
   * config. `env` above is the fully RESOLVED child environment and is
   * host-specific (it carries this machine's PATH, HOME, TMPDIR…), so an
   * executor that ships the environment somewhere else cannot use it: those
   * values would enter the action identity and split every machine from
   * every other. These are declared in the config, so they are the same
   * everywhere and safe to forward.
   */
  readonly envDefine: Readonly<Record<string, string>>
  readonly capture: CaptureConfig
  readonly timeoutMs?: number
  readonly onStdout: (chunk: string) => void
  readonly onStderr: (chunk: string) => void
  /**
   * Aborted when the run stops (Ctrl-C, SIGTERM, SIGHUP or an embedder's
   * `RunOptions.signal`) or when `timeoutMs` elapses. An executor ends its
   * work and returns: a child an executor spawned is not one core can
   * reach (H-10, H-12). One already aborted is work not to start (B-55).
   * Any exit after the timeout's abort, a 0 included, is a timeout. Core
   * waits the kill grace (2 s) after the abort, then
   * settles the attempt without `execute` and abandons it (H-14).
   */
  readonly signal?: AbortSignal
  /** See `RunOptions.liveChildren`: the run's SIGINT/SIGTERM registry. */
  readonly liveChildren?: Set<ReturnType<typeof Bun.spawn>>
  /**
   * An executor that runs the command as a process on THIS machine calls
   * this with its pid once spawned, so a telemetry plugin can sample the
   * process tree's CPU and memory while it runs. Absent when nobody samples;
   * an executor that runs elsewhere never calls it.
   */
  readonly onSpawn?: (pid: number) => void
  readonly sandbox?: ExecuteSandbox
  /**
   * The task holds vx's terminal (`exec.interactive` on a TTY): its stdin,
   * stdout and stderr are vx's own, and the callbacks hear nothing. Only
   * core's local executor is ever handed such a task (placement.ts).
   */
  readonly terminal?: true
  /**
   * The persistent tasks it depends on, through groups, for a `servers`
   * executor: each started where the command runs, ready before it, and
   * shared by the tasks that run there. Absent for any other executor.
   */
  readonly servers?: readonly ServerSpec[]
}

export interface ExecuteResult extends RunResult {
  /** Sandbox violations (empty when unsandboxed). */
  readonly violations: readonly SandboxViolation[]
  /**
   * Where this task's outputs are. Absent = `{kind:'disk'}` — in place
   * under `cwd`, which is what every executor did before deferral
   * existed. `deferred` means they are NOT on disk and `materialize()`
   * fetches them; core calls it lazily, at most once, and then saves an
   * ordinary cache entry, so a deferred task leaves no permanent third
   * state behind. An executor may answer `deferred` to an `eager` request
   * too, when it cannot bring them here: core saves nothing from this disk.
   */
  readonly outputs?: { kind: 'disk' } | { kind: 'deferred'; materialize: () => Promise<void> }
  /**
   * Tracked files the command changed where it ran, workspace-relative
   * POSIX: an executor that runs it elsewhere says so, as this disk shows
   * none of it. One the key read withholds the save under the key, as an
   * input changed here does.
   */
  readonly changed?: readonly string[]
  /**
   * Executor-reported placement label — which machine ran the command
   * (a REAPI worker id, a pool member). Absent = this host. Rides
   * `TaskOutcome.where` into telemetry so a task can be attributed to
   * its worker, onto its row and frame (`<id>@<where>`), and into the
   * run history (v44).
   */
  readonly where?: string
  /**
   * The cores and memory of the machine `where` names, as it reports
   * them: the run history keeps them, so a task that used all of one
   * reads as wanting a bigger one (`TaskResources.saturated*`).
   */
  readonly machine?: {
    readonly cores: number
    readonly memoryBytes: number
    /**
     * The share of a core each runnable thread got there over the task's
     * run (1 when a core was free). On a crowded machine the CPU a task
     * used is its share, not its need: the run history divides by this.
     */
    readonly cpuShare?: number
  }
}

/** What an executor sees when a task is PLACED — once per task, before scheduling. */
export interface TaskPlacement {
  readonly taskId: string
  readonly projectName: string
  readonly projectDir: string
  readonly command: string
  /**
   * Must run on this machine: the task is persistent, depends (transitively)
   * on a persistent task this executor does not carry or a sandboxed one, is sandboxed itself, declares
   * `exec.remote: false`, or folds a runtime probe into its key (this
   * machine's `node -v`) and this executor is not `runtime`. A `remote`
   * executor is never offered such a task.
   */
  readonly pinnedLocal: boolean
  /** Declares `cache` — the only tasks whose input set is described, and so the only ones that can ship. */
  readonly cacheable: boolean
}

export interface TaskExecutor {
  /** Shown in errors; `'local'` for core's own. */
  readonly name: string
  /** Runs the command somewhere else. Never offered a `pinnedLocal` task. */
  readonly remote?: boolean
  /**
   * A `remote` executor that enforces `ExecuteRequest.sandbox` where it
   * runs the command, as the local one does. It is offered sandboxed tasks
   * and their dependants; the request's violations come back on the result.
   */
  readonly sandbox?: boolean
  /**
   * A `remote` executor that starts a task's persistent dependencies where
   * it runs the task (`ExecuteRequest.servers`). It is offered the
   * dependants of a persistent task with no `exec.sandbox` and no
   * `exec.remote: false`; that task then runs here only for a dependant
   * placed here (2026-10-22: nothing runs on a distributed run's
   * orchestrator).
   */
  readonly servers?: boolean
  /**
   * A `remote` executor that answers a task's `inputs.runtime` and
   * `workspaceRuntime` probes where it runs the task (`answerRuntime`) and
   * fails it when one answers other than `TaskInputs` says this machine
   * did. It is offered tasks whose key folds a probe, which otherwise run
   * here: their key holds this machine's answer (C-2).
   */
  readonly runtime?: boolean
  /**
   * A `remote` executor that runs every task of the run, so none runs on
   * this machine; only cache hits restore here (2026-10-24: "no
   * task should ever run on the orchestrator"). Nothing is pinned for it:
   * it is offered `exec.remote: false` and `exec.interactive` tasks too,
   * and starts every server a dependant needs. A task it cannot take (a
   * platform it does not offer, one it declines, a server requested on its
   * own) refuses the run, and a task it gives back fails.
   */
  readonly exclusive?: boolean
  /**
   * A `remote` executor that enforces `ExecuteRequest.timeoutMs` where it
   * runs the command, timed from its start, and reports `timedOut`. Core
   * then arms no clock of its own: armed at the request, it counted the
   * wait for a worker still booting and killed a 1 s task with a 3 s
   * timeout before it began (2026-10-24). The run's stop still aborts.
   */
  readonly timeouts?: boolean
  /**
   * The platforms this executor runs tasks on (`exec.platforms`' names). It
   * is offered a task that declares `exec.platforms` only when one of them
   * is listed, and runs it on `ExecuteRequest.platform`; an executor that
   * declares none is never offered such a task off this machine.
   */
  readonly platforms?: readonly string[]
  /**
   * How many tasks this executor runs at once. Its tasks then occupy a pool
   * of this size instead of the local worker slots, so a remote pool is not
   * throttled by the local CPU count. A positive integer; anything else
   * is refused when the executor is resolved. Absent = the local pool.
   */
  readonly capacity?: number
  /** Per-task opt-out at placement time. Absent = accepts every task it is offered. */
  accepts?(task: TaskPlacement): boolean
  /**
   * The tasks placed here that will run and have NOT finished yet — called
   * first once the run's cache has said which placed tasks it holds (those
   * restore, so they are left out), then again after each completion (any
   * outcome, a failure too) and when a task it left out executes after all.
   *
   * An executor that provisions something per task — a container, an
   * allocation, a pod — otherwise has to guess. `capacity` says how much it
   * MAY run at once; this says how much is actually left, so it can size
   * what it creates to the work that remains and give capacity back the
   * moment the run can no longer use it, rather than holding it until
   * teardown. Absent = the executor does not care and nothing is computed
   * for it.
   *
   * `missed`: of `remaining`, those whose keys the run's up-front probe
   * found in no store (each store asked answered for every key), or, when
   * the remote has no batch probe, those the index keeps no hit of: they
   * will run. The rest may still restore, or were not probed (a key an upstream's outputs can
   * change). The same set each call, changed in place.
   */
  demand?(remaining: ReadonlySet<string>, missed: ReadonlySet<string>): void
  /**
   * Rows the run's footer shows for this executor, `[label, text]`, the
   * text plain or a `ui` inline (a tone colors it): what only it knows, such as the machines it ran tasks on. Asked on every
   * frame of the live footer and once for the final one, so it is cheap;
   * a throw shows nothing.
   */
  footer?(): readonly (readonly [label: string, text: ui.Inline])[]
  /**
   * The machines it ran the run's tasks on (`small#1`, `local`), for the
   * run summary telemetry sinks read; asked once at the end, only when a
   * sink is on. A throw reports none.
   */
  machines?(): readonly MachineReport[]
  /**
   * The run's end had it placed its tasks perfectly, from the run's
   * start: what each took, replayed on the machines it could have had, for
   * the run summary beside the real time. Asked once at the end, only when a sink is on. A throw, or
   * anything but a finite number, reports none.
   */
  idealMs?(): number | undefined
  /**
   * Its own Chrome-trace events for `vx run --profile` (the machines it ran
   * tasks on, in time), asked once at the end, only when the flag is set.
   * `ts` is in microseconds of `performance.now()`; `pid` from 1, which
   * the run moves past its own process. A throw adds none.
   */
  profile?(): readonly Record<string, unknown>[]
  /**
   * Where a task it was handed runs (`small#2`), for the live row; asked
   * per frame. `null` while it holds the task for a machine to begin it:
   * the row says `waiting`, and its clock starts when a machine begins it.
   */
  running?(taskId: string): string | null | undefined
  execute(req: ExecuteRequest): Promise<ExecuteResult>
}

/** One machine an executor ran tasks on, as the run summary reports it. */
export interface MachineReport {
  /** As task rows name it (`small#1`). */
  name: string
  /** `online`, or `gone` for one that left before the run ended. */
  status: string
  cores: number
  memoryBytes: number
  done: number
  failed: number
  /** From when it joined to when it left or the run ended: warm-up not counted. */
  onlineMs: number
  /** Time with at least one task on it, from its send to its result. */
  busyMs: number
  /** Cores in use at once, at the most and on average over its time online. */
  cpuPeak: number
  cpuAvg: number
  /** Bytes in use at once, at the most and on average. */
  memoryPeakBytes: number
  memoryAvgBytes: number
  /** Core-time its tasks used over the core-time it had, 0 to 1. */
  utilization: number
  /** Cores the executor booked for the tasks it ran, on average over its time online. */
  bookedAvg?: number
  /** From when the executor asked for it to when it joined, for one it started. */
  warmUpMs?: number
  /** When it was asked for (else when it joined), from the executor's start. */
  startMs?: number
}

/**
 * What a remote executor rejects with when it gives a task back: core runs
 * the same request on the local floor and says `reason` once (a remote that
 * never started it, B-100). A task placed `remote: 'only'` must not run
 * here, so it fails naming `reason` instead. Matched by name, as
 * `isUserError` is: a plugin's `@vzn/vx` can be another copy of this class.
 */
export function executorFallback(reason: string): Error {
  const err = new Error(reason)
  err.name = 'ExecutorFallback'
  return err
}

export function isExecutorFallback(err: unknown): err is Error {
  return err instanceof Error && err.name === 'ExecutorFallback'
}

/**
 * The result an executor resolves with is a plugin's, so its shape is a
 * boundary: a plugin that resolved `{}` met `res.violations` in core and
 * became "internal error in <task>: TypeError …" — vx's crash, the plugin's
 * bug (2026-09-16). Name the executor and the field instead. The factory's
 * output is checked the same way in `resolveExecutors`.
 */
export function assertExecuteResult(
  executor: string,
  taskId: string,
  res: unknown,
): asserts res is ExecuteResult {
  const fail = (what: string): never => {
    throw new UserError(
      `executor '${executor}' returned an invalid result for ${taskId}: ${what} — a plugin bug, not a task failure`,
    )
  }
  if (typeof res !== 'object' || res === null)
    fail(`${res === null ? 'null' : typeof res} (expected an object)`)
  const r = res as Record<string, unknown>
  for (const key of ['exitCode', 'durationMs']) {
    if (typeof r[key] !== 'number') fail(`${key} is ${typeof r[key]} (expected a number)`)
  }
  // NaN passed as a number, printed `failed (exit NaN)` and failed the run
  // history's NOT NULL write (X-11).
  if (!Number.isInteger(r['exitCode']) || (r['exitCode'] as number) < 0)
    fail(`exitCode is ${String(r['exitCode'])} (expected a non-negative integer)`)
  if (!Number.isFinite(r['durationMs']) || (r['durationMs'] as number) < 0)
    fail(`durationMs is ${String(r['durationMs'])} (expected a non-negative number)`)
  for (const key of ['stdout', 'stderr']) {
    if (typeof r[key] !== 'string') fail(`${key} is ${typeof r[key]} (expected a string)`)
  }
  if (!Array.isArray(r['violations']))
    fail(`violations is ${typeof r['violations']} (expected an array)`)
  const outputs = r['outputs'] as { kind?: unknown; materialize?: unknown } | undefined
  if (outputs !== undefined) {
    if (typeof outputs !== 'object' || outputs === null) fail('outputs is not an object')
    else if (outputs.kind === 'deferred') {
      if (typeof outputs.materialize !== 'function')
        fail('outputs.kind is deferred without a materialize()')
    } else if (outputs.kind !== 'disk')
      fail(`outputs.kind is ${String(outputs.kind)} (expected disk or deferred)`)
  }
  const changed = r['changed']
  if (
    changed !== undefined &&
    (!Array.isArray(changed) || changed.some((f) => typeof f !== 'string'))
  )
    fail('changed is not an array of paths')
}

/**
 * Place one task: the first executor, in declaration order, that may take
 * it — a `remote` executor is skipped for a `pinnedLocal` task, then
 * `accepts()` decides. Decided once per task before scheduling. The local
 * executor accepts everything, so with it declared the only throw is an
 * `accepts()` that threw: refused as `label` names that executor, where it
 * surfaced as a bare stack naming no plugin (item 1022).
 */
export function selectExecutor(
  executors: readonly TaskExecutor[],
  task: TaskPlacement,
  label: (executor: TaskExecutor) => string = (e) => `executor '${e.name}'`,
  /** `task.pinnedLocal` as `executor` sees it: one that enforces the sandbox or carries servers lifts some pins. */
  pinnedFor: (executor: TaskExecutor) => boolean = () => task.pinnedLocal,
): TaskExecutor {
  for (const executor of executors) {
    const pinned = pinnedFor(executor)
    if (pinned && executor.remote === true) continue
    if (executor.accepts === undefined) return executor
    let taken: unknown
    try {
      taken = executor.accepts(
        pinned === task.pinnedLocal ? task : { ...task, pinnedLocal: pinned },
      )
      // An `async accepts` answers a Promise: truthy, so the executor took
      // every task, and a rejection went unheard (the shape of H-16's admit).
      if (taken instanceof Promise) {
        taken.catch(() => {})
        throw new Error('returned a Promise; accepts is synchronous')
      }
    } catch (err) {
      const m = thrownMessage(err)
      throw new UserError(`${label(executor)} failed in accepts for ${task.taskId}: ${m}`)
    }
    if (taken) return executor
  }
  throw new Error(
    `no executor accepted ${task.taskId} (declared: ${executors.map((e) => e.name).join(', ')}). Core's local executor accepts every task, so this means it is missing from the list.`,
  )
}

/** This machine as `exec.platforms` names it: `os-arch` as Bun reports them, `linux-x64`. */
export function hostPlatform(): string {
  return `${process.platform}-${process.arch}`
}
