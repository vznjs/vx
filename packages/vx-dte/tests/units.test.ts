import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { createRelay } from '@vzn/vx-dte-relay'
import { localEnv, runAgent, swapRoots } from '../src/agent.js'
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
import { Orchestrator, runKey, type Need } from '../src/orchestrator.js'
import { outputFiles } from '../src/outputs.js'
import { Usage } from '../src/usage.js'
import { busyCores, endsInMs } from '../src/width.js'
import { join } from '../src/wire.js'
import { sealOrchestrator, secretProof } from '../src/seal.js'
import type { RunOrder } from '../src/messages.js'

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

it('an agent clears the files a task’s outputs match, links included, before it runs it', async () => {
  const from = await tmp()
  await mkdir(path.join(from, 'p/out/deep'), { recursive: true })
  await writeFile(path.join(from, 'p/out/deep/a.sh'), 'echo hi\n')
  await symlink('deep/a.sh', path.join(from, 'p/out/link'))
  await writeFile(path.join(from, 'p/out/skip.map'), '')
  expect(
    await outputFiles(from, 'p', { files: ['out/**', '!out/*.map'], workspaceFiles: [] }),
  ).toEqual(['p/out/deep/a.sh', 'p/out/link'])
})

it('an agent runs the orchestrator’s env with its own root, host names and PATH', () => {
  const saved = { HOME: process.env['HOME'], PATH: process.env['PATH'] }
  process.env['HOME'] = '/agent/home'
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
        '/agent/ws',
      ),
    ).toMatchObject({
      HOME: '/agent/home',
      PATH: '/agent/ws/node_modules/.bin:/usr/bin',
      VX_RUN_WORKSPACE: '/agent/ws',
      X: '1',
    })
  } finally {
    Object.assign(process.env, saved)
  }
})

it('an agent swaps each root once, the first pair naming it winning', () => {
  expect(
    swapRoots({ a: '/ws/p/x', b: ['/ws', '/ws2/q', '/private/ws/r'], c: 'x:/ws/b' }, [
      ['/ws', '/agent/ws'],
      ['/ws2', '/ws'],
    ]),
  ).toEqual({ a: '/agent/ws/p/x', b: ['/agent/ws', '/ws/q', '/private/ws/r'], c: 'x:/agent/ws/b' })
})

it('an agent with other tracked files than the run is refused', async () => {
  const relay = createRelay()
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => relay.fetch(r) })
  const url = `http://127.0.0.1:${server.port}`
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
    const agent = await join(url, R, 'agent', { v: 1, cores: 1, memory: 1, tree: 'bbb' }, undefined)
    let got: unknown[] = []
    for (let i = 0; i < 20 && got.length === 0; i++) got = await agent.poll()
    expect(got).toEqual([
      {
        from: 'orchestrator',
        body: { type: 'refused', reason: 'checked out tree bbb, the run is on aaa' },
      },
    ])
    await o.close()
  } finally {
    relay.close()
    await server.stop(true)
  }
})

// CI starts agents beside the orchestrator; on a warm run it can finish
// before a slow runner's agent joins, and that agent's job is not a failure.
// The relay keeps nothing of a run that ended: an agent late for it joins
// an empty run, which closes when no orchestrator joins (120 heartbeats).
it('an agent late for a run that ended exits 0', async () => {
  const relay = createRelay({ heartbeatMs: 20 })
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => relay.fetch(r) })
  const url = `http://127.0.0.1:${server.port}`
  try {
    await (await join(url, R, 'orchestrator', null, undefined)).leave()
    const code = await runAgent({
      relay: url,
      run: R,
      root: process.cwd(),
      token: async () => undefined,
      proof: { psk: async () => new Uint8Array(32), mismatch: 'no key' },
      artifacts: () => fakeArtifacts().artifacts,
    })
    expect(code).toBe(0)
  } finally {
    relay.close()
    await server.stop(true)
  }
})

