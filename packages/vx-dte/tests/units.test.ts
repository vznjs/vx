import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { localEnv, runWorker, swapRoots } from '../src/worker.js'
import { docker, dte, local } from '../src/index.js'
import { errorLine } from '../src/local.js'
import { bytes, needOf } from '../src/plugin.js'
import {
  type CacheFacts,
  type ExecuteRequest,
  type TaskArtifacts,
  type TaskNode,
  ui,
} from '@vzn/vx'
import { Orchestrator, runKey } from '../src/orchestrator.js'
import { fits, type Need } from '../src/dispatch.js'
import { outputFiles } from '../src/outputs.js'
import { Usage } from '../src/usage.js'
import { tailsMs } from '../src/planner.js'
import { join } from '../src/wire.js'
import { sealOrchestrator, secretProof } from '../src/seal.js'
import type { RunOrder } from '../src/messages.js'
import { servedRelay } from './served-relay.js'

/** Run ids: random UUIDs, as the relay takes. */
const R = '00000000-0000-4000-8000-000000000001'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-unit-'))
  dirs.push(d)
  return d
}

it('a worker clears the files a task’s outputs match, links included, before it runs it', async () => {
  const from = await tmp()
  await mkdir(path.join(from, 'p/out/deep'), { recursive: true })
  await writeFile(path.join(from, 'p/out/deep/a.sh'), 'echo hi\n')
  await symlink('deep/a.sh', path.join(from, 'p/out/link'))
  await writeFile(path.join(from, 'p/out/skip.map'), '')
  expect(
    await outputFiles(from, 'p', { files: ['out/**', '!out/*.map'], workspaceFiles: [] }),
  ).toEqual(['p/out/deep/a.sh', 'p/out/link'])
})

it('a worker runs the orchestrator’s env with its own root, host names and PATH', () => {
  const saved = { HOME: process.env['HOME'], PATH: process.env['PATH'] }
  process.env['HOME'] = '/worker/home'
  process.env['PATH'] = '/usr/bin'
  try {
    expect(
      localEnv(
        {
          HOME: '/orc/home',
          PATH: '/orc/ws/node_modules/.bin:/opt/orc',
          VX_RUN_WORKSPACE: '/orc/ws',
          X: '1',
        },
        '/orc/ws',
        '/worker/ws',
      ),
    ).toMatchObject({
      HOME: '/worker/home',
      PATH: '/worker/ws/node_modules/.bin:/usr/bin',
      VX_RUN_WORKSPACE: '/worker/ws',
      X: '1',
    })
  } finally {
    Object.assign(process.env, saved)
  }
})

it('a worker swaps each root once, the first pair naming it winning', () => {
  expect(
    swapRoots({ a: '/ws/p/x', b: ['/ws', '/ws2/q', '/private/ws/r'], c: 'x:/ws/b' }, [
      ['/ws', '/worker/ws'],
      ['/ws2', '/ws'],
    ]),
  ).toEqual({
    a: '/worker/ws/p/x',
    b: ['/worker/ws', '/ws/q', '/private/ws/r'],
    c: 'x:/worker/ws/b',
  })
})

it('a worker with other tracked files than the run is refused', async () => {
  const served = servedRelay()
  const url = served.url
  try {
    const o = new Orchestrator({
      me: await join(url, R, 'orchestrator', null, undefined),
      root: '/ws',
      tree: 'aaa',
      nodes: () => undefined,
      need: () => ({ cores: 1, memory: 0 }),
      artifacts: fakeArtifacts().artifacts,
      cacheFacts: async () => ({ refs: [], lent: {} }),
      run: R,
      keyOf: () => undefined,
    })
    const worker = await join(
      url,
      R,
      'worker',
      { v: 1, cores: 1, memory: 1, tree: 'bbb' },
      undefined,
    )
    let got: unknown[] = []
    for (let i = 0; i < 20 && got.length === 0; i++) got = await worker.poll()
    expect(got).toEqual([
      {
        from: 'orchestrator',
        body: { type: 'refused', reason: 'checked out tree bbb, the run is on aaa' },
      },
    ])
    await o.close()
  } finally {
    await served.stop()
  }
})

// CI starts workers beside the orchestrator; on a warm run it can finish
// before a slow runner's worker joins, and that worker's job is not a failure.
// The relay keeps nothing of a run that ended: a worker late for it joins
// an empty run, which closes when no orchestrator joins (120 heartbeats).
it('a worker late for a run that ended exits 0', async () => {
  const served = servedRelay({ heartbeatMs: 20 })
  const url = served.url
  try {
    await (await join(url, R, 'orchestrator', null, undefined)).leave()
    const code = await runWorker({
      relay: url,
      run: R,
      root: process.cwd(),
      token: async () => undefined,
      proof: { psk: async () => new Uint8Array(32), mismatch: 'no key' },
      artifacts: () => fakeArtifacts().artifacts,
    })
    expect(code).toBe(0)
  } finally {
    await served.stop()
  }
})

// A relay restart, or silence past three heartbeats, loses the worker: its
// next poll answers 404. The run gave its tasks to others; the worker's CI
// job is no failure (mac#1 on #3895).
it('a worker the relay lost exits 0', async () => {
  const served = servedRelay()
  const url = served.url
  try {
    const o = await join(url, R, 'orchestrator', null, undefined)
    const code = runWorker({
      relay: url,
      run: R,
      root: process.cwd(),
      token: async () => undefined,
      proof: { psk: async () => new Uint8Array(32), mismatch: 'no key' },
      artifacts: () => fakeArtifacts().artifacts,
    })
    for (let i = 0; i < 50 && (await o.poll()).length === 0; i++);
    served.restart()
    expect(await code).toBe(0)
  } finally {
    await served.stop()
  }
})

it('gives a failed worker start one more worker, then fails the run', async () => {
  const served = servedRelay()
  const url = served.url
  try {
    const freed: string[] = []
    const o = new Orchestrator({
      me: await join(url, R, 'orchestrator', null, undefined),
      root: '/ws',
      tree: 'aaa',
      nodes: () => undefined,
      need: () => ({ cores: 1, memory: 0 }),
      artifacts: fakeArtifacts().artifacts,
      cacheFacts: async () => ({ refs: [], lent: {} }),
      run: R,
      keyOf: () => undefined,
      lost: (id) => {
        freed.push(id)
        // As dte() does: the freed place starts the next worker.
        o.spawned(`small#${freed.length + 1}`, { size: 'small', cpu: 1, memory: 1 })
      },
    })
    o.spawned('small#1', { size: 'small', cpu: 1, memory: 1 })
    o.failed('small#1', 'install exited 1: ECONNRESET')
    o.failed('small#2', 'install exited 1: ECONNRESET')
    const run = o.execute({ taskId: 'p#t' } as Parameters<typeof o.execute>[0])
    expect([freed, await run.catch((e: Error) => e.message)]).toEqual([
      ['small#1'],
      'no worker could start: small#2 install exited 1: ECONNRESET',
    ])
    await o.close()
  } finally {
    await served.stop()
  }
})

