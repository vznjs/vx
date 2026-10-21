// Core's local floor for a plugin that runs tasks itself: `@vzn/vx-dte`'s
// orchestrator for its own share, and its agents, which run tasks another
// machine placed. A run arms the sandbox runtime before it builds a
// sandboxed request; an agent is no run, so it arms here.

import type { ExecConfig } from '../config.js'
import {
  localExecutor,
  resetSandbox,
  type ExecuteRequest,
  type ExecuteResult,
} from '../exec/index.js'
import { prepareSandbox } from './sandbox-request.js'
import { forwardedSignal, terminateChildren } from './signals.js'

export interface LocalFloor {
  execute(req: ExecuteRequest): Promise<ExecuteResult>
  /** Stops the sandbox runtime this armed. */
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
  const armer = prepareSandbox(sandboxes.map((sandbox) => ({ config: { exec: { sandbox } } })))
  return {
    async execute(req) {
      if (req.sandbox !== undefined) await armer?.arm()
      const stop = req.signal
      if (stop === undefined || req.liveChildren !== undefined) return local.execute(req)
      // No run holds this task's children (an agent's): its stop is ours to carry out.
      const live = new Set<ReturnType<typeof Bun.spawn>>()
      const end = (): void => void terminateChildren(() => [...live], forwardedSignal(stop.reason))
      stop.addEventListener('abort', end, { once: true })
      try {
        return await local.execute({ ...req, liveChildren: live })
      } finally {
        stop.removeEventListener('abort', end)
      }
    },
    async close() {
      if (armer?.armed === true) await resetSandbox()
    },
  }
}
