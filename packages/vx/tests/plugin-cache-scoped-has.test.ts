// With a scope set, ctx.cache.hasMany keyed its answer by the scoped key but
// asked the local store by the unscoped one, so a name the local store holds
// came back as undefined (and was asked of the remote again).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { Cache, pluginCache, type RemoteCacheLayer } from '../src/cache/index.js'

const FULL = { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true }
const dirs: string[] = []
const caches: Cache[] = []
afterEach(() => {
  for (const c of caches.splice(0)) c.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

it('a scoped hasMany names the entry the local store holds', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vx-scoped-has-'))
  dirs.push(dir)
  const local = new Cache(dir, { read: true, write: true })
  caches.push(local)
  const remote: RemoteCacheLayer = {
    has: async () => null,
    get: async () => null,
    put: async () => {},
    hasMany: async () => new Map(),
  }
  const c = pluginCache('org/a', {
    db: local.dbHandle(),
    policy: FULL,
    remotes: [{ remote, read: true, write: true }],
    scope: 'pr-1',
  })
  await c.put('x', new TextEncoder().encode('kept'))
  expect(await c.has('x')).toBe(true)
  expect([...((await c.hasMany(['x'])) ?? [])]).toEqual(['x'])
})