/** A cache by key, in memory: what workers saved, and each restore asked. */
function fakeArtifacts() {
  const saved = new Map<string, { stdout: string; stderr: string }>()
  const restored: string[] = []
  const artifacts: TaskArtifacts = {
    async save() {},
    async restore(key) {
      restored.push(key)
      return saved.get(key) ?? null
    },
  }
  return { artifacts, saved, restored }
}

/** An orchestrator on a loopback relay, and workers of it that only listen. */
async function harness(
  nodes: Map<string, TaskNode>,
  need: (id: string) => Need = () => ({ cores: 1, memory: 10 }),
  heartbeatMs?: number,
  keyOf: (id: string) => string | undefined = () => undefined,
  tail?: (id: string) => number,
  more: { faulted?: () => void } = {},
) {
  const store = fakeArtifacts()
  const cache: { facts: CacheFacts } = { facts: { refs: [], lent: {} } }
  const served = servedRelay(heartbeatMs === undefined ? {} : { heartbeatMs })
  const url = served.url
  const o = new Orchestrator({
    me: await join(url, R, 'orchestrator', null, undefined),
    root: '/ws',
    tree: 'c',
    nodes: () => nodes,
    need,
    artifacts: store.artifacts,
    cacheFacts: async () => cache.facts,
    run: R,
    keyOf,
    ...(tail === undefined ? {} : { tail }),
    ...more,
  })
  const worker = async (cores: number, id?: string) => {
    const me = await join(url, R, 'worker', { v: 1, cores, memory: 100, tree: 'c', id }, undefined)
    const orders: RunOrder[] = []
    const batches = async (): Promise<string[][]> => {
      for (let i = 0; i < 20; i++) {
        const got = (await me.poll()).map((m) => m.body as { type: string; tasks?: RunOrder[] })
        const b = got.filter((m) => m.type === 'batch').map((m) => m.tasks!)
        orders.push(...b.flat())
        if (b.length > 0) return b.map((t) => t.map((o) => o.task))
      }
      return []
    }
    const finish = async (task: string, key = `k-${task}`): Promise<void> => {
      store.saved.set(key, { stdout: `${task} out\n`, stderr: '' })
      await me.send('orchestrator', {
        type: 'end',
        task,
        key,
        result: { exitCode: 0, durationMs: 1 },
      })
    }
    const begin = (task: string) => me.send('orchestrator', { type: 'start', task })
    const say = (body: object) => me.send('orchestrator', body)
    const types = async (): Promise<string[]> => {
      const seen: string[] = []
      for (let i = 0; i < 5 && !seen.includes('exit'); i++)
        seen.push(...(await me.poll()).map((m) => (m.body as { type: string }).type))
      return seen
    }
    /** The next messages that are not batches, by type. */
    const bodies = async (): Promise<{ type: string; task?: string }[]> => {
      for (let i = 0; i < 20; i++) {
        const got = (await me.poll()).map((m) => m.body as { type: string; tasks?: RunOrder[] })
        orders.push(...got.flatMap((m) => (m.type === 'batch' ? m.tasks! : [])))
        const rest = got.filter((m) => !['batch', 'welcome', 'cache'].includes(m.type))
        if (rest.length > 0) return rest
      }
      return []
    }
    return {
      batches,
      bodies,
      finish,
      begin,
      say,
      types,
      orders,
      poll: () => me.poll(),
      leave: () => me.leave(),
      id: me.id,
    }
  }
  const req = (taskId: string, cacheKey?: string) =>
    ({
      taskId,
      ...(cacheKey === undefined ? {} : { cacheKey }),
      workspaceRoot: '/ws',
      command: 'true',
      forwardArgs: [],
      cwd: '/ws',
      env: {},
      envDefine: {},
      outputs: { files: [], workspaceFiles: [] },
      onStdout() {},
      onStderr() {},
    }) as unknown as ExecuteRequest
  const stop = async () => {
    await o.close()
    await served.stop()
  }
  return { o, worker, req, stop, store, cache }
}

it('a worker reads the cache as the run does, and is lent its remotes’ access again before it ends', async () => {
  const h = await harness(new Map())
  try {
    h.cache.facts = {
      refs: ['refs/heads/feat', 'refs/heads/main'],
      lent: { '@vzn/vx-migrate': 't1' },
      expiresAt: Date.now() + 4 * 60_000 + 300,
    }
    const a = await h.worker(2)
    const got: unknown[] = []
    for (let i = 0; i < 20 && got.length < 2; i++) {
      got.push(...(await a.poll()).map((m) => m.body))
      if (got.length === 1)
        h.cache.facts = { refs: ['refs/heads/feat'], lent: { '@vzn/vx-migrate': 't2' } }
    }
    expect(got).toEqual([
      {
        type: 'welcome',
        name: 'worker#1',
        cache: {
          refs: ['refs/heads/feat', 'refs/heads/main'],
          lent: { '@vzn/vx-migrate': 't1' },
          expiresAt: expect.any(Number),
        },
      },
      { type: 'cache', cache: { refs: ['refs/heads/feat'], lent: { '@vzn/vx-migrate': 't2' } } },
    ])
  } finally {
    await h.stop()
  }
})

const node = (id: string, deps: string[] = []) =>
  [id, { id, deps, projectDir: '/ws', config: {} } as unknown as TaskNode] as const

// M, 2026-10-23: "we should not send tasks in batches unless we are 100%
// sure ... they can fit". Main bf77a58: small#3's load read low while 38
// test shards began, so it took them all on 4 cores, 28 failed, and the 5
// workers started for them got none. Load only ever adds to the booking.
it('sends a worker what its booking fits, though its load reads low; busier than booked, less', async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `t${i + 1}`)
  const h = await harness(new Map(ids.map((id) => node(id))))
  try {
    const a = await h.worker(4)
    await Bun.sleep(50)
    for (const id of ids) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['t1', 't2', 't3', 't4']])
    for (const id of ['t1', 't2', 't3', 't4'])
      await a.say({ type: 'start', task: id, load: { cpu: 0.1, memory: 0 } })
    await Bun.sleep(50)
    expect(h.o.where('t5')).toBeNull()
    // The worker started for them gets them.
    const b = await h.worker(4)
    expect(await b.batches()).toEqual([['t5', 't6', 't7', 't8']])
    // Its machine busier than booked: the core a task freed stays taken.
    await b.say({ type: 'start', task: 't5', load: { cpu: 4, memory: 0 } })
    const t9 = h.o.execute(h.req('t9'))
    await b.finish('t5')
    await b.say({ type: 'held', running: ['t6', 't7', 't8'], load: { cpu: 4, memory: 0 } })
    await Bun.sleep(50)
    expect(h.o.where('t9')).toBeNull()
    void t9
  } finally {
    await h.stop()
  }
})

// Main, 2026-10-23: 12 workers of 4 cores each ran about one task, at 25%
// CPU all their time online; packed, the ones the rest does not need leave.
it('packs tasks onto the worker with fewest cores free, and the idle one leaves', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3')]))
  try {
    const a = await h.worker(4)
    const b = await h.worker(4)
    await Bun.sleep(50)
    for (const id of ['t1', 't2', 't3']) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['t1', 't2', 't3']])
    // Only an idle one goes.
    h.o.release([a.id, b.id])
    expect(await b.bodies()).toEqual([{ type: 'exit' }])
    expect(h.o.planState(() => undefined, 0).workers.map((w) => w.id)).toEqual([a.id])
  } finally {
    await h.stop()
  }
})