// A relay restart, or silence past three heartbeats, loses the agent: its
// next poll answers 404. The run gave its tasks to others; the agent's CI
// job is no failure (mac#1 on #3895).
it('an agent the relay lost exits 0', async () => {
  let relay = createRelay()
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => relay.fetch(r) })
  const url = `http://127.0.0.1:${server.port}`
  try {
    const o = await join(url, R, 'orchestrator', null, undefined)
    const code = runAgent({
      relay: url,
      run: R,
      root: process.cwd(),
      token: async () => undefined,
      proof: { psk: async () => new Uint8Array(32), mismatch: 'no key' },
      artifacts: () => fakeArtifacts().artifacts,
    })
    for (let i = 0; i < 50 && (await o.poll()).length === 0; i++);
    relay.close()
    relay = createRelay()
    expect(await code).toBe(0)
  } finally {
    relay.close()
    await server.stop(true)
  }
})

it('gives a failed agent start one more agent, then fails the run', async () => {
  const relay = createRelay()
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => relay.fetch(r) })
  const url = `http://127.0.0.1:${server.port}`
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
      left: (id) => {
        freed.push(id)
        // As dte() does: the freed place starts the next agent.
        o.spawned(`small#${freed.length + 1}`, { size: 'small', cpu: 1, memory: 1 })
      },
    })
    o.spawned('small#1', { size: 'small', cpu: 1, memory: 1 })
    o.failed('small#1', 'install exited 1: ECONNRESET')
    o.failed('small#2', 'install exited 1: ECONNRESET')
    const run = o.execute({ taskId: 'p#t' } as Parameters<typeof o.execute>[0])
    expect([freed, await run.catch((e: Error) => e.message)]).toEqual([
      ['small#1'],
      'no agent could start: small#2 install exited 1: ECONNRESET',
    ])
    await o.close()
  } finally {
    relay.close()
    await server.stop(true)
  }
})

/** A cache by key, in memory: what agents saved, and each restore asked. */
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

/** An orchestrator on a loopback relay, and agents of it that only listen. */
async function harness(
  nodes: Map<string, TaskNode>,
  need: (id: string) => Need = () => ({ cores: 1, memory: 10 }),
  heartbeatMs?: number,
  keyOf: (id: string) => string | undefined = () => undefined,
) {
  const store = fakeArtifacts()
  const cache: { facts: CacheFacts } = { facts: { refs: [], lent: {} } }
  const relay = createRelay(heartbeatMs === undefined ? {} : { heartbeatMs })
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => relay.fetch(r) })
  const url = `http://127.0.0.1:${server.port}`
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
  })
  const agent = async (cores: number, id?: string) => {
    const me = await join(url, R, 'agent', { v: 1, cores, memory: 100, tree: 'c', id }, undefined)
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
    relay.close()
    await server.stop(true)
  }
  return { o, agent, req, stop, store, cache }
}

it('an agent reads the cache as the run does, and is lent its remotes’ access again before it ends', async () => {
  const h = await harness(new Map())
  try {
    h.cache.facts = {
      refs: ['refs/heads/feat', 'refs/heads/main'],
      lent: { '@vzn/vx-migrate': 't1' },
      expiresAt: Date.now() + 4 * 60_000 + 300,
    }
    const a = await h.agent(2)
    const got: unknown[] = []
    for (let i = 0; i < 20 && got.length < 2; i++) {
      got.push(...(await a.poll()).map((m) => m.body))
      if (got.length === 1)
        h.cache.facts = { refs: ['refs/heads/feat'], lent: { '@vzn/vx-migrate': 't2' } }
    }
    expect(got).toEqual([
      {
        type: 'welcome',
        name: 'agent#1',
        cache: {
          refs: ['refs/heads/feat', 'refs/heads/main'],
          lent: { '@vzn/vx-migrate': 't1' },
          expiresAt: expect.any(Number),
        },
        cores: 2,
        memory: 100,
      },
      { type: 'cache', cache: { refs: ['refs/heads/feat'], lent: { '@vzn/vx-migrate': 't2' } } },
    ])
  } finally {
    await h.stop()
  }
})

const node = (id: string, deps: string[] = []) =>
  [id, { id, deps, projectDir: '/ws', config: {} } as unknown as TaskNode] as const

it('fills an agent’s cores and a prefetch in one batch', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3'), node('t4')]))
  try {
    const a = await h.agent(2)
    await Bun.sleep(50)
    for (const id of ['t1', 't2', 't3', 't4']) void h.o.execute(h.req(id))
    // 2 cores and 1 of prefetch: t4 waits for one to finish.
    expect(await a.batches()).toEqual([['t1', 't2', 't3']])
    await a.finish('t1')
    expect(await a.batches()).toEqual([['t4']])
  } finally {
    await h.stop()
  }
})

