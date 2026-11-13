// The per-task execution contract. `execute-task.ts` decides what to run
// (command, env, sandbox baselines, capture) and hands a resolved request
// here; an executor decides where and how the process runs. Core's
// `local-executor.ts` is the tail of every executor list. Persistent tasks
// never reach an executor as tasks (a worker cannot hand the submitter a
// port): a `servers` executor gets a task's persistent dependencies
// (`ExecuteRequest.servers`) to start where it runs the task. An
// `exec.interactive` task reaches only the local one.
//
// In `exec/` so the contract depends only on process primitives: the boundary
// matrix forbids `exec` → `cache`, so sandbox baselines arrive pre-resolved.

import type { SandboxConfig } from '../config.js'
import type { CaptureConfig, RunResult } from './runner.js'
import { thrownMessage, UserError } from '../util/index.js'
import type { Inline } from '../util/index.js'

/** Sandbox config with every path absolute (`resolveSandboxConfig`). */
export interface ResolvedSandboxConfig {
  /** Readable path prefixes, absolute. */
  allowRead: readonly string[]
  /** Writable path prefixes, absolute. */
  allowWrite: readonly string[]
  /**
   * Linux: the write globs that matched nothing when the task started, so
   * no mount holds them. `scratchWrites` decides which still cover a write.
   */
  pendingWrites?: readonly string[]
  /** Linux: write grants spelled through a link in the project, bound there too (`linkedWriteBinds`). */
  linkedWrites?: readonly { readonly link: string; readonly target: string }[]
  network?: true | readonly string[]
  denyNetwork?: readonly string[]
  systemInfo?: readonly string[]
  unixSockets?: true | readonly string[]
  localBinding?: boolean | readonly number[]
  machLookup?: readonly string[]
  pty?: boolean
  gitConfig?: boolean
  weakerWhenNested?: boolean
  weakerNetworkIsolation?: boolean
  /** Reads outside the workspace are refused too (`hermeticReads`). */
  hermetic?: boolean
  /**
   * Linux: the read grants bound as their children around a wall
   * (`punchWalls`), as declared, and those walls. A path under one and
   * outside every wall is granted, though no bind is its ancestor.
   */
  walled?: { reads: readonly string[]; walls: readonly string[] }
  /** macOS: the walls a glob grant reaches, by kind (`darwinWallRules`). */
  wallsReached?: { read: readonly string[]; write: readonly string[] }
  ignore?: {
    read?: readonly string[]
    write?: readonly string[]
    systemInfo?: readonly string[]
    network?: readonly string[]
  }
}

export interface SandboxViolation {
  /** Raw log line from SRT. Format differs between macOS / Linux. */
  line: string
  timestamp: Date
  /**
   * What the denial named and which `ignore` lists could silence it, filled by
   * the platform: a seatbelt line and a strace line say the same thing, so
   * filters read these, not the line.
   */
  target?: string
  /**
   * vx's own note beside a failure (the cwd it cannot read, a placeholder the
   * task never wrote, a withheld link), not a denial: shown with the denials,
   * never counted as one.
   */
  hint?: true
  /** Absolute, when `target` is a path at all. */
  path?: string
  /**
   * Linux: the directory holding a link on the path the task opened, not
   * in the sandbox, so the link was not there: a grant of `path` alone
   * leaves it hidden.
   */
  via?: string
  /**
   * Linux: what a refused `openat`'s flags asked for; for an `openat2`,
   * whose flags no record names, a read.
   */
  opened?: 'read' | 'write'
  ignorable?: readonly ('read' | 'write' | 'network' | 'systemInfo')[]
}

