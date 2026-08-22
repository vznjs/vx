// The per-task execution contract. `execute-task.ts` decides WHAT to run
// (command, env, sandbox baselines, capture) and hands a fully-resolved
// request here; an executor decides WHERE/HOW the process runs. Core's own
// behaviour is `localExecutor` — the same `runCommand` / `runSandboxed`
// calls the orchestrator used to make directly — registered as the
// built-in `vx/local-executor` plugin so a workspace can put another
// executor ahead of it. Persistent tasks (`exec.persistent`) never reach an
// executor: they are local by construction (a worker cannot hand the
// submitter a listening port) and stay on `runPersistent`.
//
// Lives in `exec/` (not `orchestrator/`) so the contract depends only on
// process primitives — the module-boundary matrix forbids `exec` → `cache`,
// which is why sandbox baselines arrive pre-resolved on the request.

import { runCommand, type CaptureConfig, type RunResult } from './runner.js'
import {
  runSandboxed,
  type ResolvedSandboxConfig,
  type SandboxViolation,
} from './sandbox-runtime.js'

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

/** Core's executor: spawn in-process exactly as before the seam existed. */
export function localExecutor(): TaskExecutor {
  return {
    name: 'local',
    async execute(req) {
      const common = {
        command: req.command,
        cwd: req.cwd,
        env: req.env,
        forwardArgs: req.forwardArgs,
        onStdout: req.onStdout,
        onStderr: req.onStderr,
        capture: req.capture,
        ...(req.liveChildren !== undefined ? { liveChildren: req.liveChildren } : {}),
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      }
      if (req.sandbox === undefined) {
        const res = await runCommand(common)
        return { ...res, violations: [] }
      }
      return await runSandboxed({
        ...common,
        baseAllowRead: req.sandbox.baseAllowRead,
        baseAllowWrite: req.sandbox.baseAllowWrite,
        baseDenyRead: req.sandbox.baseDenyRead,
        config: req.sandbox.config,
      })
    },
  }
}

/**
 * First executor, in declaration order, that does not decline the request.
 * The built-in local executor accepts everything, so with it registered
 * this cannot throw; the throw is the guard for a workspace that replaced
 * the built-ins with executors that all decline.
 */
export function selectExecutor(
  executors: readonly TaskExecutor[],
  req: ExecuteRequest,
): TaskExecutor {
  for (const executor of executors) {
    if (executor.accepts === undefined || executor.accepts(req)) return executor
  }
  throw new Error(`no executor accepted ${req.taskId} (${executors.map((e) => e.name).join(', ')})`)
}
