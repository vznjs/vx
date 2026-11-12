// Which loopback the task's side of a port bridge dials (X-91). It always
// dialled 127.0.0.1, so a server bound to `::1` alone (Vite's `localhost`
// on a host that resolves `::1` first) was unreachable through the bridge.
// The dial script reads the namespace's listen tables per connection; here
// it reads fixture tables, and a stub `socat` prints the address it got.

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { PORT_DIAL_SCRIPT, PROXY_BRIDGE_WAIT } from '../src/sandbox/runtime.js'

const HEAD =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
const V4 = { loop: '0100007F', any: '00000000' }
const V6 = {
  loop: '00000000000000000000000001000000',
  any: '00000000000000000000000000000000',
}

/** A /proc/net table row: `addr:port`, state `st` (0A listens, 01 is established). */
const row = (i: number, addr: string, port: number, st = '0A'): string => {
  const rem = addr.length === 8 ? '00000000:0000' : `${V6.any}:0000`
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  return `   ${i}: ${addr}:${hex} ${rem} ${st} 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0\n`
}

describe('the bridge dial', () => {
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-dial-'))
    await mkdir(path.join(dir, 'bin'))
    await writeFile(path.join(dir, 'bin', 'socat'), '#!/bin/sh\necho "$2"\n')
    await chmod(path.join(dir, 'bin', 'socat'), 0o755)
    await writeFile(path.join(dir, 'dial.sh'), PORT_DIAL_SCRIPT)
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  let n = 0
  async function dial(port: number, tcp: string[], tcp6: string[] | null): Promise<string> {
    const net = path.join(dir, `net-${n++}`)
    await mkdir(net)
    await writeFile(path.join(net, 'tcp'), HEAD + tcp.join(''))
    // A host with no IPv6 has no tcp6 table at all.
    if (tcp6 !== null) await writeFile(path.join(net, 'tcp6'), HEAD + tcp6.join(''))
    const p = Bun.spawn(['sh', path.join(dir, 'dial.sh'), String(port), net], {
      env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env['PATH'] ?? ''}` },
      stdout: 'pipe',
    })
    const out = (await new Response(p.stdout).text()).trim()
    expect(await p.exited).toBe(0)
    return out
  }

  it('dials ::1 when only ::1 listens on the port', async () => {
    expect(await dial(5173, [], [row(0, V6.loop, 5173)])).toBe('TCP6:[::1]:5173')
  })

  it('dials 127.0.0.1 when it, every IPv4 address or every address listens', async () => {
    expect([
      await dial(5173, [row(0, V4.loop, 5173)], [row(0, V6.loop, 5173)]),
      await dial(5173, [row(0, V4.any, 5173)], [row(0, V6.loop, 5173)]),
      await dial(5173, [row(0, V4.loop, 5173)], []),
      await dial(5173, [], [row(0, V6.any, 5173)]),
    ]).toEqual(Array(4).fill('TCP4:127.0.0.1:5173'))
  })

  it('dials 127.0.0.1 when ::1 holds another port, only a connection, or nothing', async () => {
    expect([
      await dial(5173, [], [row(0, V6.loop, 5174)]),
      await dial(5173, [], [row(0, V6.loop, 5173, '01')]),
      await dial(5173, [], []),
      await dial(5173, [], null),
    ]).toEqual(Array(4).fill('TCP4:127.0.0.1:5173'))
  })
})

// The wait in front of a sandboxed command for the runtime's proxy
// bridges gave up after ~5 s in silence: under a TMPDIR with a space the
// bridges never listened, and every task paid the 5 s and met a refused
// proxy, nothing saying why (2026-11-10). Here it reads fixture tables,
// with its bound cut to two tries.
describe('the proxy bridge wait', () => {
  async function wait(listening: boolean): Promise<{ code: number; err: string }> {
    const net = await mkdtemp(path.join(os.tmpdir(), 'vx-proxy-wait-'))
    try {
      const rows = listening ? row(0, V4.loop, 3128) + row(1, V4.loop, 1080) : ''
      await writeFile(path.join(net, 'tcp'), HEAD + rows)
      const script = PROXY_BRIDGE_WAIT.replaceAll('/proc/net/', `${net}/`).replace(
        '-ge 500',
        '-ge 2',
      )
      expect(script).not.toContain('/proc/net/')
      const p = Bun.spawn(['sh', '-c', `${script} exit 0`], { stderr: 'pipe' })
      const err = await new Response(p.stderr).text()
      return { code: await p.exited, err }
    } finally {
      await rm(net, { recursive: true, force: true })
    }
  }

  it('says so when the bridges never listen, and goes on to the command', async () => {
    expect([await wait(true), await wait(false)]).toEqual([
      { code: 0, err: '' },
      {
        code: 0,
        err: "[vx] the sandbox's network proxy bridges (ports 3128 and 1080) did not listen within 5 s; this task's network requests will be refused\n",
      },
    ])
  })
})