// M, 2026-10-21: check.bun, ahead of 8 shards, sat in a busy agent's
// queue as its prefetch while agents that joined later stood idle.
it('a task waiting in a busy agent’s queue moves to an agent that is free', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const a = await h.agent(1)
    await Bun.sleep(50)
    for (const id of ['t1', 't2']) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['t1', 't2']])
    await a.begin('t1')
    const b = await h.agent(1)
    expect(await a.bodies()).toEqual([{ type: 'withdraw', task: 't2' }])
    // Idle while t2 comes back, b is not let go: t2 is on its way to it.
    h.o.retire(0, () => false)
    await a.say({ type: 'withdrawn', task: 't2' })
    expect(await b.batches()).toEqual([['t2']])
    // Begun already, a task stays where it is.
    await a.finish('t1')
    expect(h.o.where('t2')).toBeNull()
  } finally {
    await h.stop()
  }
})

// Growth, 2026-10-21: four local() agents of 1 core on a 4-core host each
// reported the host and took 4 tasks plus a prefetch, 16 wide on 4 cores.
it('an agent of a declared size is sent work for that size, not its machine', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3')]))
  try {
    h.o.spawned('small#1', { size: 'small', cpu: 1, memory: 100 })
    const a = await h.agent(4, 'small#1')
    await Bun.sleep(50)
    for (const id of ['t1', 't2', 't3']) void h.o.execute(h.req(id))
    // 1 core and 1 of prefetch.
    expect(await a.batches()).toEqual([['t1', 't2']])
  } finally {
    await h.stop()
  }
})

// M, 2026-10-21: 16 rows said running while 4 agents ran 4 of them; and
// an agent's cores and memory belong to the final summary only.
it('a task waits until an agent begins it; the live rows leave out its machine', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3'), node('t4')]))
  try {
    const a = await h.agent(2)
    await Bun.sleep(50)
    for (const id of ['t1', 't2', 't3', 't4']) void h.o.execute(h.req(id))
    expect(await a.batches()).toEqual([['t1', 't2', 't3']])
    expect(['t1', 't2', 't3', 't4'].map((t) => h.o.where(t))).toEqual([null, null, null, null])
    expect(h.o.where('other')).toBeUndefined()
    await a.begin('t1')
    for (let i = 0; i < 40 && h.o.where('t1') === null; i++) await Bun.sleep(25)
    expect(['t1', 't2'].map((t) => h.o.where(t))).toEqual(['agent#1', null])
    const live = JSON.stringify(h.o.footer())
    expect(live).toContain('1 running')
    expect(live).not.toMatch(/\dc\//)
  } finally {
    await h.stop()
  }
})

// An agent the rest of the run cannot keep busy leaves rather than idle
// until the run ends; one a remaining task needs for its size stays.
it('an idle agent the run no longer needs leaves; one a big task needs stays', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.agent(4)
    const b = await h.agent(2)
    await Bun.sleep(50)
    h.o.retire(0, (x) => x.cores >= 4)
    expect(await b.types()).toContain('exit')
    expect(h.o.biggestCores()).toBe(4)
    const footer = JSON.stringify(h.o.footer())
    expect(footer).toContain('left')
    h.o.retire(0, () => false)
    expect(await a.types()).toContain('exit')
    expect(h.o.biggestCores()).toBe(0)
  } finally {
    await h.stop()
  }
})

