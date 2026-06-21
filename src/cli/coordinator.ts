// `vx coordinator` — distributed task execution coordinator (Phase A of
// distributed-ci-2026-06.md). Holds the per-run graph + ready queue +
// worker registrations; assigns tasks via the protocol extension in
// src/orchestrator/protocol.ts.
//
// v1 is a SCAFFOLD — bootable, parses flags, exposes the wire shape.
// The actual coordinator logic (graph build, ready queue, WS upgrade,
// fan-out) lands incrementally; the protocol is the contract.

import { UserError } from '../util/index.js'

export interface CoordinatorArgs {
  /** Tasks the run should execute. */
  tasks: readonly string[]
  /** Port to bind. Default 5180 (one above `vx serve`'s 5176/5177). */
  port: number
  /** Bind host. Default 127.0.0.1 (loopback). */
  host: string
  /** Maximum workers expected to attach. Coordinator exits when all done. */
  expectedWorkers: number
}

export function parseCoordinatorArgs(args: readonly string[]): CoordinatorArgs {
  let port = 5180
  let host = '127.0.0.1'
  let expectedWorkers = 1
  const tasks: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--port') {
      const v = Number(args[++i])
      if (!Number.isInteger(v) || v < 0 || v > 65_535) {
        throw new UserError('vx coordinator --port must be a valid port number')
      }
      port = v
    } else if (a === '--host') {
      const v = args[++i]
      if (!v) throw new UserError('vx coordinator --host requires a value')
      host = v
    } else if (a === '--workers') {
      const v = Number(args[++i])
      if (!Number.isInteger(v) || v < 1) {
        throw new UserError('vx coordinator --workers must be a positive integer')
      }
      expectedWorkers = v
    } else if (a.startsWith('-')) {
      throw new UserError(`vx coordinator: unknown flag ${a}`)
    } else {
      tasks.push(a)
    }
  }
  if (tasks.length === 0) {
    throw new UserError('vx coordinator: at least one task name is required')
  }
  return { tasks, port, host, expectedWorkers }
}

export async function coordinatorCmd(args: readonly string[]): Promise<number> {
  const parsed = parseCoordinatorArgs(args)
  process.stdout.write(
    `vx coordinator scaffold — would bind ${parsed.host}:${parsed.port}\n` +
      `  tasks:    ${parsed.tasks.join(', ')}\n` +
      `  workers:  expecting ${parsed.expectedWorkers}\n` +
      `  protocol: ClientMessage/ServerMessage extension in src/orchestrator/protocol.ts\n` +
      `  see:      docs/design/distributed-ci-2026-06.md\n`,
  )
  return 0
}
