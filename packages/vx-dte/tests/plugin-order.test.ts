// The hooks in the order core calls them: the executor, its demand, then
// `schedule`, which reads the history a plan sizes workers by.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import type { TaskNode } from '@vzn/vx'
import { serveRelay } from '@vzn/vx-dte-relay'
import { dte } from '../src/index.js'

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
    await Bun.sleep(50)
    expect(spawned).toEqual([])
    await plugin.schedule!(graph, {
      workspaceRoot: root,
      cacheDir: root,
      warn,
      branch: null,
      localCache: {
        dbHandle: () => {
          throw new Error('no history')
        },
      },
      refine: () => {},
      onRefine: () => {},
      refining: async () => {},
    } as never)
    for (let i = 0; i < 40 && spawned.length === 0; i++) await Bun.sleep(25)
    expect(spawned.length).toBeGreaterThan(0)
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
