// `cacheScope`, end to end over an injected remote: the trusted scope reads
// and writes the task key; an untrusted scope reads its own key, then
// the trusted one, and writes only its own; `read-only` writes nothing.

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  addProject,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import { Cache, LayeredCache, type RemoteCacheLayer } from '../src/cache/index.js'
import { parseRunArgs, resolveRunOptions } from '../src/cli/run.js'
import { run } from '../src/orchestrator/index.js'

const BUILD_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'cat src/in.txt > out.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
      },
    },
  }
`

function memoryRemote(): {
  layer: RemoteCacheLayer
  store: Map<string, Uint8Array>
  gets: string[]
} {
  const store = new Map<string, Uint8Array>()
  const gets: string[] = []
  const layer: RemoteCacheLayer = {
    async has(hash) {
      return store.has(hash)
    },
    async hasMany(hashes) {
      return new Set(hashes.filter((h) => store.has(h)))
    },
    async get(hash) {
      gets.push(hash)
      const bytes = store.get(hash)
      return bytes === undefined ? null : { body: new Blob([bytes]), durationMs: undefined }
    },
    async put(hash, body) {
      store.set(hash, new Uint8Array(await body.arrayBuffer()))
    },
  }
  return { layer, store, gets }
}

async function runScoped(
  fixture: Fixture,
  remote: RemoteCacheLayer,
  scope: string | undefined,
  input: string,
  defaultCacheScope?: string,
): Promise<{ status: string; hash: string }> {
  await writeFile(
    path.join(fixture.root, 'vx.workspace.mjs'),
    scope === undefined ? `export default {}\n` : `export default { cacheScope: '${scope}' }\n`,
  )
  await writeFile(path.join(fixture.root, 'packages/app/src/in.txt'), input)
  // Only the remote may answer: every run starts from an empty local cache.
  await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })
  const result = await run({
    cwd: fixture.root,
    tasks: ['build'],
    log: silentLogger(fixture),
    remoteCache: remote,
    ...(defaultCacheScope === undefined ? {} : { defaultCacheScope }),
  })
  expect(result.ok).toBe(true)
  const outcome = result.outcomes[0]!
  return { status: outcome.status, hash: outcome.hash! }
}

describe('cacheScope', () => {
  it(
    'a scope reads the trusted keys and its own, and writes only its own',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-')
      const { layer, store, gets } = memoryRemote()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })

        const main = await runScoped(fixture, layer, undefined, 'v1')
        expect(main.status).toBe('success')
        expect([...store.keys()]).toEqual([main.hash])

        // A PR reads what the default branch wrote, asking its own scope first.
        gets.length = 0
        expect((await runScoped(fixture, layer, 'pr-1', 'v1')).status).toBe('cache-hit-remote')
        // The trusted GET answers; the scope's may come first when the GET
        // beats the batch probe (the unit row below holds the skip).
        expect(gets.at(-1)).toBe(main.hash)
        expect(gets.length).toBeLessThanOrEqual(2)

        // Its own work lands beside the trusted key, never under it.
        const pr = await runScoped(fixture, layer, 'pr-1', 'v2')
        expect(pr.status).toBe('success')
        expect(store.size).toBe(2)
        expect(store.has(pr.hash)).toBe(false)

        // The same scope reads it back; another scope and trusted do not.
        gets.length = 0
        expect((await runScoped(fixture, layer, 'pr-1', 'v2')).status).toBe('cache-hit-remote')
        // Its own scope is asked first: one GET, not under the task key.
        expect(gets.length).toBe(1)
        expect(gets[0]).not.toBe(pr.hash)
        expect((await runScoped(fixture, layer, 'pr-2', 'v2')).status).toBe('success')
        expect(store.size).toBe(3)
        const trusted = await runScoped(fixture, layer, 'trusted', 'v2')
        expect(trusted.status).toBe('success')
        expect(trusted.hash).toBe(pr.hash)
        expect(store.has(pr.hash)).toBe(true)
        expect(store.size).toBe(4)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'read-only reads the trusted keys and writes nothing',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-ro-')
      const { layer, store } = memoryRemote()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        await runScoped(fixture, layer, undefined, 'v1')
        expect(store.size).toBe(1)
        expect((await runScoped(fixture, layer, 'read-only', 'v1')).status).toBe('cache-hit-remote')
        expect((await runScoped(fixture, layer, 'read-only', 'v2')).status).toBe('success')
        expect(store.size).toBe(1)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a default scope applies only when the workspace names none',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-default-')
      const { layer, store } = memoryRemote()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        expect((await runScoped(fixture, layer, undefined, 'v1', 'read-only')).status).toBe(
          'success',
        )
        expect(store.size).toBe(0)
        expect((await runScoped(fixture, layer, 'trusted', 'v1', 'read-only')).status).toBe(
          'success',
        )
        expect(store.size).toBe(1)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it('the CLI defaults to read-only off CI, unless --cache names the remote', async () => {
    const fixture = await makeWorkspace('vx-cache-scope-cli-')
    const saved = process.env['CI']
    const scopeOf = async (args: string[], ci: string | undefined): Promise<unknown> => {
      if (ci === undefined) delete process.env['CI']
      else process.env['CI'] = ci
      const opts = await resolveRunOptions(parseRunArgs(args), fixture.root, ['build'])
      return (opts as { defaultCacheScope?: unknown }).defaultCacheScope
    }
    try {
      await addProject(fixture.root, 'app', { files: { 'src/in.txt': 'v1' }, config: BUILD_CONFIG })
      expect(await scopeOf(['build', '--all'], undefined)).toBe('read-only')
      expect(await scopeOf(['build', '--all'], 'false')).toBe('read-only')
      expect(await scopeOf(['build', '--all'], 'true')).toBeUndefined()
      expect(await scopeOf(['build', '--all', '--cache=remote:rw'], undefined)).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env['CI']
      else process.env['CI'] = saved
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it(
    'VX_CACHE_SCOPE wins over the workspace, and a bad one is refused',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-env-')
      const { layer, store } = memoryRemote()
      const saved = process.env['VX_CACHE_SCOPE']
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        process.env['VX_CACHE_SCOPE'] = 'pr-9'
        const pr = await runScoped(fixture, layer, 'trusted', 'v1')
        expect(store.size).toBe(1)
        expect(store.has(pr.hash)).toBe(false)
        process.env['VX_CACHE_SCOPE'] = 'pr 9'
        const refused = await runScoped(fixture, layer, 'trusted', 'v1').then(
          () => 'ran',
          (err: Error) => err.message,
        )
        expect(refused).toBe(
          "VX_CACHE_SCOPE must be 'trusted', 'read-only', or a scope name of letters, digits and . _ - / @ (at most 128), like 'pr-123'",
        )
      } finally {
        if (saved === undefined) delete process.env['VX_CACHE_SCOPE']
        else process.env['VX_CACHE_SCOPE'] = saved
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it('a batch probe that found only the trusted key skips the scope GET', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-scope-unit-'))
    const { layer, store, gets } = memoryRemote()
    const key = '0123456789abcdef'
    // Not an artifact: the ingest refuses it, and only the GETs are counted.
    store.set(key, new Uint8Array([1, 2, 3]))
    const local = new Cache(path.join(dir, 'cache'))
    try {
      const layered = new LayeredCache(local, layer, {
        policy: {
          localRead: true,
          localWrite: true,
          remoteRead: true,
          remoteWrite: true,
          remoteScope: 'pr-1',
        },
        onRemoteError: () => {},
      })
      expect(await layered.remoteHasMany([key])).toEqual(new Set([key]))
      await layered.get(key)
      expect(gets).toEqual([key])
    } finally {
      local.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it(
    'a failed scope lookup falls through to the trusted key',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-fallthrough-')
      const { layer, store } = memoryRemote()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const main = await runScoped(fixture, layer, undefined, 'v1')
        // Only the scope's keys fail: the trusted hit is there to be found.
        const refuse = (hash: string): void => {
          if (hash !== main.hash) throw new Error('scope key unavailable')
        }
        const flaky: RemoteCacheLayer = {
          has: async (hash) => (refuse(hash), layer.has(hash)),
          get: async (hash) => (refuse(hash), layer.get(hash)),
          put: layer.put,
        }
        expect((await runScoped(fixture, flaky, 'pr-1', 'v1')).status).toBe('cache-hit-remote')
        expect(store.size).toBe(1)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it('a failed scope lookup still warns when the trusted key misses too', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-scope-warn-'))
    const key = '0123456789abcdef'
    const errors: string[] = []
    let trustedDown = false
    const remote: RemoteCacheLayer = {
      async has(hash) {
        if (hash !== key) throw new Error('scope down')
        return false
      },
      async get(hash) {
        if (hash !== key) throw new Error('scope down')
        if (trustedDown) throw new Error('trusted down')
        return null
      },
      async put() {},
    }
    const local = new Cache(path.join(dir, 'cache'))
    const layered = (): LayeredCache =>
      new LayeredCache(local, remote, {
        policy: {
          localRead: true,
          localWrite: true,
          remoteRead: true,
          remoteWrite: true,
          remoteScope: 'pr-1',
        },
        onRemoteError: (err) => errors.push(err.message),
      })
    try {
      expect(await layered().has(key)).toBeNull()
      expect(await layered().get(key)).toBeNull()
      expect(errors).toEqual([
        expect.stringContaining('scope down'),
        expect.stringContaining('scope down'),
      ])
      errors.length = 0
      trustedDown = true
      expect(await layered().get(key)).toBeNull()
      expect(errors).toEqual([expect.stringContaining('scope down')])
    } finally {
      local.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
