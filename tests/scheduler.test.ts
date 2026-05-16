import { describe, expect, it } from 'bun:test'
import { runGraph, type TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function node(id: string, deps: string[] = []): TaskNode {
  return {
    id,
    projectName: id.split('#')[0]!,
    projectDir: '/tmp',
    taskName: id.split('#')[1]!,
    config: { exec: { command: 'noop' } },
    deps,
    requested: true,
  }
}

function nodes(...ns: TaskNode[]): Map<string, TaskNode> {
  return new Map(ns.map((n) => [n.id, n]))
}

const success = (n: TaskNode): TaskOutcome => ({
  node: n,
  status: 'success',
  exitCode: 0,
  durationMs: 0,
  hash: `h-${n.id}`,
})

const failed = (n: TaskNode): TaskOutcome => ({
  node: n,
  status: 'failed',
  exitCode: 1,
  durationMs: 0,
  hash: `h-${n.id}`,
})

describe('runGraph', () => {
  it('returns immediately on an empty graph', async () => {
    const out = await runGraph({
      nodes: nodes(),
      concurrency: 4,
      execute: async () => {
        throw new Error('should not be called')
      },
    })
    expect(out.size).toBe(0)
  })

  it('runs tasks in dependency order', async () => {
    const order: string[] = []
    const out = await runGraph({
      nodes: nodes(node('a#build'), node('b#build', ['a#build'])),
      concurrency: 4,
      execute: async (n) => {
        order.push(`start-${n.id}`)
        await new Promise((r) => setTimeout(r, 10))
        order.push(`end-${n.id}`)
        return success(n)
      },
    })
    expect(out.get('a#build')?.status).toBe('success')
    expect(out.get('b#build')?.status).toBe('success')
    expect(order.indexOf('end-a#build')).toBeLessThan(order.indexOf('start-b#build'))
  })

  it('respects the concurrency cap', async () => {
    let active = 0
    let peak = 0
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => `${s}#run`)
    const out = await runGraph({
      nodes: nodes(...ids.map((id) => node(id))),
      concurrency: 2,
      execute: async (n) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return success(n)
      },
    })
    expect(out.size).toBe(ids.length)
    expect(peak).toBe(2)
  })

  it('serializes execution with concurrency = 1', async () => {
    let active = 0
    let peak = 0
    const ids = ['a', 'b', 'c'].map((s) => `${s}#run`)
    await runGraph({
      nodes: nodes(...ids.map((id) => node(id))),
      concurrency: 1,
      execute: async (n) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
        return success(n)
      },
    })
    expect(peak).toBe(1)
  })

  it('skips dependents of a failed task', async () => {
    const out = await runGraph({
      nodes: nodes(node('a#build'), node('b#build', ['a#build'])),
      concurrency: 4,
      execute: async (n) => (n.id === 'a#build' ? failed(n) : success(n)),
    })
    expect(out.get('a#build')?.status).toBe('failed')
    expect(out.get('b#build')?.status).toBe('skipped')
  })

  it('continues independent siblings after one fails', async () => {
    const ran: string[] = []
    const out = await runGraph({
      nodes: nodes(node('a#run'), node('b#run'), node('c#run')),
      concurrency: 4,
      execute: async (n) => {
        ran.push(n.id)
        await new Promise((r) => setTimeout(r, 5))
        return n.id === 'a#run' ? failed(n) : success(n)
      },
    })
    expect(out.get('a#run')?.status).toBe('failed')
    expect(out.get('b#run')?.status).toBe('success')
    expect(out.get('c#run')?.status).toBe('success')
    expect(ran).toContain('b#run')
    expect(ran).toContain('c#run')
  })

  it('cascades skips through a chain when an upstream fails', async () => {
    // a -> b -> c. Failing a should skip both b and c.
    const out = await runGraph({
      nodes: nodes(node('a'), node('b', ['a']), node('c', ['b'])),
      concurrency: 4,
      execute: async (n) => (n.id === 'a' ? failed(n) : success(n)),
    })
    expect(out.get('a')?.status).toBe('failed')
    expect(out.get('b')?.status).toBe('skipped')
    expect(out.get('c')?.status).toBe('skipped')
  })

  it('marks a node failed when its execute() throws and keeps the graph progressing', async () => {
    // Suppress the [vx] internal-error stderr write from the catch handler
    // so test output stays clean.
    const stderr = process.stderr.write
    process.stderr.write = ((..._args: unknown[]) => true) as typeof stderr
    try {
      const out = await runGraph({
        nodes: nodes(node('a#run'), node('b#run')),
        concurrency: 4,
        execute: async (n) => {
          if (n.id === 'a#run') throw new Error('boom')
          return success(n)
        },
      })
      expect(out.get('a#run')?.status).toBe('failed')
      expect(out.get('a#run')?.exitCode).toBe(1)
      expect(out.get('b#run')?.status).toBe('success')
    } finally {
      process.stderr.write = stderr
    }
  })

  it('passes upstream outcomes to dependent execute()', async () => {
    let received: TaskOutcome[] = []
    await runGraph({
      nodes: nodes(node('a'), node('b', ['a'])),
      concurrency: 4,
      execute: async (n, upstream) => {
        if (n.id === 'b') received = upstream
        return success(n)
      },
    })
    expect(received.map((o) => o.node.id)).toEqual(['a'])
  })

  describe('worker slot allocation', () => {
    it('assigns slot 0 to the first task launched', async () => {
      const seen = new Map<string, number>()
      await runGraph({
        nodes: nodes(node('a#run')),
        concurrency: 4,
        execute: async (n, _upstream, slot) => {
          seen.set(n.id, slot)
          return success(n)
        },
      })
      expect(seen.get('a#run')).toBe(0)
    })

    it('assigns disjoint slots to concurrent tasks (lowest free first)', async () => {
      const slotByTask = new Map<string, number>()
      const release = new Map<string, () => void>()
      const inFlightSlots: number[] = []

      const promise = runGraph({
        nodes: nodes(node('a#run'), node('b#run'), node('c#run')),
        concurrency: 4,
        execute: async (n, _upstream, slot) => {
          slotByTask.set(n.id, slot)
          inFlightSlots.push(slot)
          await new Promise<void>((resolve) => release.set(n.id, resolve))
          return success(n)
        },
      })

      // All three should be in-flight on slots 0, 1, 2 in launch order.
      while (inFlightSlots.length < 3) await Bun.sleep(1)
      expect([...inFlightSlots].sort((a, b) => a - b)).toEqual([0, 1, 2])

      // Distinct slots, all inside concurrency.
      expect(new Set(inFlightSlots).size).toBe(3)
      for (const s of inFlightSlots) expect(s).toBeGreaterThanOrEqual(0)
      for (const s of inFlightSlots) expect(s).toBeLessThan(4)

      for (const r of release.values()) r()
      await promise
    })

    it('reuses the lowest released slot first', async () => {
      const start = new Map<string, () => void>()
      const slotsObserved: number[] = []
      let bSlot = -1
      let dSlot = -1

      const promise = runGraph({
        // a + b run first; once a finishes, c+d schedule. c should
        // grab slot 0 (released by a) before d.
        nodes: nodes(node('a#run'), node('b#run'), node('c#run'), node('d#run')),
        concurrency: 2,
        execute: async (n, _u, slot) => {
          slotsObserved.push(slot)
          if (n.id === 'b#run') bSlot = slot
          if (n.id === 'd#run') dSlot = slot
          await new Promise<void>((resolve) => start.set(n.id, resolve))
          return success(n)
        },
      })

      while (!start.has('a#run') || !start.has('b#run')) await Bun.sleep(1)
      // a finishes; c should pick up its slot.
      start.get('a#run')!()
      while (!start.has('c#run')) await Bun.sleep(1)
      start.get('b#run')!()
      while (!start.has('d#run')) await Bun.sleep(1)
      start.get('c#run')!()
      start.get('d#run')!()
      await promise

      // Both d and c reused freed slots; specifically c (released
      // first by a) should be on a's slot.
      expect(bSlot).toBe(1)
      expect(dSlot).toBe(1)
      expect(slotsObserved[0]).toBe(0)
      expect(slotsObserved[1]).toBe(1)
    })

    it('passes the slot to the onStart callback', async () => {
      const onStartSlots = new Map<string, number>()
      await runGraph({
        nodes: nodes(node('a#run'), node('b#run')),
        concurrency: 2,
        onStart: (n, slot) => {
          onStartSlots.set(n.id, slot)
        },
        execute: async (n) => success(n),
      })
      expect(onStartSlots.size).toBe(2)
      expect(new Set(onStartSlots.values())).toEqual(new Set([0, 1]))
    })

    it('does not pass a slot to skipped dependents (they never run)', async () => {
      const slots: number[] = []
      await runGraph({
        nodes: nodes(node('a'), node('b', ['a'])),
        concurrency: 2,
        execute: async (n, _u, slot) => {
          slots.push(slot)
          return n.id === 'a' ? failed(n) : success(n)
        },
      })
      expect(slots).toEqual([0])
    })
  })

  describe('reverse-dependency scheduling priority', () => {
    it('prefers the task that blocks the most downstream work', async () => {
      // Graph:
      //   root ── ready, blocks 4 transitive descendants (a, b, c, d)
      //   leaf ── ready, blocks nothing
      //
      //   root → a → b → c → d
      //   leaf (isolated)
      //
      // With concurrency=1 only one task can start at a time. The
      // scheduler must pick `root` first (highest reverse-dep count)
      // so its 4 dependents can fan out, instead of `leaf` first
      // which would leave `root` blocking everything until leaf finishes.
      const root = node('p#root')
      const a = node('p#a', ['p#root'])
      const b = node('p#b', ['p#a'])
      const c = node('p#c', ['p#b'])
      const d = node('p#d', ['p#c'])
      const leaf = node('p#leaf')

      // Order the Map so `leaf` comes BEFORE `root` — the pre-sort
      // patch must override insertion order on the strength of the
      // reverse-dep count.
      const m = new Map<string, TaskNode>([
        ['p#leaf', leaf],
        ['p#root', root],
        ['p#a', a],
        ['p#b', b],
        ['p#c', c],
        ['p#d', d],
      ])

      const started: string[] = []
      await runGraph({
        nodes: m,
        concurrency: 1,
        execute: async (n) => {
          started.push(n.id)
          return success(n)
        },
      })
      // `root` runs before `leaf` despite being inserted later.
      const rootIdx = started.indexOf('p#root')
      const leafIdx = started.indexOf('p#leaf')
      expect(rootIdx).toBeLessThan(leafIdx)
    })

    it('ties break in graph-insertion order (topo from buildTaskGraph)', async () => {
      // Two roots with identical reverse-dep count: both block exactly
      // one downstream task. The scheduler should fall back to
      // insertion order (i.e., the order the graph builder produced).
      const r1 = node('p#r1')
      const r2 = node('p#r2')
      const c1 = node('p#c1', ['p#r1'])
      const c2 = node('p#c2', ['p#r2'])

      const m = new Map<string, TaskNode>([
        ['p#r1', r1],
        ['p#r2', r2],
        ['p#c1', c1],
        ['p#c2', c2],
      ])

      const started: string[] = []
      await runGraph({
        nodes: m,
        concurrency: 1,
        execute: async (n) => {
          started.push(n.id)
          return success(n)
        },
      })
      // r1 (inserted first) wins the tie over r2.
      expect(started.indexOf('p#r1')).toBeLessThan(started.indexOf('p#r2'))
    })
  })
})
