// A sandboxed task's port bridge listens on a unix socket in the sandbox
// temp dir. The socat that binds it dies with the task's namespace and
// never unlinks it, so every bridged run left one socket behind (item
// 877: 176 of them in one box's `/tmp/claude`).

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

  /**
   * The socket THIS run binds: a box that ran bridged tasks before item
   * 877 holds sockets for other tags, and a free port can be one of
   * theirs (the gate after 877 found one).
   */
  async function bound(port: number, before: readonly string[]): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const sock = sockets(port).find((s) => !before.includes(s))
      if (sock !== undefined) return sock
      await Bun.sleep(10)
    }
    throw new Error(`no bridge socket for port ${port}`)
  }

  it('is removed when the task ends', async () => {
    const port = freePort()
    const before = sockets(port)
    const running = run(port, 'sleep 1')
    // The positive first: the socket is there while the task runs.
    const sock = await bound(port, before)
    expect(existsSync(sock)).toBe(true)
    expect((await running).exitCode).toBe(0)
    expect(sockets(port)).toEqual(before)
  })

  it('is removed by an exit while the task runs', async () => {
    // In a child: `exit` runs every hook a process holds, SRT's `reset()`
    // among them, and emitted in the suite's own process it broke a later
    // file's bridge (item 881). The child exits the way a signal exit
    // does, `process.exit` with the task still running, once it has seen
    // the socket bound.
    const port = freePort()
    const script = `
      import { readdirSync } from 'node:fs'
      import path from 'node:path'
      const exec = await import(${JSON.stringify(path.resolve(import.meta.dir, '../src/exec/index.ts'))})
      const { portBridgeSocket } = await import(${JSON.stringify(path.resolve(import.meta.dir, '../src/exec/sandbox-runtime.ts'))})
      await exec.initSandbox({ allowAllUnixSockets: true })
      const dir = ${JSON.stringify(dir)}
      const tmp = path.dirname(portBridgeSocket('t', ${port}))
      const mine = (n) => n.startsWith('vx-port-') && n.endsWith('-${port}.sock')
      const before = readdirSync(tmp).filter(mine)
      void exec.runSandboxed({
        command: 'sleep 5', cwd: dir, env: process.env, baseAllowRead: [dir], baseDenyRead: [],
        reportWithin: dir, reportLinked: [],
        config: exec.resolveSandboxConfig({ allow: { localBinding: [${port}] } }, dir),
      })
      for (let i = 0; i < 500; i++) {
        const n = readdirSync(tmp).filter(mine).find((x) => !before.includes(x))
        if (n !== undefined) { console.log(path.join(tmp, n)); process.exit(0) }
        await Bun.sleep(10)
      }
      process.exit(3)
    `
    const proc = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const sock = out.trim()
    // The positive is the child's: it printed the socket once it existed.
    expect({ code, err, named: sock.endsWith(`-${port}.sock`) }).toEqual({
      code: 0,
      err: '',
      named: true,
    })
    expect(existsSync(sock)).toBe(false)
  }, 20_000)
})