/** Sandbox baselines + the user's resolved sandbox block, when the task is sandboxed. */
export interface ExecuteSandbox {
  readonly baseAllowRead: readonly string[]
  readonly baseDenyRead: readonly string[]
  /**
   * Only denials under this directory are reported; outside it they are still
   * enforced, which is the wall working, not a finding.
   */
  readonly reportWithin: string
  /**
   * Canonical dirs of workspace packages withheld from this task's
   * `node_modules` grant (its key does not answer for them). A denial under
   * one is reported: the task reached for a dependency.
   */
  readonly reportLinked: readonly string[]
  readonly config: ResolvedSandboxConfig
  /**
   * A cached task's: the project directories its key answers for, which
   * an executor that builds the request again where it runs, on that
   * machine's paths and platform, hands `sandboxRequestFor`.
   */
  readonly keyed?: readonly string[]
  /**
   * A cached task's workspace root: a read the wall hid under it is named
   * for `inputs.workspaceFiles` too, as a grant alone left an edit there
   * a stale hit.
   */
  readonly keyRoot?: string
  /**
   * A cached task's: the projects nested in its own (absolute). Its
   * `inputs.files` stops at them, so a read the wall hid in one is named
   * for `inputs.workspaceFiles`.
   */
  readonly keyNested?: readonly string[]
  /**
   * The dependencies' outputs it may read (absolute), which an executor
   * that builds the request again hands `sandboxRequestFor` too.
   */
  readonly dependencyReads?: readonly string[]
  /**
   * The heads of those outputs (absolute): a refused read under one is a
   * file beside them, reported. Handed `sandboxRequestFor` with them.
   */
  readonly dependencyReported?: readonly string[]
  /**
   * In place of the two above, for an executor with `dependencyOutputs`:
   * the dependencies whose outputs it may read (`projectDir` absolute),
   * listed where the task runs, once they are restored there.
   */
  readonly readableDeps?: readonly ReadableOutputs[]
}

/** A dependency whose declared outputs a sandboxed task may read (`ExecuteSandbox.readableDeps`). */
export interface ReadableOutputs {
  readonly taskId: string
  readonly projectDir: string
  readonly outputs: {
    readonly files: readonly string[]
    readonly workspaceFiles: readonly string[]
  }
}

/** One declared input file, as the cache key saw it. */
export interface InputFile {
  /** Workspace-relative POSIX path. */
  readonly path: string
  /** Git blob OID of the WORKTREE bytes — for a symlink, of its target string — the same digest the key folds. */
  readonly digest: string
}

/**
 * Everything the key folds for one task, with values: what a remote executor
 * needs to reproduce it. Built on the miss path from the resolution that made
 * the key, so it cannot drift. In memory only: `env` values and `runtime`
 * output may be secrets (cache.db stores digests).
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
   * Dependencies whose keys are folded. `outputs` lists each one's declared
   * output files (workspace-relative POSIX), restored before this task runs,
   * for an executor shipping an input root. A non-cacheable dependency's are
   * its outputs on disk; a cacheable one without a local entry lists none.
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

/**
 * One task's command as core hands it to an executor. `outputs`, `envDefine`
 * and `forwardArgs` are frozen copies: core saves the outputs afterwards, and
 * config and args are shared.
 */
