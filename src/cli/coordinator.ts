// `vx coordinator` — distributed task execution coordinator
// (architecture-review §2.1 + distributed-ci-2026-06.md). Holds the
// per-run graph + ready queue + worker registrations; assigns tasks
// to workers via the protocol extension in src/orchestrator/protocol.ts.
//
// v1 implementation: in-process scheduler, real WS server, real fan-out.
// Content addressing = (project#task → hash) is the assignment key. The
// coordinator runs the SAME `prepareRun → buildTaskGraph` pipeline the
// CLI does locally; workers receive only the resolved task descriptors.

import path from 'node:path'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import {
  computeTaskHashForCoord,
  createEventBus,
  prepareForCoordinator,
  type ClientMessage,
  type ServerMessage,
  type WireTaskNode,
} from '../orchestrator/index.js'
import { findWorkspaceRoot } from '../workspace/index.js'
import { UserError } from '../util/index.js'

export interface CoordinatorArgs {
  tasks: readonly string[]
  port: number
  host: string
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

interface WorkerHandle {
  workerId: string
  capacity: number
  labels: readonly string[]
  inFlight: Set<string>
  send: (msg: ServerMessage) => void
  ws: { close(): void; send(s: string): void }
}

export interface CoordinatorServer {
  origin: string
  /** Resolves when the graph drains (every task in some terminal state). */
  done: Promise<{ ok: boolean }>
  stop: () => Promise<void>
}

/** Boot a coordinator over WS at the given port; returns once it's accepting connections. */
export async function startCoordinator(opts: {
  workspaceRoot: string
  tasks: readonly string[]
  port: number
  host?: string
  onStatus?: (line: string) => void
}): Promise<CoordinatorServer> {
  const status = opts.onStatus ?? (() => undefined)

  // 1. Build the graph via the orchestrator's prepare pipeline.
  const bus = createEventBus()
  void bus
  const prepared = await prepareForCoordinator(opts.workspaceRoot, opts.tasks)
  if (prepared.empty !== null) {
    throw new UserError(`coordinator: ${prepared.empty}`)
  }

  // 2. Per-node: compute the cache hash (the assignment key — content
  //    addressing makes work fungible across workers).
  const hashByNode = new Map<string, string>()
  const nodeByHash = new Map<string, WireTaskNode>()
  for (const node of prepared.nodes.values()) {
    if (node.config.exec === undefined) continue // group tasks have no exec
    const hash = await computeTaskHashForCoord(node, prepared)
    hashByNode.set(node.id, hash)
    nodeByHash.set(hash, {
      id: node.id,
      projectName: node.projectName,
      projectDir: node.projectDir,
      taskName: node.taskName,
      command: node.config.exec.command,
      cacheable: node.config.cache !== undefined,
    })
  }

  // 3. Ready queue: nodes whose deps are all done. Starts as roots.
  const remaining = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const node of prepared.nodes.values()) {
    remaining.set(node.id, node.deps.length)
    for (const dep of node.deps) {
      const list = dependents.get(dep)
      if (list) list.push(node.id)
      else dependents.set(dep, [node.id])
    }
  }
  const ready: string[] = []
  for (const [id, n] of remaining) if (n === 0) ready.push(id)
  let outcomes = 0
  let okSoFar = true
  const target = [...prepared.nodes.values()].filter((n) => n.config.exec !== undefined).length

  const workers = new Map<string, WorkerHandle>()
  let doneResolve!: (r: { ok: boolean }) => void
  const done = new Promise<{ ok: boolean }>((r) => {
    doneResolve = r
  })

  function dispatch(): void {
    if (ready.length === 0) return
    for (const w of workers.values()) {
      if (w.inFlight.size >= w.capacity) continue
      while (ready.length > 0 && w.inFlight.size < w.capacity) {
        const id = ready.shift()!
        const hash = hashByNode.get(id)
        const wire = hash !== undefined ? nodeByHash.get(hash) : undefined
        if (hash === undefined || wire === undefined) continue
        w.inFlight.add(hash)
        w.send({ t: 'task:assign', hash, node: wire })
        status(`→ ${wire.id} → worker ${w.workerId}`)
      }
    }
  }