// Main, 2026-10-23: workers read booked 4.2 of 4 cores, each task held
// until its outputs saved: booked is from its start to its command's end.
it('books a worker the cores of a task from its start to its command’s end', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  const a = await h.worker(2)
  await Bun.sleep(50)
  for (const id of ['t1', 't2']) void h.o.execute(h.req(id))
  expect(await a.batches()).toEqual([['t1', 't2']])
  await a.begin('t1')
  await a.say({ type: 'ran', task: 't1' })
  await Bun.sleep(50)
  await h.stop()
  const rows = h.o.footer().map(([, line]) => ui.inline(line, { enabled: false }))
  expect(rows.find((r) => r.includes('expected'))).toContain('expected 0.0 ·')
})

// Main, 2026-10-23: vx-docs#build (41 s, then its test) got ready 3 s in,
// behind 46 shards ready at once, and began 47 s in: the run's end.
it('places the queued task the most of the run waits on first, not the first asked', async () => {
  const ids = ['t1', 's1', 's2', 's3', 'build']
  const tail = (id: string) => (id === 'build' ? 45_000 : 35_000)
  const h = await harness(new Map(ids.map((id) => node(id))), undefined, undefined, undefined, tail)
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    for (const id of ids) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['build']])
    await a.finish('build')
    expect(await a.batches()).toEqual([['t1']])
  } finally {
    await h.stop()
  }
})

it('a task’s tail is its duration and its longest chain of dependants', () => {
  const runs = (id: string, deps: string[] = []) =>
    [
      id,
      { id, deps, projectDir: '/ws', config: { exec: { command: 'x' } } } as unknown as TaskNode,
    ] as const
  const nodes = new Map([
    runs('import'),
    runs('build', ['import']),
    runs('test', ['build']),
    runs('shard'),
    [
      'ci',
      { id: 'ci', deps: ['test', 'shard'], projectDir: '/ws', config: {} } as unknown as TaskNode,
    ] as const,
  ])
  const ms: Record<string, number> = { import: 1_000, build: 41_000, test: 4_000 }
  const tail = tailsMs(nodes, (id) => ms[id])
  expect(['import', 'build', 'test', 'shard', 'ci'].map(tail)).toEqual([
    46_000, 45_000, 4_000, 30_000, 0,
  ])
})

// M, 2026-10-21: check.bun, ahead of 8 shards, sat in a busy worker's
// queue as its prefetch while workers that joined later stood idle. None
// waits in a worker's queue now: it waits here for the first that is free.
it('a task no worker fits waits here, and goes to the first one free', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    for (const id of ['t1', 't2']) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    const b = await h.worker(1)
    expect(await b.batches()).toEqual([['t2']])
  } finally {
    await h.stop()
  }
})

// Main 871ffba, 2026-10-23: check.bun, unmeasured so alone on a worker,
// waited 50 s while tasks behind it filled that worker again and again.
it('a task that runs alone holds the worker it waits for; none after it takes it', async () => {
  const h = await harness(
    new Map([node('t1'), node('alone'), node('t3')]),
    (id) => (id === 'alone' ? { cores: Infinity, memory: Infinity } : { cores: 1, memory: 10 }),
    undefined,
    undefined,
    (id) => (id === 'alone' ? 100 : 1),
  )
  try {
    const a = await h.worker(2)
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    for (const id of ['alone', 't3']) void h.o.execute(h.req(id))
    await Bun.sleep(50)
    await a.finish('t1')
    expect(await a.batches()).toEqual([['alone']])
  } finally {
    await h.stop()
  }
})

// M, 2026-10-23: "If workers joined and nothing is queued anymore orch
// should ... close them": one started and not needed is cancelled, and
// told to exit should it join anyway.
it('a worker cancelled before it joined is told to exit when it joins, and never counted', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    h.o.spawned('small#1', { size: 'small', cpu: 1, memory: 100 })
    h.o.spawned('small#2', { size: 'small', cpu: 1, memory: 100 })
    const a = await h.worker(1, 'small#1')
    await Bun.sleep(50)
    expect(h.o.release(['small#2'])).toEqual(['small#2'])
    expect(h.o.planState(() => undefined, 0).workers.map((w) => w.id)).toEqual([a.id])
    const b = await h.worker(1, 'small#2')
    expect(await b.types()).toEqual(['exit'])
    h.o.failed('small#2', 'job cancelled')
    expect(h.o.machines().map((m) => m.name)).toEqual(['small#1'])
  } finally {
    await h.stop()
  }
})

it('an idle worker that faulted is let go', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.worker(1)
    const b = await h.worker(1)
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.say({ type: 'fault', task: 't1', reason: 'ENOSPC' })
    expect(await b.batches()).toEqual([['t1']])
    h.o.release([])
    expect(await a.bodies()).toEqual([{ type: 'exit' }])
  } finally {
    await h.stop()
  }
})

// Growth, 2026-10-21: four local() workers of 1 core on a 4-core host each
// reported the host and took 4 tasks plus a prefetch, 16 wide on 4 cores.
// Its load is its host's, so the run counts what it booked.
it('a worker of a declared size is sent work for that size, not its machine', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3')]))
  try {
    h.o.spawned('small#1', { size: 'small', cpu: 1, memory: 100 })
    const a = await h.worker(4, 'small#1')
    await Bun.sleep(50)
    for (const id of ['t1', 't2', 't3']) void h.o.execute(h.req(id))
    // 1 core: one at a time.
    expect(await a.batches()).toEqual([['t1']])
  } finally {
    await h.stop()
  }
})

// M, 2026-10-21: 16 rows said running while 4 workers ran 4 of them; and
// a worker's cores and memory belong to the final summary only.
it('a task waits until a worker begins it; the live rows leave out its machine', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3'), node('t4')]))
  try {
    const a = await h.worker(2)
    await Bun.sleep(50)
    for (const id of ['t1', 't2', 't3', 't4']) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['t1', 't2']])
    expect(['t1', 't2', 't3', 't4'].map((t) => h.o.where(t))).toEqual([null, null, null, null])
    expect(h.o.where('other')).toBeUndefined()
    await a.begin('t1')
    for (let i = 0; i < 40 && h.o.where('t1') === null; i++) await Bun.sleep(25)
    expect(['t1', 't2'].map((t) => h.o.where(t))).toEqual(['worker#1', null])
    const live = JSON.stringify(h.o.footer())
    expect(live).toContain('1 running')
    expect(live).not.toMatch(/\dc\//)
  } finally {
    await h.stop()
  }
})

