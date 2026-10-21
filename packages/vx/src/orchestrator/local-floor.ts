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

export interface LocalFloor {
  execute(req: ExecuteRequest): Promise<ExecuteResult>
  /** Stops the sandbox runtime this armed. */
  close(): Promise<void>
}

/**
 * `sandboxes`, in a process that is no run, are the `exec.sandbox` configs
 * of every sandboxed task the run holds: the runtime's proxy and its
 * unix-socket filter are one per process, set from their union before the
 * first sandboxed task (`prepareSandbox`).
 */
export function localFloor(
  sandboxes: readonly NonNullable<ExecConfig['sandbox']>[] = [],
): LocalFloor {
  const local = localExecutor()
  const armer = prepareSandbox(sandboxes.map((sandbox) => ({ config: { exec: { sandbox } } })))
  return {
    async execute(req) {
      if (req.sandbox !== undefined) await armer?.arm()
      return local.execute(req)
    },
    async close() {
      if (armer?.armed === true) await resetSandbox()
    },
  }
}