// M, 2026-10-21: an agent the run's end stopped still read `online`, and
// a size's machines were a `!` line apart from its agents.
it('the final summary says how each agent ended, its size and machine under it', async () => {
  const h = await harness(new Map([node('t1')]))
  const small = { size: 'small', cpu: 2, memory: 4e9 }
  h.o.spawned('small#1', small)
  h.o.spawned('big#1', { size: 'big', cpu: 4, memory: 4e9 })
  const a = await h.agent(2, 'small#1')
  const b = await h.agent(4, 'big#1')
  const c = await h.agent(1)
  await Bun.sleep(50)
  await c.leave()
  for (let i = 0; i < 40 && !JSON.stringify(h.o.footer()).includes('lost'); i++) await Bun.sleep(25)
  h.o.retire(0, (x) => x.cores === 2)
  expect(await b.types()).toContain('exit')
  await h.stop()
  const rows = h.o.footer().map(([, line]) => ui.inline(line, { enabled: false }))
  const at = (label: string) => rows.findIndex((r) => r.startsWith(label + ' '))
  expect(rows[at('agent#1')]).toMatch(/^agent#1 +lost/)
  expect(rows[at('small#1')]).toMatch(/^small#1 +stopped/)
  expect(rows[at('small#1') + 1]).toMatch(/^ +declared 2c\/4G · actual 2c\/0G$/)
  expect(rows[at('big#1')]).toMatch(/^big#1 +left/)
  expect(rows.some((r) => r.trimStart().startsWith('!'))).toBe(false)
  expect(rows.filter((r) => /^\S+ +online/.test(r))).toEqual([])
  // Tasks that reported no memory read `memory peak 0 B`.
  expect(rows.filter((r) => r.includes('memory peak'))).toEqual([])
  // A few hundred bytes read `0 KB`.
  expect(rows.filter((r) => r.includes(' 0 KB'))).toEqual([])
  expect(rows.some((r) => /^ +sent \d+ messages? · \d+ B, received/.test(r))).toBe(true)
  void a
})

// Live, the agents that left are one line, so the rows that run fit.
it('lists the agents that left as one line while the run goes', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.agent(4)
    const b = await h.agent(2)
    const c = await h.agent(2)
    await Bun.sleep(50)
    h.o.retire(0, (x) => x.cores >= 4)
    expect(await b.types()).toContain('exit')
    expect(await c.types()).toContain('exit')
    const rows = h.o.footer().map(([, line]) => ui.inline(line, { enabled: false }))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/^agent#1 +online/)
    expect(rows[1]).toMatch(/^2 agents +left +0 done$/)
    void a
  } finally {
    await h.stop()
  }
})

// A lost agent's begun task runs again on another, two agents at most;
// one it had not begun goes back and does not count.
it('a task lost with two agents fails naming both; one not begun goes back free', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const a = await h.agent(1)
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    const t2 = h.o.execute(h.req('t2'))
    expect(await a.batches()).toEqual([['t1', 't2']])
    await a.begin('t1')
    await Bun.sleep(50)
    await a.leave()
    const b = await h.agent(1)
    expect(await b.batches()).toEqual([['t1', 't2']])
    await b.begin('t1')
    await b.begin('t2')
    await Bun.sleep(50)
    await b.leave()
    expect(
      await t1.then(
        () => '',
        (e: Error) => e.message,
      ),
    ).toBe('t1: failed on 2 agents: agent#1 lost, agent#2 lost')
    const c = await h.agent(1)
    expect(await c.batches()).toEqual([['t2']])
    await c.finish('t2')
    expect((await t2).exitCode).toBe(0)
  } finally {
    await h.stop()
  }
})

it('an agent that could not run a task it began gets no more; two such fail it', async () => {
  const h = await harness(new Map([node('t1'), node('t2')]))
  try {
    const a = await h.agent(1)
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.say({ type: 'fault', task: 't1', reason: 'ENOSPC' })
    const b = await h.agent(1)
    expect(await b.batches()).toEqual([['t1']])
    void h.o.execute(h.req('t2'))
    expect(await b.batches()).toEqual([['t2']])
    await b.say({ type: 'fault', task: 't1', reason: 'unpack failed' })
    expect(
      await t1.then(
        () => '',
        (e: Error) => e.message,
      ),
    ).toBe('t1: failed on 2 agents: agent#1 ENOSPC, agent#2 unpack failed')
  } finally {
    await h.stop()
  }
})

