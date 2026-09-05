// The per-task execution contract. `execute-task.ts` decides WHAT to run
// (command, env, sandbox baselines, capture) and hands a fully-resolved
// request here; an executor decides WHERE/HOW the process runs. Core's own
// `local-executor.ts` is the in-process spawn, and it sits at the TAIL of
// every executor list — what a plugin executor declines runs here.
// Persistent tasks (`exec.persistent`) never reach an executor: they are local by
// construction (a worker cannot hand the submitter a listening port) and
// stay on `runPersistent`.
//
// Lives in `exec/` (not `orchestrator/`) so the contract depends only on
// process primitives — the module-boundary matrix forbids `exec` → `cache`,
// which is why sandbox baselines arrive pre-resolved on the request.

import type { CaptureConfig, RunResult } from './runner.js'
import type { ResolvedSandboxConfig, SandboxViolation } from './sandbox-runtime.js'

/** Sandbox baselines + the user's resolved sandbox block, when the task is sandboxed. */
export interface ExecuteSandbox {
  readonly baseAllowRead: readonly string[]
  readonly baseAllowWrite: readonly string[]
  readonly baseDenyRead: readonly string[]
  readonly config: ResolvedSandboxConfig
}

/** One declared input file, as the cache key saw it. */
export interface InputFile {
  /** Workspace-relative POSIX path. */
  readonly path: string
  /** Git blob OID of the WORKTREE bytes (the same digest the key folds). */
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
  /** Declared `cache.inputs.files` + `workspaceFiles` (own outputs excluded), sorted by path. */
  readonly files: readonly InputFile[]
  /** Declared `cache.inputs.env` names with their resolved values. */
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>
  /** `cache.inputs.runtime` commands and the output that was folded — a toolchain expectation. */
  readonly runtime: ReadonlyArray<{ readonly command: string; readonly output: string }>
  /** `cache.inputs.workspaceRuntime`, same shape. */
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
  /** Digest of the project's own `package.json` (folded even when no glob lists it). */
  readonly packageJsonDigest: string
  /** Digest of the resolved task config. */
  readonly configDigest: string
  /** The workspace fingerprint (root manifests + lockfile). */
  readonly workspaceFingerprint: string
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
  /** See `RunOptions.liveChildren`: the run's SIGINT/SIGTERM registry. */
  readonly liveChildren?: Set<ReturnType<typeof Bun.spawn>>
  readonly sandbox?: ExecuteSandbox
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
   * state behind.
   */
  readonly outputs?: { kind: 'disk' } | { kind: 'deferred'; materialize: () => Promise<void> }
  /**
   * Executor-reported placement label — which machine ran the command
   * (a REAPI worker id, a pool member). Absent = this host. Rides
   * `TaskOutcome.where` into telemetry so a task can be attributed to
   * its worker; never persisted to the analytics store.
   */
  readonly where?: string
}

/** What an executor sees when a task is PLACED — once per task, before scheduling. */
export interface TaskPlacement {
  readonly taskId: string
  readonly projectName: string
  readonly projectDir: string
  readonly command: string
  /**
   * Must run on this machine: the task is persistent, depends (transitively)
   * on a persistent task, or declares `exec.remote: false`. A `remote`
   * executor is never offered such a task.
   */
  readonly pinnedLocal: boolean
  /** Declares `cache` — the only tasks whose input set is described, and so the only ones that can ship. */
  readonly cacheable: boolean
  /**
   * `exec.resources` VERBATIM — CPU cores, megabytes, and the image a
   * worker must be running for this task to be routed to it. All three are
   * requirements MATCHED against what an executor has, never instructions
   * to build a machine: a distributed executor's workers belong to whoever
   * runs the fleet.
   *
   * Placement is where this belongs: `exec.resources` is stripped from the
   * cache key precisely because it decides WHERE a task fits, never what
   * it produces.
   */
  readonly resources?: Readonly<{ cpus?: number; memory?: number; image?: string }>
}

export interface TaskExecutor {
  /** Shown in errors; `'local'` for core's own. */
  readonly name: string
  /** Runs the command somewhere else. Never offered a `pinnedLocal` task. */
  readonly remote?: boolean
  /**
   * How many tasks this executor runs at once. Its tasks then occupy a pool
   * of this size instead of the local worker slots, so a remote pool is not
   * throttled by the local CPU count. Absent = the local pool.
   */
  readonly capacity?: number
  /** Per-task opt-out at placement time. Absent = accepts every task it is offered. */
  accepts?(task: TaskPlacement): boolean
  /**
   * The tasks placed here that have NOT finished yet — called once after
   * placement with the whole set, then again after each completion (any
   * outcome: a cache hit and a failure both remove one).
   *
   * An executor that provisions something per task — a container, an
   * allocation, a pod — otherwise has to guess. `capacity` says how much it
   * MAY run at once; this says how much is actually left, so it can size
   * what it creates to the work that remains and give capacity back the
   * moment the run can no longer use it, rather than holding it until
   * teardown. Absent = the executor does not care and nothing is computed
   * for it.
   */
  demand?(remaining: ReadonlySet<string>): void
  execute(req: ExecuteRequest): Promise<ExecuteResult>
}

/**
 * Place one task: the first executor, in declaration order, that may take
 * it — a `remote` executor is skipped for a `pinnedLocal` task, then
 * `accepts()` decides. Decided once per task before scheduling. The local
 * executor accepts everything, so with it declared this cannot throw.
 */
export function selectExecutor(
  executors: readonly TaskExecutor[],
  task: TaskPlacement,
): TaskExecutor {
  for (const executor of executors) {
    if (task.pinnedLocal && executor.remote === true) continue
    if (executor.accepts === undefined || executor.accepts(task)) return executor
  }
  throw new Error(
    `no executor accepted ${task.taskId} (declared: ${executors.map((e) => e.name).join(', ')}). Core's local executor accepts every task, so this means it is missing from the list.`,
  )
}