export interface ExecuteRequest {
  /** `${project}#${task}` — for executors that route or log by task. */
  readonly taskId: string
  readonly workspaceRoot: string
  /** Present for cacheable tasks (the miss path); absent for a task without `cache: true`. */
  readonly inputs?: TaskInputs
  /**
   * The task's cache key (cacheable tasks): the stable address an executor
   * keeping its own remote record of executions needs.
   */
  readonly cacheKey?: string
  /**
   * Core saves no entry under `cacheKey` after this attempt: the policy writes
   * no layer, an upstream failed under `--continue=always` or is unkeyed, or a
   * remote is composed and the policy writes no remote (an executor's own
   * record is a remote store). An executor saving results for dependants keeps
   * them off that key too, or the next run hit an entry the user said not to
   * write.
   */
  readonly unsaved?: boolean
  /**
   * Cache reads are off for this run (`--force` / `--no-cache`), or remote
   * reads are (`--cache-policy=remote:`). An executor with its own record of
   * executions must not serve this request from it.
   */
  readonly refresh?: boolean
  /**
   * `exec.remote: 'only'`: the task produces a remote input tree. Do not
   * materialise outputs here; a previous execution under the key may answer.
   */
  readonly remoteOnly?: boolean
  /**
   * The platform to run it on, one of the task's `exec.platforms` and the
   * executor's `platforms`: its key includes it. Absent when the task names none.
   */
  readonly platform?: string
  /**
   * The worker type to run it on, one of the executor's `workers`: the
   * task's `exec.worker`, else the first type with one of its platforms.
   * Absent when the executor names no types.
   */
  readonly worker?: string
  /**
   * Which attempt this is, from 2 on a retry. An executor that can runs a
   * retry on another machine, so the machine is not the flake.
   */
  readonly attempt?: number
  /**
   * Whether outputs must land here now. 'eager' (or absent): materialise.
   * 'deferred': leave them remote and return `outputs: {kind:'deferred'}` with
   * a closure core calls if a local consumer needs them. A local executor
   * ignores it.
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
   * `exec.env.define` verbatim. `env` is the resolved, host-specific
   * environment (PATH, HOME, TMPDIR): shipped elsewhere it would enter the
   * action identity and split every machine. These come from the config, the
   * same everywhere, so safe to forward.
   */
  readonly envDefine: Readonly<Record<string, string>>
  readonly capture: CaptureConfig
  readonly timeoutMs?: number
  readonly onStdout: (chunk: string) => void
  readonly onStderr: (chunk: string) => void
  /**
   * Aborted when the run stops, when `timeoutMs` elapses, or when fail-fast
   * withdraws a task not yet begun. End the work and return: core cannot reach
   * a child an executor spawned. Already aborted: do not start. Any exit after
   * the timeout's abort, 0 included, is a timeout. Core waits the kill grace
   * (2 s), then settles the attempt without `execute`.
   */
  readonly signal?: AbortSignal
  /** See `RunOptions.liveChildren`: the run's SIGINT/SIGTERM registry. */
  readonly liveChildren?: Set<ReturnType<typeof Bun.spawn>>
  /**
   * Called with the pid by an executor running the command as a local process,
   * so telemetry can sample its tree. Absent when nobody samples.
   */
  readonly onSpawn?: (pid: number) => void
  readonly sandbox?: ExecuteSandbox
  /**
   * The task holds vx's terminal (`exec.interactive` on a TTY): its stdio is
   * vx's and the callbacks hear nothing. Only the local executor gets such a
   * task.
   */
  readonly terminal?: true
  /**
   * The persistent tasks it depends on, through groups, for a `servers`
   * executor: started where the command runs, ready before it, shared there.
   */
  readonly servers?: readonly ServerSpec[]
}

