// The run-level plugin capabilities (backend / cache / executor / eventSink),
// inverted from core's hardcoded hooks in Phase 1 of
// docs/design/core-cloud-split-2026-06.md. Each test declares a VxPlugin
// in vx.workspace.mjs and asserts the seam is consulted. Nothing is applied
// by default: every e2e fixture declares the local executor + cache plugins
// AFTER its own, and the NO DEFAULTS pin below is what a bare workspace sees.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { localWorkspaceSource, writeLocalWorkspace } from './helpers/local-workspace.js'
import { run } from '../src/index.js'
import {
  resolveBackend,
  resolveCache,
  resolveExecutors,
  subscribeEventSinks,
  createEventBus,
  type RunBackend,
  type VxPlugin,
} from '../src/orchestrator/index.js'
import type { TaskExecutor } from '../src/exec/index.js'
import { busLogger } from '../src/orchestrator/events.js'
import { Cache } from '../src/cache/index.js'
import { localCachePlugin } from '../src/plugins/local-cache/index.js'
import { loadWorkspaceConfig } from '../src/workspace/index.js'

async function writeFixture(): Promise<{ workspaceRoot: string; cleanup: () => void }> {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'vx-plugin-cap-'))
  await Bun.write(
    path.join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['pkg-a'] }),
  )
  await Bun.write(path.join(workspaceRoot, 'pkg-a/package.json'), JSON.stringify({ name: 'pkg-a' }))
  await Bun.write(
    path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
    `export default { tasks: { hello: { exec: { command: 'echo hi' } } } }`,
  )
  return { workspaceRoot, cleanup: () => rmSync(workspaceRoot, { recursive: true, force: true }) }
}

async function gitInit(dir: string): Promise<void> {
  await Bun.spawn(['git', 'init', '-q'], { cwd: dir }).exited
  await Bun.spawn(['git', 'add', '-A'], { cwd: dir }).exited
  await Bun.spawn(
    ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { cwd: dir },
  ).exited
}

function makeSilentLogger(status?: (line: string) => void) {
  return {
    runStart: () => undefined,
    taskStart: () => undefined,
    taskStdout: () => undefined,
    taskStderr: () => undefined,
    taskComplete: () => undefined,
    runStatus: () => undefined,
    runEnd: () => undefined,
    status: (line: string) => status?.(line),
  }
}

// --- plugin-host unit-level consultation -------------------------------

