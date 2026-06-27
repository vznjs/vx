// `vx-cloud dev` — the foreground devtools hub. NOT a background daemon: you
// run it in a terminal, it serves a devframe dev server (browser/TUI clients
// connect) and listens on a per-workspace unix socket for forwarded runs.
// Every `vx run` while it's up streams its events here (see dev-client.ts);
// when it's down, runs behave exactly as before. Ctrl-C stops it.

import path from 'node:path'
import { mkdir, unlink } from 'node:fs/promises'
import type { DevframeDefinition, DevframeNodeContext, RpcStreamingChannel } from 'devframe'
import { findWorkspaceRoot, UserError, VERSION, type WireEvent } from '@vzn/vx'
import { bootDevframeServer } from './ui-server.js'

/** Per-workspace socket path the hub listens on and runs forward to. */
export function devSocketPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.vx', 'dev.sock')
}

interface DaemonSurface {
  definition: DevframeDefinition
  /** Write a forwarded event onto the live `vx:events` stream. */
  push: (event: WireEvent) => void
}

/**
 * The hub's devframe definition: a single perpetual `vx:events` stream
 * carrying every forwarded run's events. Unlike the per-run surface it
 * never closes the stream (the hub outlives any one run).
 */
function createDaemonSurface(): DaemonSurface {
  let write: (event: WireEvent) => void = () => {}
  const definition: DevframeDefinition = {
    id: 'vx',
    name: 'vx',
    version: VERSION,
    setup(ctx: DevframeNodeContext) {
      const channel: RpcStreamingChannel<WireEvent> = ctx.rpc.streaming.create('vx:events')
      const stream = channel.start({ id: 'events' })
      write = (event) => {
        try {
          stream.write(event)
        } catch {
          // a client dropping mid-run must not affect ingest
        }
      }
    },
  }
  return { definition, push: (event) => write(event) }
}

export interface DevHub {
  origin: string
  sockPath: string
  stop: () => Promise<void>
}

/**
 * Boot the hub: devframe server + the unix-socket listener. Each incoming
 * connection is one `vx run`; its NDJSON `WireEvent` lines are parsed,
 * pushed onto the devframe stream, and handed to `onEvent` (the terminal
 * activity log + tests).
 */
export async function startDevHub(opts: {
  root: string
  port?: number
  onEvent?: (event: WireEvent) => void
}): Promise<DevHub> {
  const { definition, push } = createDaemonSurface()
  const server = await bootDevframeServer(definition, opts.port)

  const sockPath = devSocketPath(opts.root)
  await mkdir(path.dirname(sockPath), { recursive: true })
  // Clear a stale socket from a crashed previous hub — bind would fail.
  try {
    await unlink(sockPath)
  } catch {
    // not present — fine
  }

  // Per-connection line buffer: a write may split a line across packets.
  const buffers = new Map<unknown, string>()
  const handleLine = (line: string): void => {
    if (line.length === 0) return
    let event: WireEvent
    try {
      event = JSON.parse(line) as WireEvent
    } catch {
      return // a torn/garbage line is dropped, never fatal
    }
    push(event)
    opts.onEvent?.(event)
  }

  const listener = Bun.listen({
    unix: sockPath,
    socket: {
      open(socket) {
        buffers.set(socket, '')
      },
      data(socket, data) {
        const text = (buffers.get(socket) ?? '') + data.toString()
        const parts = text.split('\n')
        buffers.set(socket, parts.pop() ?? '') // trailing partial line
        for (const line of parts) handleLine(line)
      },
      close(socket) {
        buffers.delete(socket)
      },
      error() {
        // a misbehaving client connection is isolated
      },
    },
  })

  return {
    origin: server.origin,
    sockPath,
    stop: async () => {
      listener.stop()
      await server.close()
      try {
        await unlink(sockPath)
      } catch {
        // already gone
      }
    },
  }
}

/** A concise one-line activity log for the hub's own foreground terminal. */
function printDevLine(event: WireEvent): void {
  switch (event.kind) {
    case 'run:start':
      process.stdout.write(`▶ run started — ${event.info.total} task(s)\n`)
      return
    case 'task:complete': {
      const o = event.outcome
      const mark = o.status === 'failed' ? '✗' : o.status === 'skipped' ? '⊘' : '✓'
      process.stdout.write(`  ${mark} ${o.taskId}  ${o.status}  ${o.durationMs}ms\n`)
      return
    }
    case 'run:end':
      process.stdout.write('■ run finished\n\n')
      return
  }
}

function parseDevArgs(args: readonly string[]): { port?: number; error?: string } {
  const out: { port?: number; error?: string } = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--port') {
      const v = args[++i]
      const n = Number(v)
      if (v === undefined || !Number.isInteger(n) || n < 0 || n > 65535) {
        return { error: `invalid --port: ${v}` }
      }
      out.port = n
    } else if (a?.startsWith('--port=')) {
      const v = a.slice('--port='.length)
      const n = Number(v)
      if (!Number.isInteger(n) || n < 0 || n > 65535) return { error: `invalid --port: ${v}` }
      out.port = n
    } else {
      return { error: `unknown flag: ${a}` }
    }
  }
  return out
}

export async function devCmd(args: readonly string[]): Promise<number> {
  const parsed = parseDevArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx dev: ${parsed.error}\n`)
    return 1
  }

  const root = await findWorkspaceRoot(process.cwd())
  let hub: DevHub
  try {
    hub = await startDevHub({
      root,
      ...(parsed.port !== undefined ? { port: parsed.port } : {}),
      onEvent: printDevLine,
    })
  } catch (err) {
    const msg = err instanceof UserError || err instanceof Error ? err.message : String(err)
    process.stderr.write(`vx dev: ${msg}\n`)
    return 1
  }

  process.stdout.write(
    `vx dev: devtools at ${hub.origin}\n` +
      `vx dev: listening for runs at ${hub.sockPath}\n` +
      `(press Ctrl-C to stop)\n\n`,
  )

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })

  await hub.stop()
  process.stdout.write('\nvx dev: stopped\n')
  return 0
}
