// Core's own local executor: spawn the task's command here, in this
// process. Not a plugin — "run it on this machine" is not a capability
// someone else supplies differently, it is what running MEANS when no
// plugin claims the task, so it sits at the TAIL of every executor list
// (owner, 2026-09-05). An executor plugin places work ELSEWHERE; its
// absence is "here".
import { runCommand } from './runner.js'
import { runSandboxed } from './sandbox-runtime.js'
import type { TaskExecutor } from './executor.js'

/** The local executor. Accepts every task. */
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
