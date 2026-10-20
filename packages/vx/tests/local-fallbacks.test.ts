// Core's two fallbacks and the rule they exist for: a workspace that
// declares NO plugin still runs and still caches — here, on this machine,
// in .vx/cache. A plugin goes in FRONT of them; it is never required for a
// plain local run.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache, LayeredCache } from '../src/cache/index.js'
import { resolveCache, resolveExecutors } from '../src/orchestrator/index.js'
import { localExecutor } from '../src/exec/local-executor.js'
import { testPlugin } from './helpers/plugin.js'

const baseCtx = {
  workspaceRoot: '/ws',
  cacheDir: '/ws/.vx/cache',
  warn: () => undefined,
  scope: undefined,
  refs: [],
}
const policy = { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false }

describe('local fallbacks', () => {
  it('no plugins at all resolves to the local executor and the local cache handle', async () => {
    const list = await resolveExecutors([], { ...baseCtx, concurrency: 1 })
    expect(list.map((e) => e.name)).toEqual(['local'])
    expect(localExecutor().name).toBe('local')

    const marker = { hasRemote: false } as never
    expect(await resolveCache([], { ...baseCtx, localCache: marker, policy })).toBe(marker)
  })

  it('a plugin that declines is the same as no plugin — the fallback, not an error', async () => {
    const list = await resolveExecutors([testPlugin('org/none', { executor: () => undefined })], {
      ...baseCtx,
      concurrency: 1,
    })
    expect(list.map((e) => e.name)).toEqual(['local'])

    const dir = mkdtempSync(path.join(tmpdir(), 'vx-local-fallbacks-'))
    const local = new Cache(dir, { read: true, write: true })
    try {
      const layer = await resolveCache([testPlugin('org/none', { cache: () => undefined })], {
        ...baseCtx,
        localCache: local,
        policy,
      })
      expect(layer).toBe(local)
    } finally {
      local.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a declared executor goes IN FRONT of the fallback, not instead of it', async () => {
    const remote = { name: 'remote', execute: () => Promise.reject(new Error('unused')) }
    const list = await resolveExecutors([testPlugin('org/remote', { executor: () => remote })], {
      ...baseCtx,
      concurrency: 1,
    })
    // the tail is what a plugin executor's accepts() falls through to
    expect(list.map((e) => e.name)).toEqual(['remote', 'local'])
  })

  it('a declared remote goes BEHIND the local store, which is asked first and still saves', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-local-fallbacks-'))
    const local = new Cache(dir, { read: true, write: true })
    try {
      const remote = { has: async () => null, get: async () => null, put: async () => {} }
      const got = await resolveCache([testPlugin('org/remote', { cache: () => remote })], {
        ...baseCtx,
        localCache: local,
        policy,
      })
      expect(got).toBeInstanceOf(LayeredCache)
      expect((got as LayeredCache).local).toBe(local)
    } finally {
      local.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