describe('plugin-host — capability consultation + fallbacks', () => {
  const baseCtx = { workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache', warn: () => undefined }

  it('resolveBackend: first plugin backend wins over the fallback', async () => {
    const pluginBackend: RunBackend = { run: async () => ({ ok: true, outcomes: [] }) }
    const fallbackBackend: RunBackend = { run: async () => ({ ok: false, outcomes: [] }) }
    const plugins: VxPlugin[] = [{ name: 'org/be', backend: () => pluginBackend }]
    const resolved = await resolveBackend(
      plugins,
      { ...baseCtx, request: { tasks: [], cwd: '/ws' } },
      async () => fallbackBackend,
    )
    expect(resolved).toBe(pluginBackend)
  })

  it('resolveBackend: no backend plugin falls back', async () => {
    const fallbackBackend: RunBackend = { run: async () => ({ ok: true, outcomes: [] }) }
    let fallbackCalled = false
    const resolved = await resolveBackend(
      [],
      { ...baseCtx, request: { tasks: [], cwd: '/ws' } },
      async () => {
        fallbackCalled = true
        return fallbackBackend
      },
    )
    expect(fallbackCalled).toBe(true)
    expect(resolved).toBe(fallbackBackend)
  })

  it('resolveBackend: a throwing backend factory aborts with a named UserError', async () => {
    const plugins: VxPlugin[] = [
      {
        name: 'org/broken-be',
        backend: () => {
          throw new Error('be boom')
        },
      },
    ]
    await expect(
      resolveBackend(plugins, { ...baseCtx, request: { tasks: [], cwd: '/ws' } }, async () => ({
        run: async () => ({ ok: true, outcomes: [] }),
      })),
    ).rejects.toThrow(/org\/broken-be/)
  })

  it('resolveCache: first contributing plugin wins, in declaration order', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
    const local = new Cache(cacheDir, { read: true, write: true })
    const other = new Cache(mkdtempSync(path.join(tmpdir(), 'vx-cache-host2-')), {
      read: true,
      write: true,
    })
    const plugins: VxPlugin[] = [
      { name: 'org/none', cache: () => undefined },
      { name: 'org/cache', cache: () => other },
      { name: 'org/late', cache: () => local },
    ]
    try {
      const resolved = await resolveCache(plugins, {
        ...baseCtx,
        localCache: local,
        policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
      })
      expect(resolved).toBe(other)
    } finally {
      local.close()
      other.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('resolveCache: with no contributing plugin there is NO hidden fallback', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
    const local = new Cache(cacheDir, { read: true, write: true })
    try {
      await expect(
        resolveCache([{ name: 'org/none', cache: () => undefined }], {
          ...baseCtx,
          localCache: local,
          policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
        }),
      ).rejects.toThrow(/no cache plugin declared \(org\/none declined\)/)
    } finally {
      local.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('resolveCache: the declared local-cache plugin resolves to the local cache handle', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
    const local = new Cache(cacheDir, { read: true, write: true })
    try {
      const resolved = await resolveCache([localCachePlugin()], {
        ...baseCtx,
        localCache: local,
        policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
      })
      expect(resolved).toBe(local)
    } finally {
      local.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('subscribeEventSinks: a sink receives WireEvents off the bus', async () => {
    const bus = createEventBus()
    const events: string[] = []
    const plugins: VxPlugin[] = [
      { name: 'org/sink', eventSink: () => ({ onEvent: (e) => events.push(e.kind) }) },
    ]
    const subscribed = await subscribeEventSinks(plugins, bus, baseCtx)
    const log = busLogger(bus)
    log.runStart?.({ total: 1 })
    log.runEnd?.()
    subscribed.dispose()
    expect(subscribed.sinks).toHaveLength(1)
    expect(subscribed.sinks[0]!.pluginName).toBe('org/sink')
    expect(events).toContain('run:start')
    expect(events).toContain('run:end')
  })

  it('subscribeEventSinks: a throwing sink is isolated and does not break emission', async () => {
    const bus = createEventBus()
    const good: string[] = []
    const plugins: VxPlugin[] = [
      {
        name: 'org/bad-sink',
        eventSink: () => ({
          onEvent: () => {
            throw new Error('sink boom')
          },
        }),
      },
      { name: 'org/good-sink', eventSink: () => ({ onEvent: (e) => good.push(e.kind) }) },
    ]
    const subscribed = await subscribeEventSinks(plugins, bus, baseCtx)
    const log = busLogger(bus)
    expect(() => log.runStart?.({ total: 1 })).not.toThrow()
    subscribed.dispose()
    expect(good).toContain('run:start')
  })

  it('subscribeEventSinks: a throwing eventSink FACTORY is isolated (logged, not thrown)', async () => {
    const bus = createEventBus()
    const warnings: string[] = []
    const plugins: VxPlugin[] = [
      {
        name: 'org/bad-factory',
        eventSink: () => {
          throw new Error('factory boom')
        },
      },
    ]
    let subscribed: Awaited<ReturnType<typeof subscribeEventSinks>> | undefined
    await expect(
      (async () => {
        subscribed = await subscribeEventSinks(plugins, bus, {
          ...baseCtx,
          warn: (m) => warnings.push(m),
        })
      })(),
    ).resolves.toBeUndefined()
    subscribed?.dispose()
    expect(subscribed?.sinks).toHaveLength(0)
    expect(warnings.some((w) => w.includes('org/bad-factory'))).toBe(true)
  })

  it('resolveExecutors: keeps every contributed executor in declaration order', async () => {
    const a: TaskExecutor = { name: 'a', execute: () => Promise.reject(new Error('unused')) }
    const b: TaskExecutor = { name: 'b', execute: () => Promise.reject(new Error('unused')) }
    const plugins: VxPlugin[] = [
      { name: 'org/a', executor: () => a },
      { name: 'org/none', executor: () => undefined },
      { name: 'org/b', executor: async () => b },
    ]
    const resolved = await resolveExecutors(plugins, { ...baseCtx, concurrency: 4 })
    expect(resolved).toEqual([a, b])
  })

  it('resolveExecutors: a throwing executor factory aborts with a named UserError', async () => {
    const plugins: VxPlugin[] = [
      {
        name: 'org/broken-exec',
        executor: () => {
          throw new Error('exec boom')
        },
      },
    ]
    await expect(resolveExecutors(plugins, { ...baseCtx, concurrency: 1 })).rejects.toThrow(
      /org\/broken-exec.*exec boom/,
    )
  })
})

// --- end-to-end through run() / cli via vx.workspace.mjs ---------------

describe('plugin capabilities — end-to-end', () => {
  it('a cache plugin is consulted during a real run()', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      // The plugin returns ctx.localCache as its CacheLayer (a no-op
      // wrapper conceptually) and records that it was consulted.
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            `{
             name: 'org/cache',
             cache(ctx) {
               globalThis.__vxCachePluginConsulted = true
               return ctx.localCache
             },
           }`,
          ],
          `globalThis.__vxCachePluginConsulted = false
`,
        ),
      )
      await gitInit(workspaceRoot)
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: makeSilentLogger(() => {}),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect((globalThis as { __vxCachePluginConsulted?: boolean }).__vxCachePluginConsulted).toBe(
        true,
      )
    } finally {
      cleanup()
    }
  })

  it('an eventSink plugin receives WireEvents during a real run()', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            `{
             name: 'org/sink',
             eventSink() {
               return { onEvent: (e) => globalThis.__vxSinkEvents.push(e.kind) }
             },
           }`,
          ],
          `globalThis.__vxSinkEvents = []
`,
        ),
      )
      await gitInit(workspaceRoot)
      const summary = await run({
        cwd: workspaceRoot,
        projects: ['pkg-a'],
        tasks: ['hello'],
        log: makeSilentLogger(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const events = (globalThis as unknown as { __vxSinkEvents: string[] }).__vxSinkEvents
      expect(events).toContain('run:start')
      expect(events).toContain('task:start')
      expect(events).toContain('run:end')
    } finally {
      cleanup()
    }
  })

  it('a cache plugin that throws aborts the run with a named UserError', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{
             name: 'org/bad-cache',
             cache() { throw new Error('cache boom') },
           }`,
        ]),
      )
      await gitInit(workspaceRoot)
      await expect(
        run({
          cwd: workspaceRoot,
          projects: ['pkg-a'],
          tasks: ['hello'],
          log: makeSilentLogger(),
          handleSignals: false,
        }),
      ).rejects.toThrow(/org\/bad-cache/)
    } finally {
      cleanup()
    }
  })
})

// --- executor capability ----------------------------------------------

describe('executor capability — config validation', () => {
  it('accepts a plugin that contributes only `executor`', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        `export default { plugins: [{ name: 'org/exec', executor() { return undefined } }] }`,
      )
      const cfg = await loadWorkspaceConfig(workspaceRoot)
      expect(cfg?.plugins?.length).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('rejects a non-function `executor`', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        `export default { plugins: [{ name: 'org/exec', executor: 42 }] }`,
      )
      await expect(loadWorkspaceConfig(workspaceRoot)).rejects.toThrow(
        /plugins\[0\]\.executor.*function/,
      )
    } finally {
      cleanup()
    }
  })
})

describe('executor capability — end-to-end via run()', () => {
  async function runHello(workspaceRoot: string) {
    return await run({
      cwd: workspaceRoot,
      projects: ['pkg-a'],
      tasks: ['hello'],
      log: makeSilentLogger(),
      handleSignals: false,
    })
  }

  it('a declared executor runs the task and the local executor is not used', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            `{
             name: 'org/exec',
             executor() {
               return {
                 name: 'fake',
                 async execute(req) {
                   globalThis.__vxExec.push(req.taskId + ':' + req.command)
                   req.onStdout('from-fake\\n')
                   return { exitCode: 0, durationMs: 1, stdout: 'from-fake\\n', stderr: '', violations: [] }
                 },
               }
             },
           }`,
          ],
          `globalThis.__vxExec = []
`,
        ),
      )
      await gitInit(workspaceRoot)
      const summary = await runHello(workspaceRoot)
      expect(summary.ok).toBe(true)
      const seen = (globalThis as unknown as { __vxExec: string[] }).__vxExec
      expect(seen).toEqual(['pkg-a#hello:echo hi'])
    } finally {
      cleanup()
    }
  })

  it('an executor that declines a task falls through to the local executor declared after it', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            `{
             name: 'org/picky',
             executor() {
               return {
                 name: 'picky',
                 accepts(req) { globalThis.__vxDeclined.push(req.taskId); return false },
                 async execute() { throw new Error('must not run') },
               }
             },
           }`,
          ],
          `globalThis.__vxDeclined = []
`,
        ),
      )
      await gitInit(workspaceRoot)
      const summary = await runHello(workspaceRoot)
      expect(summary.ok).toBe(true)
      expect(summary.outcomes.map((o) => [o.node.id, o.exitCode])).toEqual([['pkg-a#hello', 0]])
      expect((globalThis as unknown as { __vxDeclined: string[] }).__vxDeclined).toEqual([
        'pkg-a#hello',
      ])
    } finally {
      cleanup()
    }
  })

  it('a cacheable task executed by a plugin executor is saved and replayed as a hit', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'pkg-a/vx.config.mjs'),
        `export default { tasks: { hello: {
           exec: { command: 'echo hi > out.txt' },
           cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.txt'] } },
         } } }`,
      )
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            `{
             name: 'org/exec',
             executor() {
               return {
                 name: 'fake',
                 async execute(req) {
                   globalThis.__vxCalls++
                   writeFileSync(join(req.cwd, 'out.txt'), 'made-by-fake\\n')
                   return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
                 },
               }
             },
           }`,
          ],
          `globalThis.__vxCalls = 0
         import { writeFileSync } from 'node:fs'
         import { join } from 'node:path'
`,
        ),
      )
      await gitInit(workspaceRoot)
      const first = await runHello(workspaceRoot)
      expect(first.ok).toBe(true)
      expect(first.outcomes[0]?.status).toBe('success')
      const second = await runHello(workspaceRoot)
      expect(second.ok).toBe(true)
      // `restored` is "bytes materialized this run" — false on a hit whose
      // on-disk outputs already match the snapshot — so the hit is pinned
      // by status, and the executor call count below proves it replayed.
      expect(second.outcomes[0]?.status).toBe('cache-hit')
      expect((globalThis as unknown as { __vxCalls: number }).__vxCalls).toBe(1)
      expect(await Bun.file(path.join(workspaceRoot, 'pkg-a/out.txt')).text()).toBe(
        'made-by-fake\n',
      )
    } finally {
      cleanup()
    }
  })

  it('COMPAT: a plugin that contributes `backend` delegates the whole run and no executor is consulted', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await Bun.write(
        path.join(workspaceRoot, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [
            `{
             name: 'org/cloud-like',
             backend() { return { async run() { globalThis.__vxBackendRan = true; return { ok: true, outcomes: [] } } } },
             executor() { globalThis.__vxExecutorAsked = true; return undefined },
           }`,
          ],
          `globalThis.__vxBackendRan = false
         globalThis.__vxExecutorAsked = false
`,
        ),
      )
      await gitInit(workspaceRoot)
      // `backend` is consulted by the CLI layer (src/cli/run.ts), not by
      // run() — so this pin goes through the real dispatcher, which reads
      // process.cwd() (same pattern as tests/cli.test.ts).
      const { run: cliRun } = await import('../src/cli/index.js')
      const origCwd = process.cwd()
      process.chdir(workspaceRoot)
      let code: number
      try {
        code = await cliRun(['run', 'hello', '--filter', 'pkg-a'])
      } finally {
        process.chdir(origCwd)
      }
      expect(code).toBe(0)
      const g = globalThis as unknown as { __vxBackendRan: boolean; __vxExecutorAsked: boolean }
      expect(g.__vxBackendRan).toBe(true)
      expect(g.__vxExecutorAsked).toBe(false)
    } finally {
      cleanup()
    }
  })

  // `prepareRun` resolves the cache before `run()` resolves executors, so
  // the cache message is the one a bare workspace sees; both carry the hint.
  it('NO DEFAULTS: a workspace with no plugins fails before any task runs and names the fix', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await gitInit(workspaceRoot)
      await expect(runHello(workspaceRoot)).rejects.toThrow(
        /no cache plugin declared[\s\S]*localExecutorPlugin\(\), localCachePlugin\(\)/,
      )
    } finally {
      cleanup()
    }
  })

  it('CONTROL: the same workspace with the local plugins declared runs', async () => {
    const { workspaceRoot, cleanup } = await writeFixture()
    try {
      await writeLocalWorkspace(workspaceRoot)
      await gitInit(workspaceRoot)
      const summary = await runHello(workspaceRoot)
      expect(summary.ok).toBe(true)
    } finally {
      cleanup()
    }
  })
})
