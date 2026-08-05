import { describe, it, expect } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { wireForwarder, type TaskNode, type TaskOutcome, type WireEvent } from '@vzn/vx'
import { startDevHub, devSocketPath, parsePort } from '../src/cli/dev.js'
import { connectDevForwarder } from '../src/cli/dev-client.js'

function mkNode(id: string, group = false): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    taskName,
    config: group ? {} : { exec: { command: 'x' } },
    requested: false,
  } as unknown as TaskNode
}

describe('startDevHub', () => {
  it('boots, ingests forwarded NDJSON events, serves connection meta, and stops', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-dev-'))
    const received: WireEvent[] = []
    const hub = await startDevHub({ root, onEvent: (e) => received.push(e) })
    try {
      expect(hub.origin).toMatch(/^http:\/\//)
      expect(hub.sockPath).toBe(devSocketPath(root))

      // Connect like a `vx run` would and forward a run's events.
      const sock = await Bun.connect({
        unix: hub.sockPath,
        socket: { data() {}, open() {}, close() {}, error() {} },
      })
      const node = mkNode('a#build')
      const fwd = wireForwarder((event) => sock.write(`${JSON.stringify(event)}\n`))
      fwd({ kind: 'run:start', info: { total: 1 } })
      fwd({ kind: 'task:start', node })
      fwd({
        kind: 'task:complete',
        node,
        outcome: { node, status: 'success', exitCode: 0, durationMs: 9 } as TaskOutcome,
      })
      fwd({ kind: 'run:end' })
      await Bun.sleep(60)
      sock.end()

      expect(received.map((e) => e.kind)).toEqual([
        'run:start',
        'task:start',
        'task:complete',
        'run:end',
      ])
      const res = await fetch(`${hub.origin}/__connection.json`)
      expect(res.status).toBe(200)
    } finally {
      await hub.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reassembles events split across socket packets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-dev-split-'))
    const received: WireEvent[] = []
    const hub = await startDevHub({ root, onEvent: (e) => received.push(e) })
    try {
      const sock = await Bun.connect({
        unix: hub.sockPath,
        socket: { data() {}, open() {}, close() {}, error() {} },
      })
      // One line dribbled in three writes; a second line follows.
      sock.write('{"kind":"run')
      await Bun.sleep(10)
      sock.write(':start","info":{"total":2}}\n{"kind":')
      await Bun.sleep(10)
      sock.write('"run:end"}\n')
      await Bun.sleep(40)
      sock.end()
      expect(received.map((e) => e.kind)).toEqual(['run:start', 'run:end'])
    } finally {
      await hub.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('connectDevForwarder', () => {
  it('returns null when no hub is running (the silent fallback)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-nohub-'))
    const fwd = await connectDevForwarder(root)
    expect(fwd).toBeNull()
    await rm(root, { recursive: true, force: true })
  })
})

describe('claiming the workspace socket', () => {
  // Before this, `startDevHub` bound the path unconditionally — so a second
  // `vx dev` in the same workspace SILENTLY stole every forwarded run.
  // Measured on raw listeners: after the second bind a client's write lands
  // entirely on the second hub (A=0, B=1) while the first keeps printing that
  // it is listening; and when the first hub then stops, its `stop()` unlinks
  // the socket the second now owns, after which every connect is refused and
  // BOTH hubs are dark with no error anywhere.
  //
  // There is nothing underneath to catch it: `Bun.listen({ unix })` replaces
  // an already-bound socket with no `unlink` and no EADDRINUSE (probed — the
  // no-unlink double bind still gives A=0, B=1), so these pins guard the only
  // check there is.

  it('refuses to take a socket a LIVE hub is listening on', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-dev-live-'))
    const first: WireEvent[] = []
    const hub = await startDevHub({ root, onEvent: (e) => first.push(e) })
    try {
      await expect(startDevHub({ root })).rejects.toThrow(/already listening/)
      // The refusal must name the path — it is the only thing that tells a dev
      // WHICH hub to stop when two terminals are open.
      await expect(startDevHub({ root })).rejects.toThrow(hub.sockPath)

      // Control: the refusal left the incumbent working. Without this, "no
      // second hub" would also be satisfied by having broken the first.
      const sock = await Bun.connect({
        unix: hub.sockPath,
        socket: { data() {}, open() {}, close() {}, error() {} },
      })
      sock.write(`${JSON.stringify({ kind: 'run:end' })}\n`)
      await Bun.sleep(60)
      sock.end()
      expect(first.map((e) => e.kind)).toEqual(['run:end'])
    } finally {
      await hub.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still reclaims a STALE socket left by a crashed hub', async () => {
    // The case the unconditional unlink existed for, and the control that stops
    // the fix degenerating into "never bind when a file is present".
    //
    // The stale socket is produced by SIGKILLing a subprocess that bound it —
    // the only portable way, because a killed process cannot unlink and so
    // leaves the file behind by construction. An in-process `listener.stop()`
    // is NOT a faithful stand-in: whether it leaves the file is
    // platform-dependent (it does here; on the CI runner it did not, and this
    // fixture's precondition failed in 0.79ms — which is the assertion below
    // doing its job rather than the claim being wrong).
    const root = await mkdtemp(path.join(tmpdir(), 'vx-dev-stale-'))
    const sockPath = devSocketPath(root)
    await mkdir(path.dirname(sockPath), { recursive: true })
    const doomed = Bun.spawn(
      [
        process.execPath,
        '-e',
        `Bun.listen({ unix: ${JSON.stringify(sockPath)}, socket: { data(){}, open(){}, close(){}, error(){} } });` +
          `setInterval(() => {}, 1000)`,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    const deadline = Date.now() + 15_000
    while (!existsSync(sockPath) && Date.now() < deadline) await Bun.sleep(20)
    doomed.kill('SIGKILL')
    await doomed.exited
    // The fixture is self-verifying: present on disk AND unreachable is
    // exactly the state `claimSocket` must reclaim rather than refuse.
    expect(existsSync(sockPath)).toBe(true)
    await expect(
      Bun.connect({ unix: sockPath, socket: { data() {}, open() {}, close() {}, error() {} } }),
    ).rejects.toThrow()

    const received: WireEvent[] = []
    const hub = await startDevHub({ root, onEvent: (e) => received.push(e) })
    try {
      const sock = await Bun.connect({
        unix: hub.sockPath,
        socket: { data() {}, open() {}, close() {}, error() {} },
      })
      sock.write(`${JSON.stringify({ kind: 'run:end' })}\n`)
      await Bun.sleep(60)
      sock.end()
      expect(received.map((e) => e.kind)).toEqual(['run:end'])
    } finally {
      await hub.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('--port is parsed strictly', () => {
  // The last surviving `Number()` knob in cloud. The 2026-07-30 sweep routed
  // four siblings through `parseDecimalInt` precisely because the bare
  // coercion refuses `abc` and then silently accepts hex and exponent forms —
  // a validator that teaches a reader it validates when it only half does.
  it.each([
    ['hex', '0x10'],
    ['exponent', '1e3'],
    ['surrounding whitespace', ' 8080 '],
    ['a leading +', '+80'],
    ['a fractional port', '80.5'],
    ['out of range', '65536'],
    ['a negative', '-1'],
    ['junk', 'abc'],
    ['empty', ''],
    ['absent', undefined],
  ])('rejects %s', (_label, v) => {
    expect(parsePort(v)).toEqual({ error: `invalid --port: ${String(v)}` })
  })

  it.each([
    ['a real port', '8080', 8080],
    // 0 asks the kernel for an ephemeral port — the hub has no stable-address
    // requirement, unlike `vx-cloud serve`, so this must stay valid.
    ['0 (kernel-assigned)', '0', 0],
    ['the top of the range', '65535', 65535],
  ])('accepts %s', (_label, v, expected) => {
    expect(parsePort(v)).toBe(expected)
  })
})