  function complete(hash: string, success: boolean): void {
    const wire = nodeByHash.get(hash)
    if (!wire) return
    const id = wire.id
    outcomes++
    if (!success) okSoFar = false
    for (const dep of dependents.get(id) ?? []) {
      const r = (remaining.get(dep) ?? 0) - 1
      remaining.set(dep, r)
      if (r === 0) ready.push(dep)
    }
    if (outcomes >= target) {
      for (const w of workers.values()) {
        w.send({ t: 'coord:drain' })
      }
      doneResolve({ ok: okSoFar })
    } else {
      dispatch()
    }
  }

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host ?? '127.0.0.1',
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/health') return new Response('ok')
      if (srv.upgrade(req)) return undefined
      return new Response('vx coordinator')
    },
    websocket: {
      message(ws, raw) {
        let msg: ClientMessage
        try {
          msg = JSON.parse(String(raw)) as ClientMessage
        } catch {
          return
        }
        if (msg.t === 'worker:hello') {
          const w: WorkerHandle = {
            workerId: msg.workerId,
            capacity: msg.capacity,
            labels: msg.labels,
            inFlight: new Set(),
            send: (m) => {
              try {
                ws.send(JSON.stringify(m))
              } catch {
                // worker dropped; cleanup happens on close
              }
            },
            ws,
          }
          workers.set(msg.workerId, w)
          status(`+ worker ${msg.workerId} cap=${msg.capacity} labels=[${msg.labels.join(',')}]`)
          dispatch()
        } else if (msg.t === 'worker:pull') {
          dispatch()
        } else if (msg.t === 'worker:done') {
          for (const w of workers.values()) {
            if (w.inFlight.has(msg.taskHash)) {
              w.inFlight.delete(msg.taskHash)
              complete(msg.taskHash, msg.outcome.status === 'success')
              break
            }
          }
        } else if (msg.t === 'worker:bye') {
          // worker draining itself; close handled below
        }
      },
      close(ws) {
        // Find which worker owned this socket, reassign its in-flight.
        for (const [id, w] of workers) {
          if (w.ws === ws) {
            const stranded = [...w.inFlight]
            workers.delete(id)
            status(`- worker ${id} (stranded ${stranded.length} task(s))`)
            for (const hash of stranded) {
              const wire = nodeByHash.get(hash)
              if (wire) ready.unshift(wire.id)
            }
            dispatch()
            break
          }
        }
      },
    },
  })

  const origin = `http://${opts.host ?? '127.0.0.1'}:${server.port}`
  const infoPath = path.join(opts.workspaceRoot, '.vx', 'coordinator.json')
  await mkdir(path.dirname(infoPath), { recursive: true })
  await writeFile(infoPath, JSON.stringify({ origin, pid: process.pid, tasks: opts.tasks }))

  return {
    origin,
    done,
    stop: async () => {
      prepared.cache.close()
      await server.stop(true)
      try {
        await unlink(infoPath)
      } catch {
        // best effort
      }
    },
  }
}

export async function coordinatorCmd(args: readonly string[]): Promise<number> {
  const parsed = parseCoordinatorArgs(args)
  const root = await findWorkspaceRoot(process.cwd())
  const coord = await startCoordinator({
    workspaceRoot: root,
    tasks: parsed.tasks,
    port: parsed.port,
    host: parsed.host,
    onStatus: (line) => process.stdout.write(`  ${line}\n`),
  })
  process.stdout.write(
    `vx coordinator: ${coord.origin}\n` +
      `vx coordinator: tasks=${parsed.tasks.join(',')} expecting ${parsed.expectedWorkers} worker(s)\n` +
      `(press Ctrl-C to stop)\n\n`,
  )
  const sigPromise = new Promise<{ ok: boolean }>((resolve) => {
    process.once('SIGINT', () => resolve({ ok: false }))
    process.once('SIGTERM', () => resolve({ ok: false }))
  })
  const result = await Promise.race([coord.done, sigPromise])
  await coord.stop()
  process.stdout.write(`\nvx coordinator: ${result.ok ? 'all tasks complete' : 'stopped'}\n`)
  return result.ok ? 0 : 1
}
