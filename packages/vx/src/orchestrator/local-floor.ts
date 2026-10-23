// Core's local floor for a plugin that runs tasks itself: `@vzn/vx-dte`'s
// orchestrator for its own share, and its workers, which run tasks another
// machine placed. A run arms the sandbox runtime before it builds a
// sandboxed request; a worker is no run, so it arms here. It starts a
// request's servers (`ExecuteRequest.servers`) once each, before the
// task, and stops them when it closes.

import type { ExecConfig } from '../config.js'
import {
  localExecutor,
  resetSandbox,
  runPersistent,
  type ExecuteRequest,
  type ExecuteResult,
  type ServerSpec,
} from '../exec/index.js'
import { prepareSandbox } from './sandbox-request.js'
import { forwardedSignal, terminateChildren } from './signals.js'

export interface LocalFloor {
  execute(req: ExecuteRequest): Promise<ExecuteResult>
  /** Arms the sandbox runtime for `sandboxes` from the next sandboxed task on; its servers keep running. */
  rearm(sandboxes: readonly NonNullable<ExecConfig['sandbox']>[]): Promise<void>
  /** Stops the servers this started and the sandbox runtime this armed. */
  close(): Promise<void>
}

/**
 * `sandboxes`, in a process that is no run, are the `exec.sandbox` configs
 * of every sandboxed task the run holds: the runtime's proxy and its
 * unix-socket filter are one per process, set from their union before the
 * first sandboxed task (`prepareSandbox`). A request that carries a
 * `signal` but no `liveChildren` has its children stopped here when it
 * aborts, the way a run's stop ends its own.
 */
export function localFloor(
  sandboxes: readonly NonNullable<ExecConfig['sandbox']>[] = [],
): LocalFloor {
  const local = localExecutor()
  const prepare = (list: typeof sandboxes) =>
    prepareSandbox(list.map((sandbox) => ({ config: { exec: { sandbox } } })))
  let armer = prepare(sandboxes)
  // Each server, by task id: shared by every task here that depends on it.
  const servers = new Map<string, Promise<ReturnType<typeof Bun.spawn>>>()
  const children: ReturnType<typeof Bun.spawn>[] = []
  const serve = (spec: ServerSpec): Promise<unknown> => {
    let up = servers.get(spec.taskId)
    if (up === undefined) {
      const spawn = runPersistent({
        command: spec.command,
        cwd: spec.cwd,
        env: spec.env,
        onStdout: () => {},
        onStderr: () => {},
        ...(spec.readyWhen === undefined ? {} : { readyWhen: spec.readyWhen }),
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      })
      children.push(spawn.child)
      up = spawn.ready.then(() => spawn.child)
      servers.set(spec.taskId, up)
      // One that never became ready is asked again by the next task.
      up.catch(() => servers.delete(spec.taskId))
    }
    return up
  }
  return {
    async execute(req) {
      for (const spec of req.servers ?? []) {
        try {
          await serve(spec)
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          return {
            exitCode: 1,
            durationMs: 0,
            stdout: '',
            stderr: `${spec.taskId}, which ${req.taskId} depends on, did not start: ${why}\n`,
            violations: [],
          }
        }
      }
      if (req.sandbox !== undefined) await armer?.arm()
      const stop = req.signal
      if (stop === undefined || req.liveChildren !== undefined) return local.execute(req)
      // No run holds this task's children (a worker's): its stop is ours to carry out.
      const live = new Set<ReturnType<typeof Bun.spawn>>()
      const end = (): void => void terminateChildren(() => [...live], forwardedSignal(stop.reason))
      stop.addEventListener('abort', end, { once: true })
      try {
        return await local.execute({ ...req, liveChildren: live })
      } finally {
        stop.removeEventListener('abort', end)
      }
    },
    async rearm(list) {
      if (armer?.armed === true) await resetSandbox()
      armer = prepare(list)
    },
    async close() {
      if (children.length > 0) await terminateChildren(() => children)
      if (armer?.armed === true) await resetSandbox()
    },
  }
}
