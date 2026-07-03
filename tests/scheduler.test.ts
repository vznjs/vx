import { describe, expect, it } from 'bun:test'
import { computeReverseDepCount, runGraph, type TaskOutcome } from '../src/graph/scheduler.js'
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

describe('priority computation scale', () => {
  it('dense 100-layer graph schedules in linear-ish time, not closure time', async () => {
    // 100 layers x 30 nodes, every node depending on the whole
    // previous layer: 3000 nodes, ~87k edges, transitive closures
    // averaging ~half the graph. The Set-based closure walk this
    // guards against took tens of seconds here (8.5s of a 10s warm
    // run on the 1090-package report repo); the bitset reverse-topo
    // version is single-digit milliseconds.
    const LAYERS = 100
    const WIDTH = 30
    const all: TaskNode[] = []
    const layers: string[][] = []
    for (let l = 0; l < LAYERS; l++) {
      const cur: string[] = []
      // Mirror dependsOn's transitive ^task expansion: edges reach
      // SEVERAL layers down, not just the adjacent one.
      const deps = layers.slice(Math.max(0, l - 5), l).flat()
      for (let w = 0; w < WIDTH; w++) {
        const id = `l${l}-${w}#build`
        all.push(node(id, deps))
        cur.push(id)
      }
      layers.push(cur)
    }
    // Functional pin: the dense graph still schedules correctly.
    const outcomes = await runGraph({
      nodes: nodes(...all),
      concurrency: 8,
      execute: async (n) => success(n),
    })
    expect(outcomes.size).toBe(LAYERS * WIDTH)
    expect([...outcomes.values()].every((o) => o.status === 'success')).toBe(true)

    // Perf pin: time ONLY the priority closure (min of 3 — pure CPU,
    // so min de-noises scheduler-unrelated machine load). Calibration:
    // bitset implementation ~20-60 ms here; the quadratic Set-DFS it
    // replaced took ~7 s for this same call. CI slowness moves pure
    // CPU by single-digit factors, not 20x, so 1500 ms separates
    // cleanly without end-to-end promise noise (which caused the old
    // wall-clock bound to flake at 1627 ms vs 1500 ms).
    const graph = nodes(...all)
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      computeReverseDepCount(graph)
      best = Math.min(best, performance.now() - t0)
    }
    expect(best).toBeLessThan(1500)
  }, 120_000)
})

describe('runGraph restore-tier (local short-circuit)', () => {
  const hit = (n: TaskNode): TaskOutcome => ({
    node: n,
    status: 'cache-hit',
    exitCode: 0,
    durationMs: 0,
    hash: `h-${n.id}`,
  })

  it('runs a restore-tier task BEFORE its (unfinished) deps', async () => {
    // up#prep is a slow exec; down#build is its dep but a confirmed
    // local hit (restore-tier). The restore must start without waiting
    // for up#prep to finish — its dep edge is ordering-only.
    const order: string[] = []
    const out = await runGraph({
      nodes: nodes(node('up#prep'), node('down#build', ['up#prep'])),
      concurrency: 4,
      restoreTier: new Set(['down#build']),
      execute: async (n) => {
        order.push(`start-${n.id}`)
        if (n.id === 'up#prep') await new Promise((r) => setTimeout(r, 30))
        order.push(`end-${n.id}`)
        return n.id === 'down#build' ? hit(n) : success(n)
      },
    })
    expect(out.get('down#build')?.status).toBe('cache-hit')
    // The restore started before the slow dep finished — the win.
    expect(order.indexOf('start-down#build')).toBeLessThan(order.indexOf('end-up#prep'))
  })

  it('exec-tier (misses) own the pool; restores backfill only idle slots', async () => {
    // 2 workers. Two exec misses + two restore hits, all independent.
    // With exec drained first, both misses start before any restore
    // when the pool is saturated.
    const starts: string[] = []
    const execIds = new Set(['e1#run', 'e2#run'])
    await runGraph({
      nodes: nodes(node('e1#run'), node('e2#run'), node('r1#run'), node('r2#run')),
      concurrency: 2,
      restoreTier: new Set(['r1#run', 'r2#run']),
      execute: async (n) => {
        starts.push(n.id)
        await new Promise((r) => setTimeout(r, 10))
        return execIds.has(n.id) ? success(n) : hit(n)
      },
    })
    // Both misses were picked before either restore (exec-tier first).
    expect(starts.indexOf('e1#run')).toBeLessThan(starts.indexOf('r1#run'))
    expect(starts.indexOf('e2#run')).toBeLessThan(starts.indexOf('r1#run'))
  })

  it('restore-tier task reports cache-hit even when a dep FAILED', async () => {
    // up#prep fails; down#build depends on it but is restore-tier.
    // It must NOT be skipped — its key is dep-success-independent.
    for (let i = 0; i < 5; i++) {
      const out = await runGraph({
        nodes: nodes(node('up#prep'), node('down#build', ['up#prep'])),
        concurrency: 4,
        restoreTier: new Set(['down#build']),
        execute: async (n) => (n.id === 'up#prep' ? failed(n) : hit(n)),
      })
      expect(out.get('up#prep')?.status).toBe('failed')
      // Deterministic across runs: restore-tier bypasses failedDep.
      expect(out.get('down#build')?.status).toBe('cache-hit')
    }
  })

  it('an EXEC-tier dependent of a failed dep is still skipped', async () => {
    // Sanity: the failedDep→skipped path is intact for non-restore deps.
    const out = await runGraph({
      nodes: nodes(node('up#prep'), node('down#build', ['up#prep'])),
      concurrency: 4,
      restoreTier: new Set(), // down#build is exec-tier
      execute: async (n) => (n.id === 'up#prep' ? failed(n) : success(n)),
    })
    expect(out.get('down#build')?.status).toBe('skipped')
  })
})