export interface ExecuteResult extends RunResult {
  /** Sandbox violations (empty when unsandboxed). */
  readonly violations: readonly SandboxViolation[]
  /**
   * Where the outputs are. Absent: `{kind:'disk'}`, in place under `cwd`.
   * `deferred`: not on disk; core calls `materialize()` lazily, at most once,
   * then saves an ordinary entry, so nothing stays deferred. An executor may
   * answer `deferred` to an `eager` request when it cannot bring them: core
   * then saves nothing from this disk.
   */
  readonly outputs?: { kind: 'disk' } | { kind: 'deferred'; materialize: () => Promise<void> }
  /**
   * Tracked files the command changed where it ran, and untracked ones it
   * found there (workspace-relative POSIX), since this disk shows none of it.
   * One the key read or the inputs declare withholds the save, as a local
   * change does.
   */
  readonly changed?: readonly string[]
  /**
   * Which machine ran the command (a REAPI worker id, a pool member). Absent:
   * this host. Reaches telemetry, the row and frame (`<id>@<where>`) and
   * history.
   */
  readonly where?: string
  /**
   * The cores and memory of the machine `where` names, as it reports them:
   * history keeps them, so a task that used all of one reads as wanting a
   * bigger one.
   */
  readonly machine?: {
    readonly cores: number
    readonly memoryBytes: number
    /**
     * The share of a core each runnable thread got there (1 when a core was
     * free). On a crowded machine CPU used is the share, not the need: history
     * divides by this.
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
   * Must run here: the task is persistent, depends on a persistent task this
   * executor does not carry or a sandboxed one, is sandboxed, declares
   * `exec.remote: false`, or folds a runtime probe into its key and this
   * executor is not `runtime`. A `remote` executor is never offered it.
   */
  readonly pinnedLocal: boolean
  /** Declares `cache` — the only tasks whose input set is described, and so the only ones that can ship. */
  readonly cacheable: boolean
}

export interface TaskExecutor {
  /** Shown in errors; `'local'` for core's own. */
  readonly name: string
  /** What it can be offered. Absent: a local executor that takes what `accepts` allows. */
  readonly capabilities?: ExecutorCapabilities
  /**
   * Per-task opt-out at placement time. Absent = accepts every task it is
   * offered. `false` or `undefined` declines; any other non-boolean is
   * refused, naming the plugin.
   */
  accepts?(task: TaskPlacement): boolean
  execute(req: ExecuteRequest): Promise<ExecuteResult>
  /** Filled only by an executor that spreads one run over machines it starts (a DTE). */
  readonly distribution?: Distribution
}

/** What an executor declares it can do; core offers it tasks by these. */
export interface ExecutorCapabilities {
  /** Runs the command somewhere else. Never offered a `pinnedLocal` task. */
  readonly remote?: boolean
  /**
   * Enforces `ExecuteRequest.sandbox` where it runs the command; violations
   * come back on the result. Only such an executor is offered a sandboxed
   * task, or the output was cached past a boundary nobody checked. A `remote`
   * one is offered a sandboxed task's dependants too.
   */
  readonly sandbox?: boolean
  /**
   * A `remote` executor that starts a task's persistent dependencies where it
   * runs it (`ExecuteRequest.servers`). It is offered the dependants of a
   * persistent task without `exec.sandbox` or `exec.remote: false`; that task
   * then runs here only for a dependant placed here.
   */
  readonly servers?: boolean
  /**
   * A `remote` executor that answers `inputs.runtime` and `workspaceRuntime`
   * probes where it runs the task (`answerRuntime`), failing it when one
   * differs from this machine's answer. It is offered probe-keyed tasks, which
   * otherwise run here.
   */
  readonly runtime?: boolean
  /**
   * A `remote` executor that lists the dependencies' outputs a sandboxed
   * task may read where it runs it, from `ExecuteSandbox.readableDeps`.
   * Core then walks none of them here, so the request needs no
   * dependency's files on this machine.
   */
  readonly dependencyOutputs?: boolean
  /**
   * A `remote` executor that runs every task of the run; only hits restore
   * here. Nothing is pinned for it: it gets `exec.remote: false` and
   * `exec.interactive` tasks too and starts every needed server. A task it
   * cannot take refuses the run; one it gives back fails.
   */
  readonly exclusive?: boolean
  /**
   * A `remote` executor that enforces `timeoutMs` from its own start and
   * reports `timedOut`. Core then arms no clock: armed at the request, it
   * counted the wait for a booting worker. The run's stop still aborts.
   */
  readonly timeouts?: boolean
  /**
   * The platforms this executor runs tasks on. A task declaring
   * `exec.platforms` is offered it only when one is listed, and runs on
   * `ExecuteRequest.platform`; one declaring none is never offered such a task
   * off this machine.
   */
  readonly platforms?: readonly string[]
  /**
   * How many tasks it runs at once: its tasks occupy a pool of this size, not
   * the local slots, so a remote pool is not throttled by local CPUs. A
   * positive integer, else refused at resolution. Absent: the local pool.
   */
  readonly capacity?: number
}

/**
 * The distribution contract: hooks core asks of an executor spreading one run
 * over machines it starts. Each optional; a throw or bad shape is left out
 * with one warning.
 */
export interface Distribution {
  /**
   * Its worker types in order of preference, each with its machines' platforms
   * (`@vzn/vx-dte`'s `workers`). A task naming `exec.worker` is offered it
   * only with that type on one of its platforms; others go to the first type
   * that fits (`ExecuteRequest.worker`). Its `platforms` must list them all.
   */
  readonly workers?: ReadonlyArray<readonly [name: string, platforms: readonly string[]]>
  /**
   * The tasks placed here that will run and have not finished: first once the
   * cache has said which placed tasks restore (left out), then after each
   * completion, and when a left-out task executes after all.
   *
   * For an executor provisioning per task (a container, a pod): `capacity` is
   * what it may run at once, this is what is left, so it can size to the
   * remaining work and release capacity early. Absent: nothing is computed.
   *
   * `missed`: of `remaining`, those the up-front probe found in no store (or,
   * without a batch probe, those the index has no hit of): they will run. The
   * rest may still restore or were not probed. The same set each call, changed
   * in place.
   */
  demand?(remaining: ReadonlySet<string>, missed: ReadonlySet<string>): void
  /**
   * Where a handed task runs (`small#2`), for the live row, per frame. `null`
   * while it waits for a machine: the row says `waiting` and its clock starts
   * when a machine begins it. Under `--continue=never` a failure aborts each
   * `null` task's `signal`, skipping it.
   */
  running?(taskId: string): string | null | undefined
  /**
   * A `servers` executor's: no task left uses persistent task `taskId`, so
   * each copy it started stops now, not at teardown. Asked once, as the run
   * stops its own copy. A throw is ignored.
   */
  unneeded?(taskId: string): void
  /**
   * Footer rows for this executor, `[label, text]` (plain or a `ui` inline):
   * what only it knows, such as its machines. Asked every live frame, so
   * cheap; a throw shows nothing.
   */
  footer?(): readonly (readonly [label: string, text: Inline])[]
  /**
   * The machines it ran the run's tasks on (`small#1`, `local`), for the
   * run summary telemetry sinks read; asked once at the end, only when a
   * sink is on. A throw reports none.
   */
  machines?(): readonly MachineReport[]
  /**
   * The run's end had it placed tasks perfectly from the start: each task's
   * time replayed on the machines it could have had, for the summary. Once at
   * the end, only with a sink. A throw or a non-finite number reports none.
   */
  idealMs?(): number | undefined
  /**
   * The workers that would have run the run best, judged after it, for the
   * summary, so a reader can change how many workers and of what size. Once at
   * the end, only with a sink.
   */
  advice?(): readonly WorkerAdvice[]
  /**
   * Its own Chrome-trace events for `--profile` (its machines over time), once
   * at the end. `ts` in microseconds of `performance.now()`; `pid` from 1,
   * moved past the run's own.
   */
  profile?(): readonly Record<string, unknown>[]
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
  /**
   * Its machine's busy core-time over the core-time it had, from its first
   * task's send to its last one's end, 0 to 1 (its tasks' own where its
   * machine said none): whether cores were left idle.
   */
  utilization: number
  /** Cores the executor booked for the tasks it ran, on average over its time online. */
  bookedAvg?: number
  /** From when the executor asked for it to when it joined, for one it started. */
  warmUpMs?: number
  /** When it was asked for (else when it joined), from the executor's start. */
  startMs?: number
}

/**
 * Workers that would have run the run best (`TaskExecutor.advice`).
 * `declared`: as many of each size as end it soonest; `more`: past a size's
 * limit, when sooner; `any`: one shape per platform, ending as soon for the
 * least core time.
 */
export interface WorkerAdvice {
  of: 'declared' | 'more' | 'any'
  /** The run's end on them, from its start. */
  endMs: number
  workers: readonly {
    count: number
    cores: number
    memoryBytes: number
    platform?: string
    /** The size it is, for `declared` and `more`. */
    size?: string
  }[]
}

/**
 * What a remote executor rejects with to give a task back: core runs the same
 * request on the local floor and says `reason` once. A `remote: 'only'` task
 * fails naming `reason` instead. Matched by name: a plugin's `@vzn/vx` may be
 * another copy of this class.
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
 * An executor's result is a plugin's, so its shape is a boundary: `{}` became
 * a core TypeError, vx's crash for the plugin's bug. Name the executor and
 * field instead. `resolveExecutors` checks the factory the same way.
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
  const shown = (v: unknown): string =>
    typeof v === 'object' && v !== null ? 'an object' : String(v as string)
  if (typeof res !== 'object' || res === null)
    fail(`${res === null ? 'null' : typeof res} (expected an object)`)
  const r = res as Record<string, unknown>
  for (const key of ['exitCode', 'durationMs']) {
    if (typeof r[key] !== 'number') fail(`${key} is ${typeof r[key]} (expected a number)`)
  }
  // NaN passed as a number, printed `failed (exit NaN)` and failed the run
  // history's NOT NULL write.
  if (!Number.isInteger(r['exitCode']) || (r['exitCode'] as number) < 0)
    fail(`exitCode is ${String(r['exitCode'])} (expected a non-negative integer)`)
  if (!Number.isFinite(r['durationMs']) || (r['durationMs'] as number) < 0)
    fail(`durationMs is ${String(r['durationMs'])} (expected a non-negative number)`)
  for (const key of ['stdout', 'stderr']) {
    if (typeof r[key] !== 'string') fail(`${key} is ${typeof r[key]} (expected a string)`)
  }
  if (!Array.isArray(r['violations']))
    fail(`violations is ${typeof r['violations']} (expected an array)`)
  // The optional fields reach the row, telemetry and history: a `where` object
  // lost a run's history to a bind error, and a `null` violation failed the
  // task as a TypeError.
  for (const [i, v] of (r['violations'] as unknown[]).entries()) {
    if (typeof v !== 'object' || v === null || typeof (v as { line?: unknown }).line !== 'string')
      fail(`violations[${i}] is not an object with a string line`)
  }
  const where = r['where']
  if (where !== undefined && (typeof where !== 'string' || where === ''))
    fail(`where is ${where === '' ? 'empty' : typeof where} (expected a non-empty string)`)
  for (const key of ['cpuMs', 'peakRssBytes']) {
    const n = r[key]
    if (n !== undefined && !(typeof n === 'number' && Number.isFinite(n) && n >= 0))
      fail(`${key} is ${shown(n)} (expected a non-negative number)`)
  }
  const signal = r['signal']
  if (
    signal !== undefined &&
    typeof signal !== 'string' &&
    !(typeof signal === 'number' && Number.isInteger(signal) && signal > 0)
  )
    fail(`signal is ${shown(signal)} (expected a name or a signal number)`)
  // A pass with a signal was saved as one: a killed command exits 128 + n,
  // as the local runner reports it.
  if (signal !== undefined && r['exitCode'] === 0)
    fail(`exitCode is 0 with signal ${String(signal as string)} (a killed command exits non-zero)`)
  if (r['timedOut'] !== undefined && typeof r['timedOut'] !== 'boolean')
    fail(`timedOut is ${typeof r['timedOut']} (expected a boolean)`)
  const machine = r['machine']
  if (machine !== undefined) {
    if (typeof machine !== 'object' || machine === null) fail('machine is not an object')
    const m = machine as Record<string, unknown>
    // A worker that cannot read its memory reports 0 (vx-dte's join takes it).
    for (const [key, least] of [
      ['cores', 'positive'],
      ['memoryBytes', 'non-negative'],
      ['cpuShare', 'positive'],
    ] as const) {
      const n = m[key]
      if (key === 'cpuShare' && n === undefined) continue
      if (!(typeof n === 'number' && Number.isFinite(n) && (least === 'positive' ? n > 0 : n >= 0)))
        fail(`machine.${key} is ${shown(n)} (expected a ${least} number)`)
    }
  }
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
 * Place one task: the first executor in order that may take it (a `remote` one
 * is skipped for a `pinnedLocal` task, any in `barred` skipped), then
 * `accepts()` decides. Once per task before scheduling. The local executor
 * accepts everything, so the only throw is an `accepts()` that threw: refused
 * naming that executor.
 */
export function selectExecutor(
  executors: readonly TaskExecutor[],
  task: TaskPlacement,
  label: (executor: TaskExecutor) => string = (e) => `executor '${e.name}'`,
  /** `task.pinnedLocal` as `executor` sees it: one that enforces the sandbox or carries servers lifts some pins. */
  pinnedFor: (executor: TaskExecutor) => boolean = () => task.pinnedLocal,
  /** Never offered the task: a sandboxed one is barred from an executor that does not enforce it. */
  barred: (executor: TaskExecutor) => boolean = () => false,
): TaskExecutor {
  for (const executor of executors) {
    const pinned = pinnedFor(executor)
    if ((pinned && executor.capabilities?.remote === true) || barred(executor)) continue
    if (executor.accepts === undefined) return executor
    let taken: unknown
    try {
      taken = executor.accepts(
        pinned === task.pinnedLocal ? task : { ...task, pinnedLocal: pinned },
      )
      // An `async accepts` answers a Promise: truthy, so the executor took
      // every task, and a rejection went unheard.
      if (taken instanceof Promise) {
        taken.catch(() => {})
        throw new Error('returned a Promise; accepts is synchronous')
      }
      // `'no'` was truthy and took the task; admit refuses the same answer.
      if (taken !== undefined && typeof taken !== 'boolean') {
        const t = typeof taken
        const what =
          taken === null
            ? 'null'
            : Array.isArray(taken)
              ? 'an array'
              : `${t === 'object' ? 'an' : 'a'} ${t}`
        throw new Error(`returned ${what}, not true or false`)
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
