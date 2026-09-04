// The two core-provided plugins under src/plugins/ and the no-defaults rule
// they exist for: nothing is applied unless declared, and a list with no
// executor or no cache provider fails fast naming the lines to add.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { MISSING_PLUGIN_HINT, resolveCache, resolveExecutors } from '../src/orchestrator/index.js'
import { LOCAL_CACHE_PLUGIN, localCachePlugin } from '../src/plugins/local-cache/index.js'
import {
  LOCAL_EXECUTOR_PLUGIN,
  localExecutor,
  localExecutorPlugin,
} from '../src/plugins/local-executor/index.js'

const baseCtx = { workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache', warn: () => undefined }
const policy = { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false }

describe('local plugins', () => {
  it('each plugin is named under vx/ and contributes exactly one capability', () => {
    const e = localExecutorPlugin()
    const c = localCachePlugin()
    expect(e.name).toBe(LOCAL_EXECUTOR_PLUGIN)
    expect(typeof e.executor).toBe('function')
    expect(e.cache).toBeUndefined()
    expect(c.name).toBe(LOCAL_CACHE_PLUGIN)
    expect(typeof c.cache).toBe('function')
    expect(c.executor).toBeUndefined()
  })

  it('the hint shows the exact lines to add, with the subpath imports', () => {
    expect(MISSING_PLUGIN_HINT).toContain("from '@vzn/vx/plugins/local-executor'")
    expect(MISSING_PLUGIN_HINT).toContain("from '@vzn/vx/plugins/local-cache'")
    expect(MISSING_PLUGIN_HINT).toContain('plugins: [localExecutorPlugin(), localCachePlugin()]')
  })

  it('the local executor plugin resolves to the local executor; the cache plugin hands back the host handle', async () => {
    const list = await resolveExecutors([localExecutorPlugin()], { ...baseCtx, concurrency: 1 })
    expect(list.map((x) => x.name)).toEqual(['local'])
    expect(localExecutor().name).toBe('local')
    const marker = { hasRemote: false } as never
    const layer = await localCachePlugin().cache!({ ...baseCtx, localCache: marker, policy })
    expect(layer).toBe(marker)
  })

  it('resolveExecutors with NO executor plugin fails fast and names the fix', async () => {
    await expect(resolveExecutors([], { ...baseCtx, concurrency: 1 })).rejects.toThrow(
      /no executor plugin declared[\s\S]*localExecutorPlugin\(\)/,
    )
    await expect(
      resolveExecutors([{ name: 'org/none', executor: () => undefined }], {
        ...baseCtx,
        concurrency: 1,
      }),
    ).rejects.toThrow(/no executor plugin declared[\s\S]*org\/none declined/)
  })

  it('with no workspace file at all, the error leads with `vx init`; with one, it does not', async () => {
    await expect(
      resolveExecutors([], { ...baseCtx, concurrency: 1 }, { workspaceFile: false }),
    ).rejects.toThrow(
      /^no vx\.workspace\.ts found — run `vx init`[\s\S]*no executor plugin declared/,
    )
    await expect(
      resolveCache([], { ...baseCtx, localCache: {} as never, policy }, { workspaceFile: false }),
    ).rejects.toThrow(/^no vx\.workspace\.ts found — run `vx init`[\s\S]*no cache plugin declared/)
    // A workspace file that declares nothing is not an init case (init would
    // refuse to overwrite it): the plain error, snippet included.
    await expect(
      resolveExecutors([], { ...baseCtx, concurrency: 1 }, { workspaceFile: true }),
    ).rejects.toThrow(/^no executor plugin declared/)
  })

  it('resolveExecutors with the local plugin declared resolves to the local executor (control)', async () => {
    const list = await resolveExecutors([localExecutorPlugin()], { ...baseCtx, concurrency: 1 })
    expect(list.map((e) => e.name)).toEqual(['local'])
  })

  it('resolveCache with NO cache plugin fails fast and names the fix', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-local-plugins-'))
    const local = new Cache(dir, { read: true, write: true })
    try {
      await expect(resolveCache([], { ...baseCtx, localCache: local, policy })).rejects.toThrow(
        /no cache plugin declared[\s\S]*localCachePlugin\(\)/,
      )
      await expect(
        resolveCache([{ name: 'org/none', cache: () => undefined }], {
          ...baseCtx,
          localCache: local,
          policy,
        }),
      ).rejects.toThrow(/no cache plugin declared \(org\/none declined\)/)
    } finally {
      local.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