describe('runGraph — continueMode', () => {
  it('deps-ok (default): a failure skips dependents, siblings run — unchanged pin', async () => {
    const a = node('p#a')
    const b = node('p#b', ['p#a'])
    const c = node('p#c')
    const out = await runGraph({
      nodes: nodes(a, b, c),
      concurrency: 1,
      execute: async (n) => (n.id === 'p#a' ? failed(n) : success(n)),
    })
    expect(out.get('p#a')!.status).toBe('failed')
    expect(out.get('p#b')!.status).toBe('skipped')
    expect(out.get('p#c')!.status).toBe('success')
  })

  it('never: the first failure stops dispatch — queued tasks skip, in-flight finishes', async () => {
    // concurrency 1 forces strict ordering: a (fails) → everything else
    // dequeues after the trip and must skip, including the dep-free c.
    const a = node('p#a')
    const b = node('p#b', ['p#a'])
    const c = node('p#c')
    const started: string[] = []
    const out = await runGraph({
      nodes: nodes(a, b, c),
      concurrency: 1,
      continueMode: 'never',
      onStart: (n) => started.push(n.id),
      execute: async (n) => (n.id === 'p#a' ? failed(n) : success(n)),
    })
    expect(out.get('p#a')!.status).toBe('failed')
    expect(out.get('p#b')!.status).toBe('skipped')
    expect(out.get('p#c')!.status).toBe('skipped')
    expect(started).toEqual(['p#a'])
  })

  it('always: dependents run even when an upstream failed', async () => {
    const a = node('p#a')
    const b = node('p#b', ['p#a'])
    const seenUpstream: TaskOutcome[][] = []
    const out = await runGraph({
      nodes: nodes(a, b),
      concurrency: 2,
      continueMode: 'always',
      execute: async (n, upstream) => {
        if (n.id === 'p#b') seenUpstream.push(upstream)
        return n.id === 'p#a' ? failed(n) : success(n)
      },
    })
    expect(out.get('p#a')!.status).toBe('failed')
    // b executed (not skipped) and saw the failed upstream outcome —
    // its key folds the upstream's INPUT hash, which failed outcomes
    // carry (computed before exec), so caching stays sound.
    expect(out.get('p#b')!.status).toBe('success')
    expect(seenUpstream[0]![0]!.status).toBe('failed')
    expect(seenUpstream[0]![0]!.hash).toBe('h-p#a')
  })
})
