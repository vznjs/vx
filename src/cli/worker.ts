// `vx run --worker <coord-url>` — distributed-CI worker handler
// (architecture-review §2.1 + distributed-ci-2026-06.md Phase B).
// Stateless and fungible: connect, send worker:hello, pull tasks,
// execute, report. Content addressing makes work assignable across
// any worker that holds the same workspace checkout.

import {
  workerExecute,
  type ClientMessage,
  type ServerMessage,
  type WireOutcome,
  type WireTaskNode,
} from '../orchestrator/index.js'
import { UserError } from '../util/index.js'

export interface WorkerArgs {
  coordinatorUrl: string
  capacity: number
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

/**
 * Real worker loop. Connects, registers, pulls, executes via runCommand,
 * reports outcomes back. Returns when the coordinator drains us or the
 * connection closes.
 */
export async function runWorker(opts: {
  coordinatorUrl: string
  capacity: number
  labels: readonly string[]
  onStatus?: (line: string) => void
}): Promise<{ ok: boolean }> {
  const status = opts.onStatus ?? (() => undefined)
  const workerId = Bun.randomUUIDv7()
  const wsUrl = opts.coordinatorUrl.replace(/^http/, 'ws')

  let ok = true
  let inFlight = 0
  let drained = false
  const ws = new WebSocket(wsUrl)
  return await new Promise<{ ok: boolean }>((resolve) => {
    const send = (msg: ClientMessage): void => {
      try {
        ws.send(JSON.stringify(msg))
      } catch {
        // socket closed mid-write; close handler resolves us
      }
    }
    ws.onopen = () => {
      send({ t: 'worker:hello', workerId, capacity: opts.capacity, labels: opts.labels })
      send({ t: 'worker:pull', available: opts.capacity })
    }
    ws.onclose = () => {
      resolve({ ok })
    }
    ws.onerror = () => {
      ok = false
    }
    ws.onmessage = async (ev) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage
      } catch {
        return
      }
      if (msg.t === 'task:assign') {
        inFlight++
        void executeAssigned(msg.node, msg.hash)
      } else if (msg.t === 'coord:drain') {
        drained = true
        if (inFlight === 0) {
          send({ t: 'worker:bye', reason: 'shutdown' })
          ws.close()
        }
      }
    }

    async function executeAssigned(node: WireTaskNode, hash: string): Promise<void> {
      send({ t: 'worker:start', taskHash: hash })
      status(`▶ ${node.id}`)
      const t0 = Date.now()
      let outcome: WireOutcome
      try {
        const result = await workerExecute({
          command: node.command,
          cwd: node.projectDir,
          env: { ...process.env },
          onStdout: (chunk) => send({ t: 'worker:stdout', taskHash: hash, chunk }),
          onStderr: (chunk) => send({ t: 'worker:stderr', taskHash: hash, chunk }),
        })
        outcome = {
          status: result.exitCode === 0 ? 'success' : 'failed',
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          cacheSource: 'miss',
        }
      } catch (err) {
        outcome = {
          status: 'failed',
          exitCode: 1,
          durationMs: Date.now() - t0,
          cacheSource: 'miss',
        }
        const msg = err instanceof Error ? err.message : String(err)
        send({ t: 'worker:stderr', taskHash: hash, chunk: msg + '\n' })
      }
      if (outcome.status !== 'success') ok = false
      send({ t: 'worker:done', taskHash: hash, outcome })
      status(`${outcome.status === 'success' ? '✓' : '✗'} ${node.id} (${outcome.durationMs}ms)`)
      inFlight--
      if (drained && inFlight === 0) {
        send({ t: 'worker:bye', reason: 'shutdown' })
        ws.close()
      } else {
        send({ t: 'worker:pull', available: opts.capacity - inFlight })
      }
    }
  })
}

export async function workerCmd(args: readonly string[]): Promise<number> {
  const parsed = parseWorkerArgs(args)
  process.stdout.write(
    `vx worker: connecting to ${parsed.coordinatorUrl} (cap=${parsed.capacity}, labels=${parsed.labels.join(',')})\n`,
  )
  const result = await runWorker({
    coordinatorUrl: parsed.coordinatorUrl,
    capacity: parsed.capacity,
    labels: parsed.labels,
    onStatus: (line) => process.stdout.write(`  ${line}\n`),
  })
  process.stdout.write(`\nvx worker: ${result.ok ? 'done' : 'failed'}\n`)
  return result.ok ? 0 : 1
}
