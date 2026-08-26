// Core's executor as a plugin: spawn the task's command in-process, exactly
// the `runCommand` / `runSandboxed` call the orchestrator used to make
// directly. Imports core only through the public `@vzn/vx` surface so this
// directory can become its own package unchanged.

import { runCommand, runSandboxed, type TaskExecutor, type VxPlugin } from '@vzn/vx'

export const LOCAL_EXECUTOR_PLUGIN = 'vx/local-executor'

/** The executor itself — for tests and for plugins that wrap local execution. */
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
        settleOnCleanExit: req.sandbox.settleOnCleanExit,
      })
    },
  }
}

/** Declare in vx.workspace.ts: `plugins: [localExecutorPlugin(), …]`. Accepts every task. */
export function localExecutorPlugin(): VxPlugin {
  return { name: LOCAL_EXECUTOR_PLUGIN, executor: () => localExecutor() }
}
