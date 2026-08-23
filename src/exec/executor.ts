// The per-task execution contract. `execute-task.ts` decides WHAT to run
// (command, env, sandbox baselines, capture) and hands a fully-resolved
// request here; an executor decides WHERE/HOW the process runs. Core ships
// no executor of its own: `@vzn/vx/plugins/local-executor` is the
// in-process spawn, declared in vx.workspace.ts like any other. Persistent
// tasks (`exec.persistent`) never reach an executor: they are local by
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
    `no executor accepted ${task.taskId} (declared: ${executors.map((e) => e.name).join(', ')}). Declare localExecutorPlugin() after the executor that declined to run such tasks locally.`,
  )
}
