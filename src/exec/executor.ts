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

export interface ExecuteRequest {
  /** `${project}#${task}` — for executors that route or log by task. */
  readonly taskId: string
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

export interface TaskExecutor {
  /** Shown in errors; `'local'` for core's own. */
  readonly name: string
  /** Per-request opt-out. Absent = accepts everything. */
  accepts?(req: ExecuteRequest): boolean
  execute(req: ExecuteRequest): Promise<ExecuteResult>
}

/**
 * First executor, in declaration order, that does not decline the request.
 * The local executor accepts everything, so with it declared this cannot
 * throw; the throw is the guard for a workspace whose executors all decline.
 */
export function selectExecutor(
  executors: readonly TaskExecutor[],
  req: ExecuteRequest,
): TaskExecutor {
  for (const executor of executors) {
    if (executor.accepts === undefined || executor.accepts(req)) return executor
  }
  throw new Error(
    `no executor accepted ${req.taskId} (declared: ${executors.map((e) => e.name).join(', ')}). Declare localExecutorPlugin() after the executor that declined to run such tasks locally.`,
  )
}