// A worker the rest of the run cannot keep busy leaves rather than idle
// until the run ends; one a remaining task needs for its size stays.
it('a worker the plan lets go leaves, and the plan no longer places on it', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.worker(4)
    const b = await h.worker(2)
    await Bun.sleep(50)
    h.o.release([b.id])
    expect(await b.types()).toContain('exit')
    const footer = JSON.stringify(h.o.footer())
    expect(footer).toContain('left')
    expect(h.o.planState(() => undefined, 0).workers.map((w) => w.cores)).toEqual([4])
    h.o.release([a.id])
    expect(await a.types()).toContain('exit')
    expect(h.o.planState(() => undefined, 0).workers).toEqual([])
  } finally {
    await h.stop()
  }
})

// M, 2026-10-21: a worker the run's end stopped still read `online`, and
// a size's machines were a `!` line apart from its workers.
it('the final summary says how each worker ended, its size and machine under it', async () => {
  const h = await harness(new Map([node('t1')]))
  const small = { size: 'small', cpu: 2, memory: 4e9 }
  h.o.asked(2, 3, 1, 70_000)
  h.o.spawned('small#1', small)
  h.o.spawned('big#1', { size: 'big', cpu: 4, memory: 4e9 })
  const a = await h.worker(2, 'small#1')
  const b = await h.worker(4, 'big#1')
  const c = await h.worker(1)
  await Bun.sleep(50)
  await c.leave()
  for (let i = 0; i < 40 && !JSON.stringify(h.o.footer()).includes('lost'); i++) await Bun.sleep(25)
  h.o.release([b.id])
  expect(await b.types()).toContain('exit')
  await h.stop()
  const rows = h.o.footer().map(([, line]) => ui.inline(line, { enabled: false }))
  const at = (label: string) => rows.findIndex((r) => r.startsWith(label + ' '))
  expect(rows[at('worker#1')]).toMatch(/^worker#1 +lost/)
  expect(rows[at('small#1')]).toMatch(/^small#1 +stopped/)
  expect(rows[at('small#1') + 1]).toMatch(/^ +declared 2c\/4G · actual 2c\/0G$/)
  expect(rows[at('big#1')]).toMatch(/^big#1 +left/)
  expect(rows.some((r) => r.trimStart().startsWith('!'))).toBe(false)
  expect(rows.filter((r) => /^\S+ +online/.test(r))).toEqual([])
  // When the run asked for workers, for which work, and when its plan ended: why it had as many as it did.
  expect(rows.filter((r) => r.startsWith('asked'))).toEqual([
    expect.stringMatching(/^asked +2 at 0\.\ds for 3 tasks \(1 measured\), plan 70\.0s$/),
  ])
  // Tasks that reported no memory read `memory peak 0 B`.
  expect(rows.filter((r) => r.includes('memory peak'))).toEqual([])
  // A few hundred bytes read `0 KB`.
  expect(rows.filter((r) => r.includes(' 0 KB'))).toEqual([])
  expect(rows.some((r) => /^ +sent \d+ messages? · \d+ B, received/.test(r))).toBe(true)
  void a
})

// Live, the workers that left are one line, so the rows that run fit.
it('lists the workers that left as one line while the run goes', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.worker(4)
    const b = await h.worker(2)
    const c = await h.worker(2)
    await Bun.sleep(50)
    h.o.release([b.id, c.id])
    expect(await b.types()).toContain('exit')
    expect(await c.types()).toContain('exit')
    const rows = h.o.footer().map(([, line]) => ui.inline(line, { enabled: false }))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/^worker#1 +online/)
    expect(rows[1]).toMatch(/^2 workers +left +0 done$/)
    void a
  } finally {
    await h.stop()
  }
})

// A lost worker's begun task runs again on another, two workers at most;
// one it had not begun goes back and does not count.
it('a task lost with two workers fails naming both; one not begun goes back free', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const a = await h.worker(2)
    await Bun.sleep(50)
    // Its failure lands while b leaves, before the test awaits it.
    const t1 = h.o.execute(h.req('t1')).then(
      () => '',
      (e: Error) => e.message,
    )
    const t2 = h.o.execute(h.req('t2'))
    expect(await a.batches()).toEqual([['t1', 't2']])
    await a.begin('t1')
    await Bun.sleep(50)
    await a.leave()
    const b = await h.worker(2)
    expect(await b.batches()).toEqual([['t1', 't2']])
    await b.begin('t1')
    await b.begin('t2')
    await Bun.sleep(50)
    await b.leave()
    expect(await t1).toBe('t1: failed on 2 workers: worker#1 lost, worker#2 lost')
    const c = await h.worker(1)
    expect(await c.batches()).toEqual([['t2']])
    await c.finish('t2')
    expect((await t2).exitCode).toBe(0)
  } finally {
    await h.stop()
  }
})

// An adapter that saw its worker's process or job end says so: its tasks
// went back when the relay stopped hearing it, 20 s later (2026-10-23).
it('a worker its adapter says exited is lost at once, its task run again', async () => {
  const h = await harness(new Map([node('t1')]), undefined, 60_000)
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    await Bun.sleep(50)
    h.o.failed('worker#1', 'exited 137')
    const b = await h.worker(1)
    expect(await b.batches()).toEqual([['t1']])
    await b.finish('t1')
    expect((await t1).exitCode).toBe(0)
    expect(h.o.machines().map((m) => [m.name, m.status])).toEqual([
      ['worker#2', 'ok'],
      ['worker#1', 'failed'],
    ])
  } finally {
    await h.stop()
  }
})

// Asked before the run's end, a worker still there read online 1 ms and
// booked 433802 of 4 (main, 2026-10-23).
it('reports a worker still there at the summary online until then', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const a = await h.worker(1)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    await Bun.sleep(100)
    await a.finish('t1')
    expect((await t1).exitCode).toBe(0)
    const [m] = h.o.machines()
    expect(m!.status).toBe('ok')
    // A failed task is the task's, not its worker's (M, 2026-10-23).
    const t2 = h.o.execute(h.req('t2'))
    expect(await a.batches()).toEqual([['t2']])
    h.store.saved.set('k-t2', { stdout: '', stderr: '' })
    await a.say({ type: 'end', task: 't2', key: 'k-t2', result: { exitCode: 1, durationMs: 1 } })
    expect((await t2).exitCode).toBe(1)
    expect(h.o.machines()[0]!.status).toBe('ok')
    expect(m!.onlineMs).toBeGreaterThanOrEqual(100)
    expect(m!.bookedAvg).toBeLessThanOrEqual(m!.cores)
  } finally {
    await h.stop()
  }
})

it('a worker that could not run a task it began gets no more; two such fail it', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.say({ type: 'fault', task: 't1', reason: 'ENOSPC' })
    const b = await h.worker(2)
    expect(await b.batches()).toEqual([['t1']])
    void h.o.execute(h.req('t2'))
    expect(await b.batches()).toEqual([['t2']])
    await b.say({ type: 'fault', task: 't1', reason: 'unpack failed' })
    expect(
      await t1.then(
        () => '',
        (e: Error) => e.message,
      ),
    ).toBe('t1: failed on 2 workers: worker#1 ENOSPC, worker#2 unpack failed')
  } finally {
    await h.stop()
  }
})