it('a task an agent stops saying it holds goes back when its lease ends', async () => {
  const h = await harness(new Map([node('t1')]), undefined, 100)
  try {
    const a = await h.agent(1)
    await Bun.sleep(50)
    void h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    // One `held` lasts three of its own period, `HELD_EVERY` heartbeats
    // each: an agent says it that seldom, as each is a relay message billed.
    await a.say({ type: 'held', running: ['t1'], queued: [] })
    // Five heartbeats, polled so the relay keeps it.
    for (let i = 0; i < 5; i++) await a.poll()
    expect(h.o.where('t1')).toBe('agent#1')
    const b = await h.agent(1)
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
it('an order names its key and each dependency’s; the result comes back by the key its agent saved', async () => {
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
    const a = await h.agent(1)
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
    // Named though it holds them: the agent restores each key once.
    expect(a.orders.find((o) => o.task === 'app')!.deps.map((d) => [d.task, d.key])).toEqual([
      ['mid', runKey(R, 'mid')],
      ['lib', 'k-lib-hit'],
    ])
    const b = await h.agent(1)
    await Bun.sleep(50)
    // Another agent, with room where the first has none, is sent both.
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

it('sends a task to the agent that holds its dependency’s outputs', async () => {
  const h = await harness(new Map([node('x'), node('y', ['x'])]))
  try {
    const small = await h.agent(1)
    await Bun.sleep(50)
    const ran = h.o.execute(h.req('x'))
    expect(await small.batches()).toEqual([['x']])
    await small.finish('x')
    await ran
    const big = await h.agent(8)
    await Bun.sleep(50)
    void h.o.execute(h.req('y'))
    expect(await small.batches()).toEqual([['y']])
    void big
  } finally {
    await h.stop()
  }
})

// An agent that gave a task back had never run it, yet the orchestrator
// counted its outputs there: a dependant sent to that agent was ordered
// with no dependency to restore, and ran without its files (2026-10-22).
it('an order names every dependency, held by its agent or not', async () => {
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
    const a = await h.agent(1)
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    void h.o.execute(h.req('x', 'k-x'))
    expect(await a.batches()).toEqual([['t1', 'x']])
    await a.begin('t1')
    const b = await h.agent(1)
    expect(await a.bodies()).toEqual([{ type: 'withdraw', task: 'x' }])
    await a.say({ type: 'withdrawn', task: 'x' })
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
it('an agent restores a dependency once, before any task that needs it runs', async () => {
  const root = await tmp()
  const relay = createRelay()
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => relay.fetch(r) })
  const url = `http://127.0.0.1:${server.port}`
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
    const code = runAgent({
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
    relay.close()
    await server.stop(true)
  }
})

// A task whose outputs overlap a restored dependency's cleared its files,
// and a later task that needed them ran without them: the agent still
// counted them restored (2026-10-22).
it('an agent restores a dependency again after a task cleared its files', async () => {
  const root = await tmp()
  const relay = createRelay()
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => relay.fetch(r) })
  const url = `http://127.0.0.1:${server.port}`
  try {
    const o = sealOrchestrator(
      await join(url, R, 'orchestrator', null, undefined),
      R,
      secretProof('s'),
    )
    let restores = 0
    const code = runAgent({
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
            cores: 1,
            memory: 1e9,
          })
          await o.send(m.id!, {
            type: 'batch',
            root,
            realRoot: root,
            tasks: [order('t1', true), order('t2', false, dist), order('t3', true)],
          })
        } else if (m.type === 'end') {
          ends.push({ task: m.task!, exitCode: m.result!.exitCode })
          if (ends.length === 3) await o.send(from, { type: 'exit' })
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
    relay.close()
    await server.stop(true)
  }
})

// A stopped run whose agent was lost before it answered the cancel waited
// on that task forever (2026-10-22).
it('a task stopped while its agent is lost ends as stopped', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    const a = await h.agent(1)
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

// A run's only agent faulted on a task: no agent was left to run it, none
// was starting, and the run waited forever (2026-10-22).
it('a task its only agent could not run fails when no agent is left', async () => {
  const h = await harness(new Map([node('t1')]))
  try {
    h.o.spawned('small#1', { size: 'small', cpu: 1, memory: 100 })
    const a = await h.agent(1, 'small#1')
    await Bun.sleep(50)
    const t1 = h.o.execute(h.req('t1'))
    expect(await a.batches()).toEqual([['t1']])
    await a.say({ type: 'fault', task: 't1', reason: 'ENOSPC' })
    expect(
      await t1.then(
        () => '',
        (e: Error) => e.message,
      ),
    ).toBe('small#1 could not run t1 (ENOSPC) and no agent is left')
  } finally {
    await h.stop()
  }
}, 3_000)

// A batch for a wide agent passed the relay's 1 MiB body limit and every
// task in it failed with `413 body over 1 MiB` (2026-10-22).
it('a batch past the relay’s body limit goes in parts', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3')]))
  try {
    const a = await h.agent(3)
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

// An agent answering a cancel the run sent as it closed failed its CI job
// on the relay's `410 run closed` (2026-10-22).
it('an agent whose answer meets a closed run exits 0', async () => {
  const root = await tmp()
  const relay = createRelay()
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => relay.fetch(r) })
  const url = `http://127.0.0.1:${server.port}`
  try {
    const raw = await join(url, R, 'orchestrator', null, undefined)
    const o = sealOrchestrator(raw, R, secretProof('s'))
    const code = runAgent({
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
    relay.close()
    await server.stop(true)
  }
})

// M, 2026-10-22: agents at 30-50% CPU; "close to 100%". A task books the
// cores it keeps busy on average, so a 4-core agent takes five at 0.7.
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

it('refuses options it does not read and agents it cannot start', () => {
  const adapter = local()
  expect(refusal(() => dte({ agents: {}, adapter, relays: 'x' } as never))).toContain(
    'dte() has unknown option "relays"',
  )
  expect(refusal(() => dte({ agents: { s: { max: 1, cpu: 0, memory: '1GB' } }, adapter }))).toBe(
    "dte(): agents.s needs cpu ≥ 1, memory such as '8GB', and a whole max ≥ 0 if any",
  )
  expect(refusal(() => dte({ agents: { s: { max: 1, cpu: 1, memory: '8 lots' } }, adapter }))).toBe(
    "dte(): agents.s needs cpu ≥ 1, memory such as '8GB', and a whole max ≥ 0 if any",
  )
  expect(refusal(() => dte({}))).toBe(
    'dte(): with no adapter, set relay: the agents that join it run the tasks',
  )
  expect(refusal(() => dte({ relay: 'http://relay.test' }))).toBe('taken')
  expect(refusal(() => dte({ agents: { s: { cpu: 2, memory: '8GB' } }, adapter }))).toBe('taken')
  expect(refusal(() => local({ prepar: 'x' } as never))).toContain(
    'local() has unknown option "prepar"',
  )
  expect(refusal(() => dte({ agents: {}, adapter }))).toBe('taken')
  expect(refusal(() => docker({} as never))).toBe(
    "docker() needs image: one with Bun and git, such as 'oven/bun:1.4' plus git",
  )
})

it('a run that is not distributed loads none of it', async () => {
  // Every run evaluates `.vx/workspace.ts`: importing the plugin may not
  // load the orchestrator, the agent or the relay.
  const probe = `
const seen = []
Bun.plugin({ name: 'seen', setup(b) {
  b.onLoad({ filter: /(vx-dte|vx-dte-relay)\\/src\\/[^/]+\\.ts$/ }, async (a) => {
    seen.push(a.path.split('/').slice(-3).join('/'))
    return { contents: await Bun.file(a.path).text(), loader: 'ts' }
  })
} })
const m = await import(process.argv[1])
m.dte({ agents: {}, adapter: m.local() })
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
  ])
})

it('docker() starts each agent as a container of its size, on a fresh clone', async () => {
  const ws = await tmp()
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: ws })
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'i')
  const sha = git('rev-parse', 'HEAD').stdout.toString().trim()
  await mkdir(path.join(ws, 'sub'))
  // The root through a link, as macOS's /tmp is: git names the real path,
  // and the agent's `cd` climbed out of the clone (M's Mac, 2026-10-21).
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
      env: { VX_DTE_RUN: R, VX_DTE_AGENT: 'small#3', VX_DTE_RELAY: 'http://127.0.0.1:9' },
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
        'exec ./node_modules/.bin/vx dte agent',
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
  })
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

it('starts the cores that fit the rest of the run in its critical path, not its peak', () => {
  const graph = (entries: Array<[string, string[]]>) =>
    new Map(
      entries.map(([id, deps]) => [
        id,
        { id, deps, config: { exec: { command: 'true' } } } as unknown as TaskNode,
      ]),
    )
  const one = () => 1
  // Eight at once, all of the time.
  const wide = graph(Array.from({ length: 8 }, (_, i): [string, string[]] => [`p#t${i}`, []]))
  expect(busyCores(new Set(wide.keys()), wide, one, () => 1000)).toBe(8)
  // Four at once for a third of it, between two lone tasks: six task-seconds in three.
  const mid = graph([
    ['p#a', []],
    ...Array.from({ length: 4 }, (_, i): [string, string[]] => [`p#b${i}`, ['p#a']]),
    ['p#c', ['p#b0', 'p#b1', 'p#b2', 'p#b3']],
  ])
  expect(busyCores(new Set(mid.keys()), mid, one, () => 1000)).toBe(2)
  // Its peak, for agents that cannot come back once they leave: four.
  expect(busyCores(new Set(mid.keys()), mid, one, () => 1000, true)).toBe(4)
  // The same, the wide part long: four.
  expect(busyCores(new Set(mid.keys()), mid, one, (id) => (id.includes('#b') ? 5000 : 1000))).toBe(
    4,
  )
  // Done tasks are not laid out.
  expect(busyCores(new Set(['p#c']), mid, one, () => 1000)).toBe(1)
  // Eight short ones beside one four times as long, CI's shards beside its
  // unsafe suite: three, where the level held for half the run was one and
  // the eight queued behind it.
  const tail = graph([
    ...Array.from({ length: 8 }, (_, i): [string, string[]] => [`p#s${i}`, []]),
    ['p#u', []],
  ])
  expect(busyCores(new Set(tail.keys()), tail, one, (id) => (id === 'p#u' ? 4000 : 1000))).toBe(3)
  // Eight for 4 s, then one for 4 s: five now, but an agent that takes 5 s
  // to join finds one.
  const early = graph([
    ...Array.from({ length: 8 }, (_, i): [string, string[]] => [`p#w${i}`, []]),
    ['p#z', Array.from({ length: 8 }, (_, i) => `p#w${i}`)],
  ])
  expect([
    busyCores(new Set(early.keys()), early, one, () => 4000),
    busyCores(new Set(early.keys()), early, one, () => 4000, false, 5000),
  ]).toEqual([5, 1])
})

it('knows how long the rest of the run takes at the least, and how long an agent took to join', async () => {
  const graph = new Map(
    [
      ['p#a', []],
      ['p#b', ['p#a']],
      ['p#c', []],
    ].map(([id, deps]) => [
      id as string,
      { id, deps, config: { exec: { command: 'true' } } } as unknown as TaskNode,
    ]),
  )
  const ms = (id: string) => ({ 'p#a': 2000, 'p#b': 3000, 'p#c': 4000 })[id]
  expect(endsInMs(new Set(graph.keys()), graph, ms)).toBe(5000)
  expect(endsInMs(new Set(['p#b', 'p#c']), graph, ms)).toBe(4000)
  expect(endsInMs(new Set(), graph, ms)).toBe(0)
  const h = await harness(new Map([node('t1')]))
  try {
    expect(h.o.warmUpMs()).toBeUndefined()
    // One that joined on its own was never asked for: it says nothing.
    await h.agent(2)
    h.o.spawned('small#1', { size: 'small', cpu: 2, memory: 100 })
    await Bun.sleep(120)
    await h.agent(2, 'small#1')
    await Bun.sleep(50)
    expect(h.o.warmUpMs()).toBeGreaterThanOrEqual(100)
  } finally {
    await h.stop()
  }
})

it('gives an unmeasured task a whole agent, and one that filled its agent a bigger one', async () => {
  const whole = { cores: Infinity, memory: Infinity }
  const h = await harness(new Map([node('u1'), node('u2'), node('heavy')]), (id) =>
    id === 'heavy' ? { ...whole, above: { cores: 2, memory: 100 } } : whole,
  )
  try {
    const small = await h.agent(2)
    await Bun.sleep(50)
    // No history: alone on its agent.
    const u1 = h.o.execute(h.req('u1'))
    void h.o.execute(h.req('u2'))
    expect(await small.batches()).toEqual([['u1']])
    await small.finish('u1')
    // The run keeps where it ran and that machine's size, for the next run.
    expect(await u1).toMatchObject({ where: 'agent#1', machine: { cores: 2, memoryBytes: 100 } })
    expect(await small.batches()).toEqual([['u2']])
    await small.finish('u2')
    // It filled a 2-core agent: the idle one is passed over for the
    // bigger one starting.
    h.o.spawned('big#2', { size: 'big', cpu: 8, memory: 1000 })
    void h.o.execute(h.req('heavy'))
    await Bun.sleep(50)
    const big = await h.agent(8)
    expect(await big.batches()).toEqual([['heavy']])
  } finally {
    await h.stop()
  }
}, 30_000)

it('an agent’s reason is its error line, not the hint after it', () => {
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
