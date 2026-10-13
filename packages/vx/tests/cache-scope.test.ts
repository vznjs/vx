// `cache.scope`, end to end over an injected remote: the trusted scope reads
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
import {
  Cache,
  FULL_CACHE_POLICY,
  LayeredCache,
  type RemoteCacheLayer,
} from '../src/cache/index.js'
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
  cacheScope?: string,
): Promise<{ status: string; hash: string }> {
  await writeFile(
    path.join(fixture.root, 'vx.workspace.mjs'),
    scope === undefined
      ? `export default {}\n`
      : `export default { cache: { scope: '${scope}' } }\n`,
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
    ...(cacheScope === undefined ? {} : { cacheScope }),
  })
  expect(result.ok).toBe(true)
  const outcome = result.outcomes[0]!
  return { status: outcome.status, hash: outcome.hash! }
}

describe('cache.scope', () => {
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

  it(
    '--cache-scope wins over VX_CACHE_SCOPE and the workspace, and a bad one is refused',
    async () => {
      expect(parseRunArgs(['build', '--cache-scope', 'pr-7']).cacheScope).toBe('pr-7')
      expect(parseRunArgs(['build', '--cache-scope=pr 7']).error).toBe(
        "--cache-scope must be 'trusted', 'read-only', or a scope name of letters, digits and . _ - / @ (at most 128), like 'pr-123'",
      )
      expect(parseRunArgs(['build', '--cache-scope']).error).toContain('--cache-scope must be')
      const fixture = await makeWorkspace('vx-cache-scope-flag-')
      const { layer, store } = memoryRemote()
      const saved = process.env['VX_CACHE_SCOPE']
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        process.env['VX_CACHE_SCOPE'] = 'trusted'
        const opts = await resolveRunOptions(
          parseRunArgs(['build', '--all', '--cache-scope=pr-7']),
          fixture.root,
          ['build'],
        )
        const scope = (opts as { cacheScope?: string }).cacheScope
        expect(scope).toBe('pr-7')
        const pr = await runScoped(fixture, layer, 'trusted', 'v1', undefined, scope)
        expect(store.size).toBe(1)
        expect(store.has(pr.hash)).toBe(false)
      } finally {
        if (saved === undefined) delete process.env['VX_CACHE_SCOPE']
        else process.env['VX_CACHE_SCOPE'] = saved
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it('VX_CACHE is the spec a run takes when no --cache names one', () => {
    const saved = process.env['VX_CACHE']
    try {
      process.env['VX_CACHE'] = 'local:r,remote:'
      const off = { localRead: true, localWrite: false, remoteRead: false, remoteWrite: false }
      expect(parseRunArgs(['build']).cache).toEqual(off)
      expect(parseRunArgs(['build', '--cache=local:rw']).cache).toEqual({
        localRead: true,
        localWrite: true,
        remoteRead: true,
        remoteWrite: true,
      })
      expect(parseRunArgs(['build', '--force']).cache).toEqual({ ...off, localRead: false })
      process.env['VX_CACHE'] = 'remote:rw'
      expect(parseRunArgs(['build']).remoteRequested).toBe(true)
      process.env['VX_CACHE'] = 'disk:r'
      expect(parseRunArgs(['build']).error).toContain("VX_CACHE: invalid --cache layer 'disk'")
      process.env['VX_CACHE'] = ','
      expect(parseRunArgs(['build']).error).toContain('VX_CACHE needs a spec')
    } finally {
      if (saved === undefined) delete process.env['VX_CACHE']
      else process.env['VX_CACHE'] = saved
    }
  })

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

describe('cache.policy', () => {
  /** One run of `build` under a workspace body, from an empty local cache. */
  async function runUnder(
    fixture: Fixture,
    remote: RemoteCacheLayer,
    workspace: string,
    extra: Partial<Parameters<typeof run>[0]> = {},
  ): Promise<string> {
    await writeFile(path.join(fixture.root, 'vx.workspace.mjs'), `export default ${workspace}\n`)
    await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })
    const result = await run({
      cwd: fixture.root,
      tasks: ['build'],
      log: silentLogger(fixture),
      remoteCache: remote,
      ...extra,
    })
    expect(result.ok).toBe(true)
    return result.outcomes[0]!.status
  }

  it(
    'the workspace policy is the base: a spec beats it, --force applies on top, and naming the remote asks to write it',
    async () => {
      const fixture = await makeWorkspace('vx-cache-policy-')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const readOnly = memoryRemote()
        expect(await runUnder(fixture, readOnly.layer, `{ cache: { policy: 'remote:r' } }`)).toBe(
          'success',
        )
        expect(readOnly.store.size).toBe(0)
        // `--cache` or `VX_CACHE` hands `run()` a whole policy: the workspace's is not read.
        expect(
          await runUnder(fixture, readOnly.layer, `{ cache: { policy: 'remote:r' } }`, {
            cache: FULL_CACHE_POLICY,
          }),
        ).toBe('success')
        expect(readOnly.store.size).toBe(1)
        // --force re-executes over the remote hit and still writes nothing remote.
        const forced = memoryRemote()
        for (const [k, v] of readOnly.store) forced.store.set(k, v)
        expect(
          await runUnder(fixture, forced.layer, `{ cache: { policy: 'remote:r' } }`, {
            cacheFlags: { force: true },
          }),
        ).toBe('success')
        expect(forced.gets).toEqual([])
        // A laptop's read-only default gives way to a policy naming the remote.
        const writes = memoryRemote()
        expect(
          await runUnder(fixture, writes.layer, `{ cache: { policy: 'remote:rw' } }`, {
            defaultCacheScope: 'read-only',
          }),
        ).toBe('success')
        expect(writes.store.size).toBe(1)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a bad spec and the old cacheScope key are refused by name',
    async () => {
      const fixture = await makeWorkspace('vx-cache-policy-bad-')
      const { layer } = memoryRemote()
      const refusal = (workspace: string): Promise<string> =>
        runUnder(fixture, layer, workspace).then(
          () => 'ran',
          (err: Error) => err.message,
        )
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        expect(await refusal(`{ cache: { policy: 'local:x' } }`)).toBe(
          "vx.workspace: `cache.policy`: invalid --cache flag 'x' for 'local': expected 'r' and/or 'w'",
        )
        expect(await refusal(`{ cacheScope: 'pr-1' }`)).toContain(
          'has field "cacheScope", which vx 0.0.637 removed — use `cache: { scope }`',
        )
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it('the CLI leaves the policy to the workspace when no spec names one', () => {
    const saved = process.env['VX_CACHE']
    try {
      delete process.env['VX_CACHE']
      expect(parseRunArgs(['build']).cacheFlags).toEqual({})
      expect(parseRunArgs(['build', '--force']).cacheFlags).toEqual({ force: true })
      expect(parseRunArgs(['build', '--no-cache', '--force']).cacheFlags).toEqual({
        noCache: true,
        force: true,
      })
      expect(parseRunArgs(['build', '--cache=remote:']).cacheFlags).toBeUndefined()
      process.env['VX_CACHE'] = 'remote:'
      expect(parseRunArgs(['build']).cacheFlags).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env['VX_CACHE']
      else process.env['VX_CACHE'] = saved
    }
  })
})