it('a task a worker stops saying it holds goes back when its lease ends', async () => {
  const h = await harness(new Map([node('t1')]), undefined, 100)
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    // One `held` lasts three of its own period, `HELD_EVERY` heartbeats
    // each: a worker says it that seldom, as each is a relay message billed.
    await a.say({ type: 'held', running: ['t1'], queued: [] })
    // Five heartbeats, polled so the relay keeps it.
    for (let i = 0; i < 5; i++) await a.poll()
    expect(h.o.where('t1')).toBe('worker#1')
    const b = await h.worker(1)
    // Alive, holding nothing: t1's lease ends and it moves.
    const alive = setInterval(() => void a.say({ type: 'held', running: [], queued: [] }), 50)
    try {
      let got: string[][] = []
      for (let i = 0; i < 3 && got.length === 0; i++) got = await b.batches()
      expect(got).toEqual([['t1']])
    } finally {
      clearInterval(alive)
    }
  } finally {
    await h.stop()
  }
})

// M, 2026-10-21: files go through the cache, the relay carries only
// orders and status.
it('an order names its key and each dependency’s; the result comes back by the key its worker saved', async () => {
  const cached = (id: string, deps: string[] = []) =>
    [
      id,
      {
        id,
        deps,
        projectDir: `/ws/${id}`,
        config: { cache: { outputs: { files: ['dist/**'] } } },
      } as unknown as TaskNode,
    ] as const
  const h = await harness(
    new Map([
      cached('lib'),
      cached('mid', ['lib']),
      cached('app', ['mid']),
      cached('top', ['mid']),
    ]),
    undefined,
    undefined,
    (id) => (id === 'lib' ? 'k-lib-hit' : undefined),
  )
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const mid = h.o.execute(h.req('mid', 'k-mid'))
    expect(await a.batches()).toEqual([['mid']])
    expect(a.orders[0]).toMatchObject({
      task: 'mid',
      key: 'k-mid',
      runKey: runKey(R, 'mid'),
      deps: [{ task: 'lib', key: 'k-lib-hit', project: 'lib', outputs: { files: ['dist/**'] } }],
    })
    // A failure is saved under its run key.
    await a.finish('mid', runKey(R, 'mid'))
    const got = await mid
    expect(got.stdout).toBe('mid out\n')
    expect(h.store.restored).toEqual([runKey(R, 'mid')])
    void h.o.execute(h.req('app', 'k-app'))
    expect(await a.batches()).toEqual([['app']])
    // Named though it holds them: the worker restores each key once.
    expect(a.orders.find((o) => o.task === 'app')!.deps.map((d) => [d.task, d.key])).toEqual([
      ['mid', runKey(R, 'mid')],
      ['lib', 'k-lib-hit'],
    ])
    const b = await h.worker(1)
    await Bun.sleep(50)
    // Another worker, with room where the first has none, is sent both.
    void h.o.execute(h.req('top', 'k-top'))
    expect(await b.batches()).toEqual([['top']])
    expect(b.orders[0]!.deps.map((d) => [d.task, d.key])).toEqual([
      ['mid', runKey(R, 'mid')],
      ['lib', 'k-lib-hit'],
    ])
  } finally {
    await h.stop()
  }
})

it('sends a task to the worker that holds its dependency’s outputs', async () => {
  const h = await harness(new Map([node('x'), node('y', ['x'])]))
  try {
    const small = await h.worker(1)
    await Bun.sleep(50)
    const ran = h.o.execute(h.req('x'))
    expect(await small.batches()).toEqual([['x']])
    await small.finish('x')
    await ran
    const big = await h.worker(8)
    await Bun.sleep(50)
    void h.o.execute(h.req('y'))
    expect(await small.batches()).toEqual([['y']])
    void big
  } finally {
    await h.stop()
  }
})

// A worker that gave a task back had never run it, yet the orchestrator
// counted its outputs there: a dependant sent to that worker was ordered
// with no dependency to restore, and ran without its files (2026-10-22).
it('an order names every dependency, held by its worker or not', async () => {
  const cached = (id: string, deps: string[] = []) =>
    [
      id,
      {
        id,
        deps,
        projectDir: `/ws/${id}`,
        config: { cache: { outputs: { files: ['dist/**'] } } },
      } as unknown as TaskNode,
    ] as const
  const h = await harness(new Map([cached('t1'), cached('x'), cached('w'), cached('y', ['x'])]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    void h.o.execute(h.req('x', 'k-x'))
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    const b = await h.worker(1)
    expect(await b.batches()).toEqual([['x']])
    await b.finish('x', 'k-x')
    void h.o.execute(h.req('w'))
    expect(await b.batches()).toEqual([['w']])
    await b.begin('w')
    await a.finish('t1')
    await t1
    void h.o.execute(h.req('y'))
    expect(await a.batches()).toEqual([['y']])
    expect(a.orders.find((o) => o.task === 'y')!.deps.map((d) => [d.task, d.key])).toEqual([
      ['x', 'k-x'],
    ])
  } finally {
    await h.stop()
  }
})

// Two tasks begun together needing one dependency: the one whose order
// did not carry it ran before the other had restored it (2026-10-22).
it('a worker restores a dependency once, before any task that needs it runs', async () => {
  const root = await tmp()
  const served = servedRelay()
  const url = served.url
  try {
    const o = sealOrchestrator(
      await join(url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    let restores = 0
    const artifacts: TaskArtifacts = {
      async save() {},
      async restore() {
        restores++
        await Bun.sleep(100)
        await writeFile(path.join(root, 'dep.txt'), 'd')
        return { stdout: '', stderr: '' }
      },
    }
    const code = runWorker({
      relay: url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => artifacts,
    })
    const order = (task: string): RunOrder => ({
      task,
      runKey: runKey(R, task),
      deps: [
        { task: 'd', key: 'k-d', project: '', outputs: { files: ['dep.txt'], workspaceFiles: [] } },
      ],
      nested: [],
      command: 'test -f dep.txt',
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    })
    const ends: { task: string; exitCode: number }[] = []
    for (let i = 0; i < 100 && ends.length < 2; i++) {
      for (const { from, body } of await o.poll()) {
        const m = body as {
          type: string
          id?: string
          task?: string
          result?: { exitCode: number }
        }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 2,
            memory: 1e9,
          })
          await o.send(m.id!, {
            type: 'batch',
            root,
            realRoot: root,
            tasks: [order('t1'), order('t2')],
          })
        } else if (m.type === 'end') {
          ends.push({ task: m.task!, exitCode: m.result!.exitCode })
          if (ends.length === 2) await o.send(from, { type: 'exit' })
        }
      }
    }
    expect(await code).toBe(0)
    expect(ends.toSorted((x, y) => x.task.localeCompare(y.task))).toEqual([
      { task: 't1', exitCode: 0 },
      { task: 't2', exitCode: 0 },
    ])
    expect(restores).toBe(1)
  } finally {
    await served.stop()
  }
})

