// The three run-level plugin capabilities (backend / cache / eventSink),
// inverted from core's hardcoded hooks in Phase 1 of
// docs/design/core-cloud-split-2026-06.md. Each test declares a VxPlugin
// in vx.workspace.mjs and asserts the seam is consulted, with the
// fallbacks preserving today's behavior when no plugin contributes.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { run } from '../src/index.js'
import {
  resolveBackend,
  resolveCache,
  subscribeEventSinks,
  createEventBus,
  type RunBackend,
  type VxPlugin,
} from '../src/orchestrator/index.js'
import { busLogger } from '../src/orchestrator/events.js'
import { Cache } from '../src/cache/index.js'

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

  it('resolveCache: plugin cache wins over the fallback', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
    const local = new Cache(cacheDir, { read: true, write: true })
    const pluginCache = local // local Cache implements CacheLayer
    const plugins: VxPlugin[] = [{ name: 'org/cache', cache: () => pluginCache }]
    let fallbackCalled = false
    try {
      const resolved = await resolveCache(
        plugins,
        {
          ...baseCtx,
          localCache: local,
          policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
        },
        () => {
          fallbackCalled = true
          return local
        },
      )
      expect(resolved).toBe(pluginCache)
      expect(fallbackCalled).toBe(false)
    } finally {
      local.close()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('resolveCache: no cache plugin uses the fallback', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vx-cache-host-'))
    const local = new Cache(cacheDir, { read: true, write: true })
    let fallbackCalled = false
    try {
      const resolved = await resolveCache(
        [],
        {
          ...baseCtx,
          localCache: local,
          policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
        },
        () => {
          fallbackCalled = true
          return local
        },
      )
      expect(fallbackCalled).toBe(true)
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
        `globalThis.__vxCachePluginConsulted = false
         export default {
           plugins: [{
             name: 'org/cache',
             cache(ctx) {
               globalThis.__vxCachePluginConsulted = true
               return ctx.localCache
             },
           }],
         }`,
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
        `globalThis.__vxSinkEvents = []
         export default {
           plugins: [{
             name: 'org/sink',
             eventSink() {
               return { onEvent: (e) => globalThis.__vxSinkEvents.push(e.kind) }
             },
           }],
         }`,
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
        `export default {
           plugins: [{
             name: 'org/bad-cache',
             cache() { throw new Error('cache boom') },
           }],
         }`,
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
