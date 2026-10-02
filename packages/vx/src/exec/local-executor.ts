// Core's own local executor: spawn the task's command here, in this
// process. Not a plugin — "run it on this machine" is not a capability
// someone else supplies differently, it is what running MEANS when no
// plugin claims the task, so it sits at the TAIL of every executor list
// (owner, 2026-09-05). An executor plugin places work ELSEWHERE; its
// absence is "here".
import { runCommand, signalExitCode } from './runner.js'
import { runSandboxed } from './sandbox-runtime.js'
import type { TaskExecutor } from './executor.js'

const locals = new WeakSet<TaskExecutor>()

/**
 * Whether `executor` is core's own. By identity: a plugin may name its
 * executor 'local', and core bounds a plugin's `execute` after an abort,
 * which the local one (it SIGKILLs its own group) never needs.
 */
export function isLocalExecutor(executor: TaskExecutor): boolean {
  return locals.has(executor)
}

/** The local executor. Accepts every task. */
export function localExecutor(): TaskExecutor {
  const executor: TaskExecutor = {
    name: 'local',
    async execute(req) {
      // A stop that landed before the spawn (during the output clean, the
      // request's build) leaves nothing to kill yet: a command spawned now
      // runs after the teardown swept the run's children, and held the run
      // to the signal's bound.
      if (req.signal?.aborted === true) {
        const reason: unknown = req.signal.reason
        const signal = reason === 'SIGINT' || reason === 'SIGHUP' ? reason : 'SIGTERM'
        const exitCode = signalExitCode(signal)
        return { exitCode, durationMs: 0, stdout: '', stderr: '', signal, violations: [] }
      }
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
      return runSandboxed({
        ...common,
        baseAllowRead: req.sandbox.baseAllowRead,
        baseDenyRead: req.sandbox.baseDenyRead,
        reportWithin: req.sandbox.reportWithin,
        reportLinked: req.sandbox.reportLinked,
        config: req.sandbox.config,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      })
    },
  }
  locals.add(executor)
  return executor
}
