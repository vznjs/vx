// The hooks in the order core calls them: the executor, its demand, then
// `schedule`, which reads the history a plan sizes workers by.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { Cache, type TaskNode } from '@vzn/vx'
import { serveRelay } from '@vzn/vx-dte-server'
import { dte } from '../src/index.js'

/** A local cache whose history read fails: closed, so the read throws. */
function noHistory(root: string): Cache {
  const cache = new Cache(path.join(root, '.vx', 'cache'))
  cache.close()
  return cache
}

// Main 49adc41, 2026-10-23: the first ask came before `schedule` read
// history, booked a whole worker for each of 122 tasks, 0 measured, and
// 13 of the 14 it started were cancelled.
it('asks for no worker before schedule has read history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-order-'))
  const relay = serveRelay({ port: 0, hostname: '127.0.0.1' })
  const env = { run: process.env['VX_DTE_RUN'], secret: process.env['VX_DTE_SECRET'] }
  process.env['VX_DTE_RUN'] = crypto.randomUUID()
  process.env['VX_DTE_SECRET'] = 'order-secret'
  const spawned: string[] = []
  let reads = 0
  const plugin = dte({
    relay: relay.url,
    workers: { small: { max: 2, cpu: 1, memory: '1GB' } },
    adapter: { spawn: (a) => void spawned.push(a.id) },
  })
  try {
    await writeFile(path.join(root, 'f'), 'x')
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...args], {
        cwd: root,
      })
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'r')
    const graph = new Map(
      ['t1', 't2'].map((id) => [
        id,
        {
          id,
          deps: [],
          projectDir: root,
          config: { exec: { command: 'true' } },
        } as unknown as TaskNode,
      ]),
    )
    // Each history read fails and says so once: the count of reads.
    const warn = (m: string) => {
      if (m.startsWith('[vx] dte: tasks are packed one core each')) reads++
    }
    const ex = (await plugin.executor!({
      workspaceRoot: root,
      cacheDir: root,
      warn,
      concurrency: 1,
      artifacts: {},
      cacheFacts: () => ({}),
    } as never)) as { demand(remaining: ReadonlySet<string>, misses: ReadonlySet<string>): void }
    const ids = new Set(graph.keys())
    ex.demand(ids, ids)
    await Bun.sleep(50)
    expect(spawned).toEqual([])
    await plugin.schedule!(graph, {
      workspaceRoot: root,
      cacheDir: root,
      warn,
      branch: null,
      localCache: noHistory(root),
      refine: () => {},
      onRefine: () => {},
      refining: async () => {},
    } as never)
    for (let i = 0; i < 40 && spawned.length === 0; i++) await Bun.sleep(25)
    expect(spawned.length).toBeGreaterThan(0)
    // Read again once the refines promised landed: one that landed before
    // `onRefine` listened left the first read's empty history (main 49adc41).
    expect(reads).toBe(2)
  } finally {
    await plugin.teardown?.({} as never)
    await relay.stop()
    if (env.run === undefined) delete process.env['VX_DTE_RUN']
    else process.env['VX_DTE_RUN'] = env.run
    if (env.secret === undefined) delete process.env['VX_DTE_SECRET']
    else process.env['VX_DTE_SECRET'] = env.secret
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

// Cold run 3, 2026-10-23: one count across sizes started mac#1 first and
// M asked where small#1 was.
it('numbers workers within their size', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-order-'))
  const relay = serveRelay({ port: 0, hostname: '127.0.0.1' })
  const env = { run: process.env['VX_DTE_RUN'], secret: process.env['VX_DTE_SECRET'] }
  process.env['VX_DTE_RUN'] = crypto.randomUUID()
  process.env['VX_DTE_SECRET'] = 'order-secret'
  const spawned: string[] = []
  const plugin = dte({
    relay: relay.url,
    workers: {
      big: { max: 2, cpu: 2, memory: '2GB' },
      small: { max: 2, cpu: 1, memory: '1GB' },
    },
    adapter: { spawn: (a) => void spawned.push(a.id) },
  })
  try {
    await writeFile(path.join(root, 'f'), 'x')
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...args], {
        cwd: root,
      })
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'r')
    const graph = new Map(
      ['t1', 't2', 't3', 't4'].map((id) => [
        id,
        {
          id,
          deps: [],
          projectDir: root,
          config: { exec: { command: 'true' } },
        } as unknown as TaskNode,
      ]),
    )
    const warn = () => {}
    const ex = (await plugin.executor!({
      workspaceRoot: root,
      cacheDir: root,
      warn,
      concurrency: 1,
      artifacts: {},
      cacheFacts: () => ({}),
    } as never)) as { demand(remaining: ReadonlySet<string>, misses: ReadonlySet<string>): void }
    const ids = new Set(graph.keys())
    ex.demand(ids, ids)
    await plugin.schedule!(graph, {
      workspaceRoot: root,
      cacheDir: root,
      warn,
      branch: null,
      localCache: noHistory(root),
      refine: () => {},
      onRefine: () => {},
      refining: async () => {},
    } as never)
    for (let i = 0; i < 40 && spawned.length < 4; i++) await Bun.sleep(25)
    expect(spawned.toSorted()).toEqual(['big#1', 'big#2', 'small#1', 'small#2'])
  } finally {
    await plugin.teardown?.({} as never)
    await relay.stop()
    if (env.run === undefined) delete process.env['VX_DTE_RUN']
    else process.env['VX_DTE_RUN'] = env.run
    if (env.secret === undefined) delete process.env['VX_DTE_SECRET']
    else process.env['VX_DTE_SECRET'] = env.secret
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

// `spawn` may return void: one that threw at once escaped the plan, which
// runs in a timer, and ended the process with a stack, not the run's
// "no worker could start".
it('takes an adapter spawn that throws as a worker that could not start', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-order-'))
  const relay = serveRelay({ port: 0, hostname: '127.0.0.1' })
  const env = { run: process.env['VX_DTE_RUN'], secret: process.env['VX_DTE_SECRET'] }
  process.env['VX_DTE_RUN'] = crypto.randomUUID()
  process.env['VX_DTE_SECRET'] = 'order-secret'
  try {
    await writeFile(path.join(root, 'f'), 'x')
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...args], {
        cwd: root,
      })
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'r')
    const graph = new Map([
      ['t1', { id: 't1', deps: [], projectDir: root, config: { exec: { command: 'true' } } }],
    ]) as unknown as Map<string, TaskNode>
    const warn = () => {}
    // CONTROL: one that rejects was always heard.
    for (const sync of [false, true]) {
      const spawned: string[] = []
      const plugin = dte({
        relay: relay.url,
        workers: { small: { max: 1, cpu: 1, memory: '1GB' } },
        adapter: {
          spawn: (a) => {
            spawned.push(a.id)
            if (sync) throw new Error('no quota')
            return Promise.reject(new Error('no quota'))
          },
        },
      })
      try {
        const ex = (await plugin.executor!({
          workspaceRoot: root,
          cacheDir: root,
          warn,
          concurrency: 1,
          artifacts: {},
          cacheFacts: () => ({}),
        } as never)) as {
          demand(remaining: ReadonlySet<string>, misses: ReadonlySet<string>): void
        }
        await plugin.schedule!(graph, {
          workspaceRoot: root,
          cacheDir: root,
          warn,
          branch: null,
          localCache: noHistory(root),
          refine: () => {},
          onRefine: () => {},
          refining: async () => {},
        } as never)
        ex.demand(new Set(graph.keys()), new Set(graph.keys()))
        // A start that failed gets another go: the failure was heard.
        for (let i = 0; i < 40 && spawned.length < 2; i++) await Bun.sleep(25)
        expect({ sync, again: spawned.slice(0, 2) }).toEqual({
          sync,
          again: ['small#1', 'small#2'],
        })
      } finally {
        await plugin.teardown?.({} as never)
      }
    }
  } finally {
    await relay.stop()
    if (env.run === undefined) delete process.env['VX_DTE_RUN']
    else process.env['VX_DTE_RUN'] = env.run
    if (env.secret === undefined) delete process.env['VX_DTE_SECRET']
    else process.env['VX_DTE_SECRET'] = env.secret
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

// A worker let go before it joined that its adapter could not stop
// (github(): its job had a runner) joins all the same: the run counts it
// against its size's max again, rather than start one more beside it.
it('counts a worker its adapter left running against its size again', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-order-'))
  const relay = serveRelay({ port: 0, hostname: '127.0.0.1' })
  const env = { run: process.env['VX_DTE_RUN'], secret: process.env['VX_DTE_SECRET'] }
  process.env['VX_DTE_RUN'] = crypto.randomUUID()
  process.env['VX_DTE_SECRET'] = 'order-secret'
  const spawned: string[] = []
  const cancels: string[][] = []
  const plugin = dte({
    relay: relay.url,
    workers: { small: { max: 1, cpu: 1, memory: '1GB' } },
    adapter: {
      spawn: (a) => void spawned.push(a.id),
      cancel: async (ids) => {
        cancels.push([...ids])
        return ids
      },
    },
  })
  try {
    await writeFile(path.join(root, 'f'), 'x')
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...args], {
        cwd: root,
      })
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'r')
    const graph = new Map(
      ['t1', 't2'].map((id) => [
        id,
        {
          id,
          deps: [],
          projectDir: root,
          config: { exec: { command: 'true' } },
        } as unknown as TaskNode,
      ]),
    )
    const warn = () => {}
    const ex = (await plugin.executor!({
      workspaceRoot: root,
      cacheDir: root,
      warn,
      concurrency: 1,
      artifacts: {},
      cacheFacts: () => ({}),
    } as never)) as { demand(remaining: ReadonlySet<string>, misses: ReadonlySet<string>): void }
    await plugin.schedule!(graph, {
      workspaceRoot: root,
      cacheDir: root,
      warn,
      branch: null,
      localCache: noHistory(root),
      refine: () => {},
      onRefine: () => {},
      refining: async () => {},
    } as never)
    ex.demand(new Set(['t1']), new Set(['t1']))
    for (let i = 0; i < 40 && spawned.length === 0; i++) await Bun.sleep(25)
    expect(spawned).toEqual(['small#1'])
    // Its work gone before it joined (a task of no project here is none): let go.
    ex.demand(new Set(['elsewhere']), new Set())
    for (let i = 0; i < 40 && cancels.length === 0; i++) await Bun.sleep(25)
    expect(cancels).toEqual([['small#1']])
    await Bun.sleep(100)
    ex.demand(new Set(['t2', 'elsewhere']), new Set(['t2']))
    await Bun.sleep(200)
    expect({ spawned, cancels }).toEqual({ spawned: ['small#1'], cancels: [['small#1']] })
  } finally {
    await plugin.teardown?.({} as never)
    await relay.stop()
    if (env.run === undefined) delete process.env['VX_DTE_RUN']
    else process.env['VX_DTE_RUN'] = env.run
    if (env.secret === undefined) delete process.env['VX_DTE_SECRET']
    else process.env['VX_DTE_SECRET'] = env.secret
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
