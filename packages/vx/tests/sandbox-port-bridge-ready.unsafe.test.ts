// A sandboxed server's port on the host (M-22). The host side of a
// `localBinding` port bridge is a socat vx spawns and does not wait for,
// so a server that bound and said so inside the sandbox could be ready
// before the host listened: the persistent-server row met a refusal on its
// port under I/O load. A fake `socat` first on PATH plays the loaded box:
// the host's listener starts 1 s late.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox port bridge ready test')
const realSocat = Bun.which('socat')

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
  })
}

function freePort(): number {
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = l.port
  l.stop(true)
  return port
}

describe.skipIf(!available || process.platform !== 'linux' || realSocat === null)(
  "a sandboxed server's bridged port",
  () => {
    let dir = ''
    let prevPath: string | undefined
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-port-ready-')))
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      await writeFile(
        path.join(bin, 'socat'),
        [
          '#!/bin/sh',
          'case "$1" in TCP-LISTEN:*,bind=127.0.0.1,*) sleep 1;; esac',
          `exec ${realSocat} "$@"`,
          '',
        ].join('\n'),
      )
      await chmod(path.join(bin, 'socat'), 0o755)
      prevPath = process.env['PATH']
      process.env['PATH'] = `${bin}:${prevPath ?? ''}`
      await resetSandbox()
      await initSandbox()
    })
    afterEach(async () => {
      process.env['PATH'] = prevPath
      await resetSandbox()
      // SRT keeps the last init's socat path across a reset (M-20).
      await initSandbox()
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    it('listens on the host by the time the task inside has started', async () => {
      const port = freePort()
      const task = runSandboxed({
        command: 'echo up > ready; while [ ! -e go ]; do sleep 0.02; done',
        cwd: dir,
        env: process.env,
        baseAllowRead: [dir],
        baseDenyRead: [],
        reportWithin: dir,
        reportLinked: [],
        config: resolveSandboxConfig(
          { allow: { read: ['.'], write: ['ready'], localBinding: [port] } },
          dir,
        ),
      })
      // vx creates a declared write file empty before the task runs: wait
      // on its content.
      const until = Date.now() + 20_000
      while ((await readFile(path.join(dir, 'ready'), 'utf8').catch(() => '')).trim() !== 'up') {
        if (Date.now() > until) throw new Error('the task never started')
        await Bun.sleep(5)
      }
      const open = await accepts(port)
      await writeFile(path.join(dir, 'go'), '')
      const r = await task
      expect([open, r.exitCode]).toEqual([true, 0])
    }, 30_000)
  },
)
