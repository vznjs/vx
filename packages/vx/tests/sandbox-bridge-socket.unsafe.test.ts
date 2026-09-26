// A sandboxed task's port bridge listens on a unix socket in the sandbox
// temp dir. The socat that binds it dies with the task's namespace and
// never unlinks it, so every bridged run left one socket behind (item
// 877: 176 of them in one box's `/tmp/claude`). Its own file because the
// exit row emits `exit`, which runs every exit hook the process holds.

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { portBridgeSocket } from '../src/exec/sandbox-runtime.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox bridge socket test')

/** A port nothing on this box listens on: bind it, read it, release it. */
function freePort(): number {
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = l.port
  l.stop(true)
  return port
}

/** The bridge sockets for `port`, whatever their task's tag. */
function sockets(port: number): string[] {
  const dir = path.dirname(portBridgeSocket('t', port))
  return readdirSync(dir)
    .filter((n) => n.startsWith('vx-port-') && n.endsWith(`-${port}.sock`))
    .map((n) => path.join(dir, n))
}

describe.skipIf(!available || process.platform !== 'linux')('a port bridge’s socket', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-bridge-sock-')))
    // The bridge IS a unix socket: a run holding a port list lifts the filter.
    await initSandbox({ allowAllUnixSockets: true })
  })
  afterEach(async () => {
    await resetSandbox()
    await rm(dir, { recursive: true, force: true })
  })

  const run = (port: number, command: string) =>
    runSandboxed({
      command,
      cwd: dir,
      env: process.env,
      baseAllowRead: [dir],
      baseDenyRead: [],
      reportWithin: dir,
      reportLinked: [],
      config: resolveSandboxConfig({ allow: { localBinding: [port] } }, dir),
    })

  async function bound(port: number): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const [sock] = sockets(port)
      if (sock !== undefined) return sock
      await Bun.sleep(10)
    }
    throw new Error(`no bridge socket for port ${port}`)
  }

  it('is removed when the task ends', async () => {
    const port = freePort()
    const running = run(port, 'sleep 1')
    // The positive first: the socket is there while the task runs.
    const sock = await bound(port)
    expect(existsSync(sock)).toBe(true)
    expect((await running).exitCode).toBe(0)
    expect(sockets(port)).toEqual([])
  })

  it('is removed by an exit while the task runs', async () => {
    const port = freePort()
    const running = run(port, 'sleep 2')
    const sock = await bound(port)
    expect(existsSync(sock)).toBe(true)
    process.emit('exit', 0)
    const left = existsSync(sock)
    await running
    expect(left).toBe(false)
  })
})
