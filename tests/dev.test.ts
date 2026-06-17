import { describe, it, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startDevHub, devSocketPath } from '../src/cli/dev.js'
import { connectDevForwarder } from '../src/cli/dev-client.js'
import { wireForwarder, type WireEvent } from '../src/orchestrator/index.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'

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

describe('wireForwarder', () => {
  it('drops group-task start/complete and projects the rest', () => {
    const events: WireEvent[] = []
    const fwd = wireForwarder((e) => events.push(e))
    const group = mkNode('a#ci', true)
    const real = mkNode('a#build')
    fwd({ kind: 'task:start', node: group })
    fwd({
      kind: 'task:complete',
      node: group,
      outcome: { node: group, status: 'success', exitCode: 0, durationMs: 0 } as TaskOutcome,
    })
    fwd({ kind: 'task:start', node: real })
    fwd({ kind: 'run:end' })
    expect(events.map((e) => e.kind)).toEqual(['task:start', 'run:end'])
  })

  it('forwards a single run:end despite the double emit + trailing status', () => {
    const events: WireEvent[] = []
    const fwd = wireForwarder((e) => events.push(e))
    fwd({ kind: 'run:end' })
    fwd({ kind: 'run:status', line: 'summary' })
    fwd({ kind: 'run:end' })
    expect(events.map((e) => e.kind)).toEqual(['run:end'])
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
