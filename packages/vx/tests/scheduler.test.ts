import { describe, expect, it, spyOn } from 'bun:test'
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

const aborted = (n: TaskNode): TaskOutcome => ({
  node: n,
  status: 'aborted',
  exitCode: 143,
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

  it('skips dependents of an aborted task', async () => {
    // An aborted child was killed mid-write, so its declared outputs are
    // partial. A dependent that ran anyway would cache what it built from
    // them under the key a healthy run derives — a stale hit next run.
    const out = await runGraph({
      nodes: nodes(node('a#build'), node('b#build', ['a#build'])),
      concurrency: 4,
      execute: async (n) => (n.id === 'a#build' ? aborted(n) : success(n)),
    })
    expect(out.get('a#build')?.status).toBe('aborted')
    expect(out.get('b#build')?.status).toBe('skipped')
  })

  it('an aborted task does not skip independent siblings', async () => {
    const out = await runGraph({
      nodes: nodes(node('a#run'), node('b#run')),
      concurrency: 4,
      execute: async (n) => (n.id === 'a#run' ? aborted(n) : success(n)),
    })
    expect(out.get('a#run')?.status).toBe('aborted')
    expect(out.get('b#run')?.status).toBe('success')
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

  // A caller-supplied priority map (the seam a scheduling plugin feeds) must
  // drive the schedule order, not just the structural reverse-dep count.
  describe('caller-supplied priorities drive order', () => {
    it('runs the head of the HIGHER-priority chain first, breaking a reverse-dep tie', async () => {
      // Two independent chains, IDENTICAL structure (each head blocks exactly
      // one task → same reverse-dep count → a structural tie). By PRIORITY,
      // chain A is the critical path and chain B is trivial.
      const a1 = node('p#a1')
      const a2 = node('p#a2', ['p#a1'])
      const b1 = node('p#b1')
      const b2 = node('p#b2', ['p#b1'])
      // Insert chain B FIRST, so insertion order (the structural tie-break)
      // would otherwise pick b1 before a1.
      const m = new Map<string, TaskNode>([
        ['p#b1', b1],
        ['p#b2', b2],
        ['p#a1', a1],
        ['p#a2', a2],
      ])
      const priorities = new Map([
        ['p#a1', 2000],
        ['p#a2', 1000],
        ['p#b1', 20],
        ['p#b2', 10],
      ])

      const started: string[] = []
      await runGraph({
        nodes: m,
        concurrency: 1,
        priorities,
        execute: async (n) => {
          started.push(n.id)
          return success(n)
        },
      })
      // a1 runs before b1 despite being inserted later and having the same
      // reverse-dep count — the supplied priority won.
      expect(started.indexOf('p#a1')).toBeLessThan(started.indexOf('p#b1'))
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

    // Perf pin: time ONLY the priority closure. What is measured is a FLOOR —
    // noise can only ADD time, so the fastest sample is the estimate, and a
    // quadratic implementation cannot produce a fast sample however lucky the
    // machine gets. That is what makes the bound meaningful rather than a
    // wall-clock guess.
    //
    // It samples until one lands under the bound, capped. Min-of-3 was not
    // enough: measured here, five identical calls in one process ran 862, 1655,
    // 869, 186, 1681 ms — a 9x spread from GC alone, so three samples can
    // plausibly miss the fast one, and this guard redded at 1577 ms during a
    // full-suite run with `src/` untouched. Stopping early keeps the healthy
    // case at one or two iterations and only pays the full cost when something
    // actually looks slow.
    //
    // Calibration, measured on THIS machine rather than carried over: floor
    // ~186 ms for the bitset reverse-topo version; the quadratic Set-DFS it
    // replaced took ~7 s for this same call. 1500 ms sits between them with
    // room on both sides, and is deliberately unchanged — the fix here is the
    // robustness of the floor ESTIMATE, not a looser bound.
    const graph = nodes(...all)
    let best = Infinity
    for (let i = 0; i < 8 && best >= 1500; i++) {
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

  it('restores run on their own lane: up to 2× the cap, while exec-tier stays capped', async () => {
    // 2 workers. Six exec misses and six restore hits, all independent and
    // all slow: the misses may never exceed 2 in flight, the restores may
    // reach 4, and the two lanes overlap (a restore starts while both
    // exec slots are busy — the win).
    let activeExec = 0
    let activeRestore = 0
    let peakExec = 0
    let peakRestore = 0
    let overlapped = false
    const execIds = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map((s) => `${s}#run`)
    const restoreIds = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((s) => `${s}#run`)
    await runGraph({
      nodes: nodes(...[...execIds, ...restoreIds].map((id) => node(id))),
      concurrency: 2,
      restoreTier: new Set(restoreIds),
      execute: async (n) => {
        const isExec = execIds.includes(n.id)
        if (isExec) peakExec = Math.max(peakExec, ++activeExec)
        else peakRestore = Math.max(peakRestore, ++activeRestore)
        if (activeExec === 2 && activeRestore > 0) overlapped = true
        await new Promise((r) => setTimeout(r, 15))
        if (isExec) activeExec--
        else activeRestore--
        return isExec ? success(n) : hit(n)
      },
    })
    expect(peakExec).toBe(2)
    expect(peakRestore).toBe(4)
    expect(overlapped).toBe(true)
  })

  it('--concurrency 1 serializes restores too', async () => {
    let active = 0
    let peak = 0
    const ids = ['r1', 'r2', 'r3'].map((s) => `${s}#run`)
    await runGraph({
      nodes: nodes(...ids.map((id) => node(id))),
      concurrency: 1,
      restoreTier: new Set(ids),
      execute: async (n) => {
        peak = Math.max(peak, ++active)
        await new Promise((r) => setTimeout(r, 10))
        active--
        return hit(n)
      },
    })
    expect(peak).toBe(1)
  })

  it('a dependent waits for what its upstream still owes, while the freed slot admits other work', async () => {
    // One slot. `up` resolves at once but owes a settle (a save landing,
    // 30 ms later); `other` is independent; `down` depends on `up`. The
    // slot must go to `other` right away, and `down` must start only
    // after the settle.
    const order: string[] = []
    let settleAt = 0
    const settles = new Map<string, Promise<void>>()
    const out = await runGraph({
      nodes: nodes(node('up#run'), node('other#run'), node('down#run', ['up#run'])),
      concurrency: 1,
      settledOf: (o) => settles.get(o.node.id),
      execute: async (n) => {
        order.push(n.id)
        if (n.id === 'up#run') {
          settles.set(
            n.id,
            new Promise((r) =>
              setTimeout(() => {
                settleAt = performance.now()
                r()
              }, 30),
            ),
          )
        }
        if (n.id === 'down#run') expect(performance.now()).toBeGreaterThanOrEqual(settleAt)
        return success(n)
      },
    })
    expect(out.size).toBe(3)
    expect(order).toEqual(['up#run', 'other#run', 'down#run'])
    expect(settleAt).toBeGreaterThan(0)
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

describe('runGraph — priorities override', () => {
  it('a priorities map overrides the default order; unscored nodes fall back to baseline', async () => {
    // Four independent nodes: the default schedule is pure insertion
    // order a, b, c, d (all baseline reverse-dep counts are 0). A
    // priorities map lifts c above a; b and d are unscored and fall back
    // to baseline (0), keeping their insertion order behind the scored pair.
    const m = new Map<string, TaskNode>([
      ['p#a', node('p#a')],
      ['p#b', node('p#b')],
      ['p#c', node('p#c')],
      ['p#d', node('p#d')],
    ])
    const started: string[] = []
    await runGraph({
      nodes: m,
      concurrency: 1,
      priorities: new Map([
        ['p#c', 5],
        ['p#a', 1],
      ]),
      execute: async (n) => {
        started.push(n.id)
        return success(n)
      },
    })
    // Scored highest-first: c (5) then a (1); then the two unscored nodes
    // by baseline + insertion order: b then d. Inverts the default a,b,c,d.
    expect(started).toEqual(['p#c', 'p#a', 'p#b', 'p#d'])
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

  it('always: an aborted upstream still lets dependents run — documented, unchanged', async () => {
    // `always` opts out of dep-status propagation entirely, aborted
    // included. Same provenance argument as the failed case above.
    const a = node('p#a')
    const b = node('p#b', ['p#a'])
    const out = await runGraph({
      nodes: nodes(a, b),
      concurrency: 2,
      continueMode: 'always',
      execute: async (n) => (n.id === 'p#a' ? aborted(n) : success(n)),
    })
    expect(out.get('p#a')!.status).toBe('aborted')
    expect(out.get('p#b')!.status).toBe('success')
  })
})

describe('runGraph — an admission policy over the count limit (`admit`)', () => {
  // Manual completion gates: execute() records the start and blocks on
  // the task's gate, so tests control exactly when a slot frees.
  function gates(ids: string[]) {
    const release = new Map<string, () => void>()
    const held = new Map<string, Promise<void>>()
    for (const id of ids) {
      held.set(
        id,
        new Promise<void>((r) => {
          release.set(id, r)
        }),
      )
    }
    return { held, release }
  }
  // A packing policy in the shape a plugin writes: each task costs `cost`
  // units of a `budget`; a task that fits beside what runs is admitted, a
  // task over the whole budget runs alone (from idle, so it never starves).
  const packing = (costs: Record<string, number>, budget: number) => {
    const cost = (id: string): number => costs[id] ?? 0
    return (id: string, running: ReadonlySet<string>): boolean => {
      const c = cost(id)
      if (c === 0) return true
      let reserved = 0
      for (const r of running) reserved += cost(r)
      return c <= budget ? reserved + c <= budget : running.size === 0
    }
  }
  const peakOf = async (opts: {
    ids: string[]
    concurrency: number
    admit: (id: string, running: ReadonlySet<string>) => boolean
  }): Promise<number> => {
    let active = 0
    let peak = 0
    const out = await runGraph({
      nodes: nodes(...opts.ids.map((id) => node(id))),
      concurrency: opts.concurrency,
      admit: opts.admit,
      execute: async (n) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return success(n)
      },
    })
    expect(out.size).toBe(opts.ids.length)
    return peak
  }

  it('two tasks the policy fits together run concurrently', async () => {
    const peak = await peakOf({
      ids: ['a#run', 'b#run'],
      concurrency: 8,
      admit: packing({ 'a#run': 4, 'b#run': 4 }, 8),
    })
    expect(peak).toBe(2)
  })

  it('two tasks the policy cannot fit together serialize', async () => {
    const peak = await peakOf({
      ids: ['a#run', 'b#run'],
      concurrency: 8,
      admit: packing({ 'a#run': 5, 'b#run': 5 }, 8),
    })
    expect(peak).toBe(1)
  })

  it('the policy sees a task dispatched earlier in the SAME tick', async () => {
    // Two ready tasks, one tick: the second ask must list the first as
    // running, or two tasks that must not share a machine would start
    // together. Recorded per ask, asserted by content.
    const seen: string[][] = []
    await peakOf({
      ids: ['a#run', 'b#run'],
      concurrency: 8,
      admit: (_id, running) => {
        seen.push([...running].sort())
        return true
      },
    })
    expect(seen[0]).toEqual([])
    expect(seen[1]).toEqual(['a#run'])
  })

  it('backfill: a refused head lets a smaller lower-priority task through', async () => {
    const { held, release } = gates(['p#a', 'p#b', 'p#c'])
    const started: string[] = []
    const done = runGraph({
      nodes: nodes(node('p#a'), node('p#b'), node('p#c')),
      concurrency: 8,
      priorities: new Map([
        ['p#a', 100],
        ['p#b', 50],
        ['p#c', 10],
      ]),
      // a takes the whole budget; b and c each half.
      admit: packing({ 'p#a': 8, 'p#b': 4, 'p#c': 4 }, 8),
      onStart: (n) => started.push(n.id),
      execute: async (n) => {
        await held.get(n.id)
        return success(n)
      },
    })
    await Bun.sleep(0)
    // a fills the budget; b and c park.
    expect(started).toEqual(['p#a'])
    release.get('p#a')!()
    await Bun.sleep(0)
    expect(started).toEqual(['p#a', 'p#b', 'p#c'])
    release.get('p#b')!()
    release.get('p#c')!()
    await done
  })

  it('solo: a task over the whole budget runs alone from idle; an all-over graph serializes', async () => {
    const peak = await peakOf({
      ids: ['a#run', 'b#run', 'c#run'],
      concurrency: 8,
      admit: packing({ 'a#run': 16, 'b#run': 16, 'c#run': 16 }, 8),
    })
    expect(peak).toBe(1)
  })

  it('a task the policy never charges runs beside a solo giant while a charged one waits', async () => {
    const { held, release } = gates(['p#big', 'p#small', 'p#free'])
    const started: string[] = []
    const done = runGraph({
      nodes: nodes(node('p#big'), node('p#small'), node('p#free')),
      concurrency: 8,
      priorities: new Map([
        ['p#big', 100],
        ['p#small', 50],
        ['p#free', 10],
      ]),
      // free has no cost: the policy admits it whatever runs.
      admit: packing({ 'p#big': 16, 'p#small': 1 }, 8),
      onStart: (n) => started.push(n.id),
      execute: async (n) => {
        await held.get(n.id)
        return success(n)
      },
    })
    await Bun.sleep(0)
    expect(started).toEqual(['p#big', 'p#free'])
    release.get('p#big')!()
    await Bun.sleep(0)
    expect(started).toEqual(['p#big', 'p#free', 'p#small'])
    release.get('p#small')!()
    release.get('p#free')!()
    await done
  })

  it('skip-safety: a refused task with a failed dep skips instead of parking', async () => {
    const { held, release } = gates(['p#long'])
    let bigSkippedWhileLongActive = false
    const done = runGraph({
      nodes: nodes(node('p#dep'), node('p#long'), node('p#big', ['p#dep'])),
      concurrency: 8,
      admit: packing({ 'p#long': 4, 'p#big': 16 }, 8),
      onFinish: (o) => {
        // The doomed giant must resolve as skipped WHILE long still runs —
        // if the parker asked the policy about would-skip tasks, it would
        // park here (16 > 8, long running) instead of finishing.
        if (o.node.id === 'p#big' && o.status === 'skipped') bigSkippedWhileLongActive = true
      },
      execute: async (n) => {
        if (n.id === 'p#dep') return failed(n)
        await held.get(n.id)
        return success(n)
      },
    })
    await Bun.sleep(0)
    expect(bigSkippedWhileLongActive).toBe(true)
    release.get('p#long')!()
    const out = await done
    expect(out.get('p#big')!.status).toBe('skipped')
    expect(out.get('p#long')!.status).toBe('success')
  })

  it('a restore-tier task is never asked and never listed as running', async () => {
    // A restore is a tar extract, not the task's real work: it holds no
    // local resources. The policy would refuse `b` if asked (its cost is
    // the whole budget) and would refuse `a` if `b` were listed.
    const asked: string[] = []
    const peak = await (async () => {
      let active = 0
      let peak = 0
      await runGraph({
        nodes: nodes(node('a#run'), node('b#run')),
        concurrency: 8,
        restoreTier: new Set(['b#run']),
        admit: (id, running) => {
          asked.push(id)
          return running.size === 0
        },
        execute: async (n) => {
          active++
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 20))
          active--
          return success(n)
        },
      })
      return peak
    })()
    expect(peak).toBe(2)
    expect(asked).toEqual(['a#run'])
  })

  it('FIFO-among-equals survives park + repush (original seq preserved)', async () => {
    const { held, release } = gates(['p#a', 'p#b', 'p#c', 'p#d'])
    const started: string[] = []
    // All equal priority (independent roots, default baseline 0), so the
    // contract is enqueue order: a, b, c, d. b/c/d park behind a's 6;
    // after a completes, b and c admit IN ORDER and d parks again.
    const done = runGraph({
      nodes: nodes(node('p#a'), node('p#b'), node('p#c'), node('p#d')),
      concurrency: 8,
      admit: packing({ 'p#a': 6, 'p#b': 4, 'p#c': 4, 'p#d': 4 }, 8),
      onStart: (n) => started.push(n.id),
      execute: async (n) => {
        await held.get(n.id)
        return success(n)
      },
    })
    await Bun.sleep(0)
    expect(started).toEqual(['p#a'])
    release.get('p#a')!()
    await Bun.sleep(0)
    expect(started).toEqual(['p#a', 'p#b', 'p#c'])
    release.get('p#b')!()
    await Bun.sleep(0)
    expect(started).toEqual(['p#a', 'p#b', 'p#c', 'p#d'])
    release.get('p#c')!()
    release.get('p#d')!()
    await done
  })

  it('no policy takes the legacy path (count limit only)', async () => {
    let active = 0
    let peak = 0
    await runGraph({
      nodes: nodes(node('a#run'), node('b#run'), node('c#run')),
      concurrency: 2,
      execute: async (n) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
        return success(n)
      },
    })
    expect(peak).toBe(2)
  })

  it('a throwing onFinish does not unlist twice into a wedged policy', async () => {
    // `.then(onFulfilled, onRejected)` — a throw from the fulfillment arm
    // (onFinish) must NOT also run the rejection arm, or the slot releases
    // twice. The first task's onFinish throws; the later task that needs an
    // idle machine must still run.
    let threw = false
    const ran = new Set<string>()
    const out = await runGraph({
      nodes: nodes(node('a#run'), node('big#run', ['a#run'])),
      concurrency: 4,
      admit: (id, running) => id !== 'big#run' || running.size === 0,
      onFinish: (o) => {
        if (o.node.id === 'a#run' && !threw) {
          threw = true
          throw new Error('boom from onFinish')
        }
      },
      execute: async (n) => {
        ran.add(n.id)
        await new Promise((r) => setTimeout(r, 5))
        return success(n)
      },
    })
    expect(out.size).toBe(2)
    expect(ran.has('big#run')).toBe(true)
    expect(out.get('big#run')!.status).toBe('success')
  })

  it('a pooled task is never asked and never listed: it runs on the pool, not here', async () => {
    // The discriminating shape: if the pooled task were listed as running,
    // the policy (which admits `l#*` only from idle) could never have p#big
    // and a local task in flight together. So the pin asserts the overlap.
    const inFlight = new Set<string>()
    let overlapped = false
    const asked: string[] = []
    const pool = { name: 'remote', capacity: 1 }
    const out = await runGraph({
      nodes: nodes(node('p#big'), node('l#a'), node('l#b')),
      concurrency: 2,
      poolOf: (id) => (id.startsWith('p#') ? pool : undefined),
      admit: (id, running) => {
        asked.push(id)
        return running.size === 0 || id === 'l#b'
      },
      execute: async (n) => {
        inFlight.add(n.id)
        if (inFlight.has('p#big') && (inFlight.has('l#a') || inFlight.has('l#b'))) {
          overlapped = true
        }
        await new Promise((r) => setTimeout(r, 40))
        inFlight.delete(n.id)
        return success(n)
      },
    })
    expect(out.size).toBe(3)
    expect([...out.values()].every((o) => o.status === 'success')).toBe(true)
    expect(overlapped).toBe(true)
    expect(asked).not.toContain('p#big')
  })
})

// A UserError thrown by an executor from ANOTHER COPY of core (a plugin's
// `@vzn/vx` inside a compiled vx) is still a user error: reported as
// `[vx] <id>: <message>`, never as an "internal error" with the class name
// prefixed. `instanceof` cannot see across the copy boundary; the name can.
describe('runGraph reports a foreign-copy UserError plainly', () => {
  class ForeignUserError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'UserError'
    }
  }
  async function stderrOf(err: Error): Promise<string> {
    let out = ''
    const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      out += String(chunk)
      return true
    }) as never)
    try {
      const result = await runGraph({
        nodes: nodes(node('a#build')),
        concurrency: 1,
        execute: async () => {
          throw err
        },
      })
      expect(result.get('a#build')?.status).toBe('failed')
    } finally {
      spy.mockRestore()
    }
    return out
  }
  it('a foreign-copy UserError prints the message only', async () => {
    const out = await stderrOf(new ForeignUserError('remote blob evicted; re-run with --force'))
    expect(out).toContain('[vx] a#build: remote blob evicted; re-run with --force')
    expect(out).not.toContain('internal error')
  })
  it('CONTROL: a plain Error is still an internal error', async () => {
    const out = await stderrOf(new Error('kaboom'))
    expect(out).toContain('[vx] internal error in a#build: kaboom')
  })
})
