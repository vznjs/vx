// `vx-cloud dev` — the foreground devtools hub. NOT a background daemon: you
// run it in a terminal, it serves a devframe dev server (browser/TUI clients
// connect) and listens on a per-workspace unix socket for forwarded runs.
// Every `vx run` while it's up streams its events here (see dev-client.ts);
// when it's down, runs behave exactly as before. Ctrl-C stops it.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import type { DevframeDefinition, DevframeNodeContext, RpcStreamingChannel } from 'devframe'
import { findWorkspaceRoot, parseDecimalInt, UserError, VERSION, type WireEvent } from '@vzn/vx'
import { bootDevframeServer } from './ui-server.js'

/** Per-workspace socket path the hub listens on and runs forward to. */
export function devSocketPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.vx', 'dev.sock')
}

/**
 * Is a hub actually listening on this socket, or is the file a leftover from
 * one that crashed? The same question `connectDevForwarder` asks on the read
 * side — a present file proves nothing, a successful connect does.
 */
async function socketIsLive(sockPath: string): Promise<boolean> {
  try {
    const probe = await Bun.connect({
      unix: sockPath,
      socket: { data() {}, open() {}, close() {}, error() {} },
    })
    probe.end()
    return true
  } catch {
    return false // refused: the file is a leftover, safe to reclaim
  }
}

/**
 * Claim the workspace's socket path, refusing to take one a live hub owns.
 *
 * A second bind REBINDS the path to the new hub: measured on raw listeners, a
 * forwarded run afterwards lands entirely on the second hub (A=0, B=1) while
 * the first keeps printing that it is listening. Worse, when the first hub
 * then stops, its `stop()` unlinks the socket the second now owns — after
 * which every connect is refused and BOTH hubs are dark, with no error
 * anywhere. This is the sibling policy `vx-cloud serve` already settled for
 * its port: a busy address is a clean refusal, never a silent move.
 *
 * There is NO kernel backstop to lean on — measured, `Bun.listen({ unix })`
 * silently replaces an already-bound socket with no `unlink` and no
 * EADDRINUSE, so this check is the only thing standing between two hubs.
 * Residual: two hubs racing inside the check→listen window can still both
 * bind, and the loser goes dark. That needs two `vx dev` processes started
 * within microseconds of each other, and is strictly narrower than the
 * unconditional steal it replaces.
 */
async function claimSocket(sockPath: string): Promise<void> {
  await mkdir(path.dirname(sockPath), { recursive: true })
  if (!existsSync(sockPath)) return
  if (await socketIsLive(sockPath)) {
    throw new UserError(
      `another vx dev is already listening at ${sockPath} — stop it first (Ctrl-C in its terminal)`,
    )
  }
  // Stale socket from a crashed hub: bind would fail, so reclaim it.
  await unlink(sockPath)
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

  // Claim the socket BEFORE booting the dev server: a refusal must not leave
  // an orphaned HTTP listener behind.
  const sockPath = devSocketPath(opts.root)
  await claimSocket(sockPath)

  const server = await bootDevframeServer(definition, opts.port)

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

/**
 * `parseDecimalInt`, not `Number`: the bare coercion this replaced accepted
 * `0x10` as port 16, `1e3` as 1000, `" 8080 "` and `"+80"` — a validator that
 * refuses `abc` and then binds a port nobody typed. It was the last surviving
 * copy of that shape in cloud; the 2026-07-30 sweep converted four siblings
 * (`distributeOf`, `env.ts`, `submit.ts`, `server.ts`'s boot knobs) and missed
 * this one. Digits-only also makes a `< 0` arm unreachable, so there isn't one.
 * `0` stays valid — it asks the kernel for an ephemeral port.
 */
export function parsePort(v: string | undefined): number | { error: string } {
  const n = v === undefined ? null : parseDecimalInt(v)
  if (n === null || n > 65535) return { error: `invalid --port: ${v}` }
  return n
}

function parseDevArgs(args: readonly string[]): { port?: number; error?: string } {
  const out: { port?: number; error?: string } = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--port' || a?.startsWith('--port=')) {
      const parsed = parsePort(a === '--port' ? args[++i] : a.slice('--port='.length))
      if (typeof parsed !== 'number') return parsed
      out.port = parsed
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