// A task whose outputs overlap a restored dependency's cleared its files,
// and a later task that needed them ran without them: the worker still
// counted them restored (2026-10-22).
it('a worker restores a dependency again after a task cleared its files', async () => {
  const root = await tmp()
  const served = servedRelay()
  const url = served.url
  try {
    const o = sealOrchestrator(
      await join(url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    let restores = 0
    const code = runWorker({
      relay: url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => ({
        async save() {},
        async restore() {
          restores++
          await mkdir(path.join(root, 'p/dist'), { recursive: true })
          await writeFile(path.join(root, 'p/dist/a.txt'), 'd')
          return { stdout: '', stderr: '' }
        },
      }),
    })
    const dist: RunOrder['outputs'] = { files: ['dist/**'], workspaceFiles: [] }
    const order = (
      task: string,
      deps: boolean,
      outputs: RunOrder['outputs'] = { files: [], workspaceFiles: [] },
    ) =>
      ({
        task,
        runKey: runKey(R, task),
        deps: deps ? [{ task: 'd', key: 'k-d', project: 'p', outputs: dist }] : [],
        nested: [],
        command: deps ? 'test -f p/dist/a.txt' : 'true',
        cwd: '',
        project: 'p',
        env: {},
        outputs,
        cores: 1,
        memory: 0,
      }) as RunOrder
    const tasks = [order('t1', true), order('t2', false, dist), order('t3', true)]
    const ends: { task: string; exitCode: number }[] = []
    for (let i = 0; i < 100 && ends.length < 3; i++) {
      for (const { from, body } of await o.poll()) {
        const m = body as {
          type: string
          id?: string
          task?: string
          result?: { exitCode: number }
        }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
          })
          await o.send(m.id!, { type: 'batch', root, realRoot: root, tasks: [tasks[0]!] })
        } else if (m.type === 'end') {
          ends.push({ task: m.task!, exitCode: m.result!.exitCode })
          // One at a time, as the run sends a worker of 1 core.
          if (ends.length === 3) await o.send(from, { type: 'exit' })
          else
            await o.send(from, {
              type: 'batch',
              root,
              realRoot: root,
              tasks: [tasks[ends.length]!],
            })
        }
      }
    }
    expect(await code).toBe(0)
    expect(ends).toEqual([
      { task: 't1', exitCode: 0 },
      { task: 't2', exitCode: 0 },
      { task: 't3', exitCode: 0 },
    ])
    expect(restores).toBe(2)
  } finally {
    await served.stop()
  }
})

// A stopped run whose worker was lost before it answered the cancel waited
// on that task forever (2026-10-22).
it('a task stopped while its worker is lost ends as stopped', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.worker(1)
    await Bun.sleep(50)
    const stop = new AbortController()
    const t1 = h.o.execute({ ...h.req('t1'), signal: stop.signal })
    expect(await a.batches()).toEqual([['t1']])
    await a.begin('t1')
    await Bun.sleep(20)
    stop.abort()
    expect(await a.bodies()).toEqual([{ type: 'cancel', task: 't1' }])
    await a.leave()
    expect(await t1).toMatchObject({ exitCode: 130 })
  } finally {
    await h.stop()
  }
}, 3_000)

// A task handed over already stopped was queued and run in full: its
// signal's abort had fired before anyone listened (2026-10-22).
it('a task handed over already stopped ends as stopped', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const stop = new AbortController()
    stop.abort()
    expect(await h.o.execute({ ...h.req('t1'), signal: stop.signal })).toMatchObject({
      exitCode: 130,
    })
  } finally {
    await h.stop()
  }
}, 3_000)

// A run's only worker faulted on a task: no worker was left to run it, none
// was starting, and the run waited forever (2026-10-22).
it('a task its only worker could not run fails when no worker is left', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    h.o.spawned('small#1', { size: 'small', cpu: 1, memory: 100 })
    const a = await h.worker(1, 'small#1')
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.say({ type: 'fault', task: 't1', reason: 'ENOSPC' })
    expect(
      await t1.then(
        () => '',
        (e: Error) => e.message,
      ),
    ).toBe('small#1 could not run t1 (ENOSPC) and no worker is left')
  } finally {
    await h.stop()
  }
}, 3_000)

// Main's macOS run, 2026-10-23: mac#1 let unsafe.shard-1's lease end,
// mac#2 had left, and the run failed rather than start another.
it('a task its only worker failed waits for the worker the run starts for it then', async () => {
  let h: Awaited<ReturnType<typeof harness>>
  h = await harness(new Map([node('t1')]), undefined, undefined, undefined, undefined, {
    faulted: () => h.o.spawned('small#2', { size: 'small', cpu: 1, memory: 100 }),
  })
  try {
    h.o.spawned('small#1', { size: 'small', cpu: 1, memory: 100 })
    const a = await h.worker(1, 'small#1')
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.say({ type: 'fault', task: 't1', reason: 'ENOSPC' })
    const b = await h.worker(1, 'small#2')
    expect(await b.batches()).toEqual([['t1']])
    await b.finish('t1')
    expect((await t1).exitCode).toBe(0)
  } finally {
    await h.stop()
  }
}, 3_000)

// A batch for a wide worker passed the relay's 1 MiB body limit and every
// task in it failed with `413 body over 1 MiB` (2026-10-22).
it('a batch past the relay’s body limit goes in parts', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3')]))
  try {
    const a = await h.worker(3)
    await Bun.sleep(50)
    const env = { BIG: 'x'.repeat(400_000) }
    for (const id of ['t1', 't2', 't3']) void h.o.execute({ ...h.req(id), env })
    const got: string[] = []
    for (let i = 0; i < 5 && got.length < 3; i++) got.push(...(await a.batches()).flat())
    expect(got.toSorted()).toEqual(['t1', 't2', 't3'])
  } finally {
    await h.stop()
  }
})

// A worker answering a cancel the run sent as it closed failed its CI job
// on the relay's `410 run closed` (2026-10-22).
it('a worker whose answer meets a closed run exits 0', async () => {
  const root = await tmp()
  const served = servedRelay()
  const url = served.url
  try {
    const raw = await join(url, R, 'orchestrator', null, undefined)
    const o = sealOrchestrator(raw, R, secretProof('s'))
    const code = runWorker({
      relay: url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => ({
        async save() {
          await Bun.sleep(100)
        },
        async restore() {
          return null
        },
      }),
    })
    const order = (task: string, command: string): RunOrder => ({
      task,
      runKey: runKey(R, task),
      deps: [],
      nested: [],
      command,
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    })
    let sent = false
    for (let i = 0; i < 50 && !sent; i++) {
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string }
        if (from !== 'relay' || m.type !== 'joined') continue
        await o.send(m.id!, {
          type: 'welcome',
          name: 'a',
          cache: { refs: [], lent: {} },
          cores: 1,
          memory: 1e9,
        })
        await o.send(m.id!, {
          type: 'batch',
          root,
          realRoot: root,
          tasks: [order('t1', 'sleep 2'), order('t2', 'true')],
        })
        await o.send(m.id!, { type: 'cancel', task: 't2' })
        sent = true
      }
    }
    await raw.leave()
    expect(await code).toBe(0)
  } finally {
    await served.stop()
  }
})

