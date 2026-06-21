// `vx run --worker <coord-url>` — distributed-CI worker handler. Scaffold
// (Phase B of distributed-ci-2026-06.md). Speaks the protocol extension
// from src/orchestrator/protocol.ts: hello → pull → start → done loop.
// Stateless and fungible; content addressing makes work assignable.
//
// v1 is a SCAFFOLD: parses the coordinator URL, prints the wire shape
// it would speak. The pull loop + exec integration lands when the
// coordinator (cli/coordinator.ts) gains its real handler.

import { UserError } from '../util/index.js'

export interface WorkerArgs {
  coordinatorUrl: string
  /** Worker concurrency — how many tasks to pull at once. */
  capacity: number
  /** Capability labels reported to the coordinator (`linux-x64`, `gpu`, etc.). */
  labels: readonly string[]
}

export function parseWorkerArgs(args: readonly string[]): WorkerArgs {
  let coordinatorUrl: string | undefined
  let capacity = 1
  const labels: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--worker' || a === '--coordinator') {
      const v = args[++i]
      if (!v) throw new UserError('vx run --worker requires a coordinator URL')
      coordinatorUrl = v
    } else if (a === '--capacity') {
      const v = Number(args[++i])
      if (!Number.isInteger(v) || v < 1) {
        throw new UserError('vx run --capacity must be a positive integer')
      }
      capacity = v
    } else if (a === '--label') {
      const v = args[++i]
      if (!v) throw new UserError('vx run --label requires a value')
      labels.push(v)
    }
  }
  if (!coordinatorUrl) {
    throw new UserError('vx run --worker: coordinator URL is required')
  }
  return { coordinatorUrl, capacity, labels: labels.length === 0 ? ['linux-x64'] : labels }
}

export async function workerCmd(args: readonly string[]): Promise<number> {
  const parsed = parseWorkerArgs(args)
  process.stdout.write(
    `vx worker scaffold — would attach to ${parsed.coordinatorUrl}\n` +
      `  workerId: ${Bun.randomUUIDv7()}\n` +
      `  capacity: ${parsed.capacity}\n` +
      `  labels:   ${parsed.labels.join(', ')}\n` +
      `  protocol: ClientMessage/ServerMessage extension in src/orchestrator/protocol.ts\n` +
      `  see:      docs/design/distributed-ci-2026-06.md\n`,
  )
  return 0
}