// Main, 2026-10-23: workers booked 3.7 cores and used 2.4; a task held its
// cores while its outputs went up to the cache. The next begins once the
// command is done.
it('a worker begins its next task while the last one saves', async () => {
  const root = await tmp()
  const served = servedRelay()
  const url = served.url
  let saved!: () => void
  const saving = new Promise<void>((r) => (saved = r))
  try {
    const raw = await join(url, R, 'orchestrator', null, undefined)
    const o = sealOrchestrator(raw, R, secretProof('s'))
    const code = runWorker({
      relay: url,
      run: R,
      root,
      token: async () => undefined,
      proof: secretProof('s'),
      artifacts: () => ({
        async save(_key, task) {
          if (task.id === 't1') await saving
        },
        async restore() {
          return null
        },
      }),
    })
    const order = (task: string): RunOrder => ({
      task,
      runKey: runKey(R, task),
      deps: [],
      nested: [],
      command: 'true',
      cwd: '',
      project: '',
      env: {},
      outputs: { files: [], workspaceFiles: [] },
      cores: 1,
      memory: 0,
    })
    const seen: string[] = []
    for (let i = 0; i < 100 && !seen.includes('start t2'); i++) {
      for (const { from, body } of await o.poll()) {
        const m = body as { type: string; id?: string; task?: string }
        if (from === 'relay' && m.type === 'joined') {
          await o.send(m.id!, {
            type: 'welcome',
            name: 'a',
            cache: { refs: [], lent: {} },
            cores: 1,
            memory: 1e9,
          })
          await o.send(m.id!, {
            type: 'batch',
            root,
            realRoot: root,
            tasks: [order('t1'), order('t2')],
          })
        } else if (m.type === 'start' || m.type === 'end') seen.push(`${m.type} ${m.task}`)
      }
    }
    expect(seen).toEqual(['start t1', 'start t2'])
    saved()
    await raw.leave()
    expect(await code).toBe(0)
  } finally {
    await served.stop()
  }
})

// M, 2026-10-22: workers at 30-50% CPU; "close to 100%". A task books the
// cores it keeps busy on average, so a 4-core worker takes five at 0.7.
it('books the cores a task keeps busy on average, unrounded, a quarter at least', () => {
  expect(
    [0.7, 2.4, 0.01].map((c) => needOf({ p50DurationMs: 1, maxCpuParallelism: c }).cores),
  ).toEqual([0.7, 2.4, 0.25])
  expect(needOf(undefined).cores).toBe(Infinity)
})

it('reads memory as bytes or with a unit', () => {
  expect([
    bytes('8GB'),
    bytes('512MiB'),
    bytes(1024),
    bytes('1.5 gb'),
    bytes('8'),
    bytes(0),
  ]).toEqual([8e9, 512 * 1024 ** 2, 1024, 1.5e9, undefined, undefined])
})

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('refuses options it does not read and workers it cannot start', () => {
  const adapter = local()
  expect(refusal(() => dte({ workers: {}, adapter, relays: 'x' } as never))).toContain(
    'dte() has unknown option "relays"',
  )
  expect(refusal(() => dte({ workers: { s: { max: 1, cpu: 0, memory: '1GB' } }, adapter }))).toBe(
    "dte(): workers.s needs cpu ≥ 1, memory such as '8GB', and a whole max ≥ 0 if any",
  )
  expect(
    refusal(() => dte({ workers: { s: { max: 1, cpu: 1, memory: '8 lots' } }, adapter })),
  ).toBe("dte(): workers.s needs cpu ≥ 1, memory such as '8GB', and a whole max ≥ 0 if any")
  expect(refusal(() => dte({ workers: {}, adapter, scheduler: { order: 'lifo' } as never }))).toBe(
    'dte(): scheduler.order is one of critical-path, graphene, fifo',
  )
  expect(refusal(() => dte({ workers: {}, adapter, scheduler: { pace: 'x' } as never }))).toBe(
    'dte(): scheduler.pace is no layer: the layers are order, place, book, scale',
  )
  expect(refusal(() => dte({}))).toBe(
    'dte(): with no adapter, set relay: the workers that join it run the tasks',
  )
  expect(refusal(() => dte({ relay: 'http://relay.test' }))).toBe('taken')
  expect(refusal(() => dte({ workers: { s: { cpu: 2, memory: '8GB' } }, adapter }))).toBe('taken')
  expect(refusal(() => local({ prepar: 'x' } as never))).toContain(
    'local() has unknown option "prepar"',
  )
  expect(refusal(() => dte({ workers: {}, adapter }))).toBe('taken')
  expect(refusal(() => docker({} as never))).toBe(
    "docker() needs image: one with Bun and git, such as 'oven/bun:1.4' plus git",
  )
})

it('a run that is not distributed loads none of it', async () => {
  // Every run evaluates `.vx/workspace.ts`: importing the plugin may not
  // load the orchestrator, the worker or the relay.
  const probe = `
const seen = []
Bun.plugin({ name: 'seen', setup(b) {
  b.onLoad({ filter: /(vx-dte|vx-dte-relay)\\/src\\/[^/]+\\.ts$/ }, async (a) => {
    seen.push(a.path.split('/').slice(-3).join('/'))
    return { contents: await Bun.file(a.path).text(), loader: 'ts' }
  })
} })
const m = await import(process.argv[1])
m.dte({ workers: {}, adapter: m.local() })
console.log(JSON.stringify(seen.sort()))
`
  const p = Bun.spawnSync([
    process.execPath,
    '-e',
    probe,
    path.join(import.meta.dir, '..', 'src', 'index.ts'),
  ])
  expect(JSON.parse(p.stdout.toString())).toEqual([
    'vx-dte/src/docker.ts',
    'vx-dte/src/github.ts',
    'vx-dte/src/gitlab.ts',
    'vx-dte/src/index.ts',
    'vx-dte/src/local.ts',
    'vx-dte/src/plugin.ts',
    'vx-dte/src/strategy.ts',
  ])
})

it('docker() starts each worker as a container of its size, on a fresh clone', async () => {
  const ws = await tmp()
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: ws })
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'i')
  const sha = git('rev-parse', 'HEAD').stdout.toString().trim()
  await mkdir(path.join(ws, 'sub'))
  // The root through a link, as macOS's /tmp is: git names the real path,
  // and the worker's `cd` climbed out of the clone (M's Mac, 2026-10-21).
  const link = path.join(await tmp(), 'ws')
  await symlink(ws, link)
  const bin = await tmp()
  const argv = path.join(bin, 'argv')
  await writeFile(path.join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\0' "$@" > ${argv}\n`, {
    mode: 0o755,
  })
  const saved = process.env['PATH']
  process.env['PATH'] = `${bin}:${saved}`
  // docker() mounts ~/.vx: a home of its own, not the real one.
  const home = process.env['HOME']
  process.env['HOME'] = await tmp()
  // As root: as another user a Linux container is told who it is.
  const uid = process.getuid!
  process.getuid = () => 0
  try {
    const d = docker({ image: 'img', prepare: 'bun install' })
    await d.spawn({
      run: R,
      relay: 'http://127.0.0.1:9',
      size: 'small',
      cpu: 2,
      memory: 8e9,
      index: 3,
      id: 'small#3',
      workspaceRoot: path.join(link, 'sub'),
      env: { VX_DTE_RUN: R, VX_DTE_WORKER: 'small#3', VX_DTE_RELAY: 'http://127.0.0.1:9' },
      exited: () => {},
    })
    for (let i = 0; i < 100 && !(await Bun.file(argv).exists()); i++) await Bun.sleep(20)
    const args = (await readFile(argv, 'utf8')).split('\0').slice(0, -1)
    const script = args.at(-1)!
    expect(args.slice(0, 8)).toEqual([
      'run',
      '--rm',
      '--name',
      `vx-dte-${process.pid}-3`,
      '--cpus',
      '2',
      '--memory',
      '8000000000b',
    ])
    expect(args).toContain(`${await realpath(ws)}:/src:ro`)
    expect(args.slice(-4, -2)).toEqual(['img', 'sh'])
    expect(script).toBe(
      [
        'set -e',
        'git clone -q /src /work',
        'cd /work',
        'git remote remove origin',
        `git fetch -q --upload-pack='git -c uploadpack.allowAnySHA1InWant=true upload-pack' /src ${sha}`,
        `git checkout -q --detach ${sha}`,
        "cd 'sub'",
        'bun install',
        'exec ./node_modules/.bin/vx dte worker',
      ].join('\n'),
    )
    await d.close?.()
  } finally {
    process.env['PATH'] = saved
    process.env['HOME'] = home
    process.getuid = uid
  }
})

it('a machine’s usage: peaks of tasks at once, averages over its time online', () => {
  const u = new Usage(0)
  const at = (end: number, durationMs: number, cpuMs: number, peakRssBytes: number) => {
    const now = performance.now
    performance.now = () => end
    try {
      u.record({ exitCode: 0, durationMs, cpuMs, peakRssBytes })
    } finally {
      performance.now = now
    }
  }
  // Two tasks overlap from 500 to 1000; a third starts as the first ends.
  at(1000, 1000, 1000, 100)
  at(1500, 1000, 2000, 200)
  at(2000, 1000, 1000, 50)
  u.failed = 1
  expect(u.stats(4, 4000)).toEqual({
    onlineMs: 4000,
    busyMs: 2000,
    cpuPeak: 3,
    cpuAvg: 1,
    memoryPeak: 300,
    memoryAvg: 87.5,
    utilization: 0.25,
    cpuMs: 4000,
    bookedAvg: 0,
  })
})

// Main ran 12 workers at 25% with each busy all its time online: what the
// run held on each says whether packing or the tasks left the cores idle.
it('a machine’s booked cores: what the run held for its tasks, averaged over its time online', () => {
  const u = new Usage(0)
  u.book(4, 0)
  u.book(-4, 1000)
  u.book(1, 1000)
  u.book(1, 2000)
  // Still held when the run ends at 4000: 4 + 1 + 2 * 2 core-seconds.
  expect(u.stats(4, 4000).bookedAvg).toBe(2.25)
})

// A Ctrl-C read `0 done · 2 failed` for one failed and one stopped task.
it('counts a task the stop killed as aborted, a timeout as failed', () => {
  const u = new Usage(0)
  u.record({ exitCode: 0, durationMs: 1 })
  u.record({ exitCode: 2, durationMs: 1 })
  u.record({ exitCode: 130, signal: 'SIGTERM', durationMs: 1 })
  u.record({ exitCode: 143, signal: 'SIGTERM', timedOut: true, durationMs: 1 })
  expect([u.done, u.failed, u.aborted]).toEqual([1, 2, 1])
})

it('knows how long a worker took to join', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    expect(h.o.warmUpMs()).toBeUndefined()
    // One that joined on its own was never asked for: it says nothing.
    await h.worker(2)
    h.o.spawned('small#1', { size: 'small', cpu: 2, memory: 100 })
    await Bun.sleep(120)
    await h.worker(2, 'small#1')
    await Bun.sleep(50)
    expect(h.o.warmUpMs()).toBeGreaterThanOrEqual(100)
  } finally {
    await h.stop()
  }
})

it('gives an unmeasured task a whole worker, and one that filled its worker a bigger one', async () => {
  const whole = { cores: Infinity, memory: Infinity }
  const h = await harness(new Map([node('u1'), node('u2'), node('heavy')]), (id) =>
    id === 'heavy' ? { ...whole, above: { cores: 2, memory: 100 } } : whole,
  )
  try {
    const small = await h.worker(2)
    await Bun.sleep(50)
    // No history: alone on its worker.
    const u1 = h.o.execute(h.req('u1'))
    void h.o.execute(h.req('u2'))
    expect(await small.batches()).toEqual([['u1']])
    await small.finish('u1')
    // The run keeps where it ran and that machine's size, for the next run.
    expect(await u1).toMatchObject({ where: 'worker#1', machine: { cores: 2, memoryBytes: 100 } })
    expect(await small.batches()).toEqual([['u2']])
    await small.finish('u2')
    // It filled a 2-core worker: the idle one is passed over for the
    // bigger one starting.
    h.o.spawned('big#2', { size: 'big', cpu: 8, memory: 1000 })
    void h.o.execute(h.req('heavy'))
    await Bun.sleep(50)
    const big = await h.worker(8)
    expect(await big.batches()).toEqual([['heavy']])
  } finally {
    await h.stop()
  }
}, 30_000)

it('a worker’s reason is its error line, not the hint after it', () => {
  expect([
    errorLine("\u001b[31m✗\u001b[0m vx  'dte' is not a vx command\n  fix  vx run dev --all\n"),
    errorLine('resolving\nerror: cannot find module\n  at x\n'),
    errorLine('just this\n\n'),
    errorLine(''),
    // git's own, from a container's clone (2026-10-21).
    errorLine(
      "warning: templates not found\nfatal: detected dubious ownership in repository at '/src/.git'\nTo add an exception...\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n",
    ),
  ]).toEqual([
    "✗ vx  'dte' is not a vx command",
    'error: cannot find module',
    'just this',
    '',
    "fatal: detected dubious ownership in repository at '/src/.git'",
  ])
})

// Main's workers booked 4.3 of 4 cores (2026-10-23): a task began on a
// free core whatever it asked. Beside others it fits in full or waits;
// an empty worker takes anything, alone.
it('a task begins beside others only when its cores and memory fit in full', () => {
  const bin = (cores: number, memory: number, running = 1) => ({
    id: 'w',
    cores: 4,
    memory: 16e9,
    used: { cores, memory },
    running,
  })
  expect(fits(bin(2.5, 1e9), { cores: 1.5, memory: 1e9 })).toBe(true)
  expect(fits(bin(3.2, 1e9), { cores: 1.5, memory: 1e9 })).toBe(false)
  expect(fits(bin(1, 15e9), { cores: 1, memory: 2e9 })).toBe(false)
  expect(fits(bin(0.5, 0), { cores: 4, memory: 0 })).toBe(false)
  expect(fits(bin(0, 0, 0), { cores: Infinity, memory: Infinity })).toBe(true)
})
