// `cache.scope`, end to end over an injected remote: a run with none reads
// and writes the default keys; a scope reads the default key, then its own,
// and writes only its own. The policy alone decides whether anything is
// written (owner, 2026-10-14).

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
import { Cache, FULL_CACHE_POLICY, type RemoteCacheLayer, ScopedCache } from '../src/cache/index.js'
import { scopedKey } from '../src/cache/scoped-cache.js'
import { parseRunArgs, resolveRunOptions } from '../src/cli/run.js'
import { run } from './helpers/orchestrator.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { layeredOver } from './helpers/layered.js'

const BUILD_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'cat src/in.txt > out.txt' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
  remoteReadOnlyByDefault?: boolean,
  cacheScope?: string,
): Promise<{ status: string; hash: string }> {
  await Bun.write(
    path.join(fixture.root, '.vx/workspace.mjs'),
    scope === undefined
      ? `export default {}\n`
      : `export default { cache: { scope: '${scope}' } }\n`,
  )
  await writeFile(path.join(fixture.root, 'packages/app/src/in.txt'), input)
  // Only the remote may answer: every run starts from an empty local cache.
  await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
  const result = await run({
    cwd: fixture.root,
    tasks: ['build'],
    log: silentLogger(fixture),
    remoteCache: remote,
    ...(remoteReadOnlyByDefault === undefined ? {} : { remoteReadOnlyByDefault }),
    ...(cacheScope === undefined ? {} : { cacheScope }),
  })
  expect(result.ok).toBe(true)
  const outcome = result.outcomes[0]!
  return { status: outcome.status, hash: outcome.hash! }
}

describe('cache.scope', () => {
  for (const batches of [true, false]) {
    it(
      `a forced scoped run asks for the scope keys ${batches ? 'in one hasMany' : 'per key with has'} and sends none the remote holds`,
      async () => {
        const fixture = await makeWorkspace('vx-cache-scope-force-')
        try {
          await addProject(fixture.root, 'app', {
            files: { 'src/in.txt': 'v1' },
            config: BUILD_CONFIG,
          })
          const remote = memoryRemote()
          const seeded = await runScoped(fixture, remote.layer, 'pr-1', 'v1')
          expect([...remote.store.keys()]).toEqual([scopedKey('pr-1', seeded.hash)])
          const batched: string[] = []
          const single: string[] = []
          const puts: string[] = []
          const layer: RemoteCacheLayer = {
            get: remote.layer.get,
            async has(hash) {
              single.push(hash)
              return remote.layer.has(hash)
            },
            async put(hash, body, meta) {
              puts.push(hash)
              return remote.layer.put(hash, body, meta)
            },
          }
          if (batches)
            layer.hasMany = async (hashes) => {
              batched.push(hashes.join(','))
              return remote.layer.hasMany!(hashes)
            }
          const forced = await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: layer,
            cacheFlags: { force: true },
          })
          expect(forced.outcomes[0]!.status).toBe('success')
          expect(puts).toEqual([])
          const key = scopedKey('pr-1', seeded.hash)
          expect({ batched, single }).toEqual(
            batches ? { batched: [key], single: [] } : { batched: [], single: [key] },
          )
        } finally {
          await rm(fixture.root, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )
  }

  it(
    'the footer says what each layer restored and saved (M, 2026-10-15)',
    async () => {
      const fixture = await makeWorkspace('vx-cache-footer-uploads-')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const { layer } = memoryRemote()
        await runScoped(fixture, layer, undefined, 'v1')
        const legend = (): string =>
          fixture.log[fixture.log.findIndex((l) => l.startsWith('  cache')) + 1]!.trim()
        // Each task counts once, under its strongest state: saved here and uploaded is `remote ↑`.
        expect(legend()).toBe('remote 1↑')
        fixture.log.length = 0
        await runScoped(fixture, layer, undefined, 'v1')
        expect(legend()).toBe('remote 1↓')
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it.each([undefined, 'pr-1'])(
    'a run the local cache answers asks the remote nothing (scope %p; M, 2026-10-15)',
    async (scope) => {
      const fixture = await makeWorkspace('vx-cache-warm-local-')
      const { layer } = memoryRemote()
      const calls: string[] = []
      const counted: RemoteCacheLayer = {
        has: (h) => (calls.push('has'), layer.has(h)),
        hasMany: (h) => (calls.push('hasMany'), layer.hasMany!(h)),
        get: (h) => (calls.push('get'), layer.get(h)),
        put: (h, b, m) => layer.put(h, b, m),
      }
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        await Bun.write(
          path.join(fixture.root, '.vx/workspace.mjs'),
          scope === undefined
            ? `export default {}\n`
            : `export default { cache: { scope: '${scope}' } }\n`,
        )
        const once = () =>
          run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: counted,
            remoteReadOnlyByDefault: false,
          })
        expect((await once()).outcomes[0]!.status).toBe('success')
        calls.length = 0
        expect((await once()).outcomes[0]!.status).toBe('cache-hit')
        expect(calls).toEqual([])
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a scope reads the default keys, then its own, and writes only its own',
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

        // A PR reads what the default branch wrote, under the default key first.
        gets.length = 0
        expect((await runScoped(fixture, layer, 'pr-1', 'v1')).status).toBe('cache-hit-remote')
        expect(gets).toEqual([main.hash])

        // Its own work lands beside the default key, never under it.
        const pr = await runScoped(fixture, layer, 'pr-1', 'v2')
        expect(pr.status).toBe('success')
        expect(store.size).toBe(2)
        expect(store.has(pr.hash)).toBe(false)

        // The same scope reads it back; another scope and none do not.
        gets.length = 0
        expect((await runScoped(fixture, layer, 'pr-1', 'v2')).status).toBe('cache-hit-remote')
        // The scope's key serves; the default GET comes first unless the
        // batch probe already found the scope's key alone (the unit row below).
        expect(gets.at(-1)).not.toBe(pr.hash)
        expect(gets.length).toBeLessThanOrEqual(2)
        expect((await runScoped(fixture, layer, 'pr-2', 'v2')).status).toBe('success')
        expect(store.size).toBe(3)
        const plain = await runScoped(fixture, layer, undefined, 'v2')
        expect(plain.status).toBe('success')
        expect(plain.hash).toBe(pr.hash)
        expect(store.has(pr.hash)).toBe(true)
        expect(store.size).toBe(4)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'off CI the remote is read and not written, whatever the scope',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-default-')
      const { layer, store } = memoryRemote()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        expect((await runScoped(fixture, layer, undefined, 'v1', true)).status).toBe('success')
        expect((await runScoped(fixture, layer, 'pr-1', 'v1', true)).status).toBe('success')
        expect(store.size).toBe(0)
        await runScoped(fixture, layer, undefined, 'v1')
        expect(store.size).toBe(1)
        expect((await runScoped(fixture, layer, 'pr-1', 'v1', true)).status).toBe(
          'cache-hit-remote',
        )
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it('the CLI turns remote writes off off CI, unless --cache-policy names the remote', async () => {
    const fixture = await makeWorkspace('vx-cache-scope-cli-')
    const saved = process.env['CI']
    const scopeOf = async (args: string[], ci: string | undefined): Promise<unknown> => {
      if (ci === undefined) delete process.env['CI']
      else process.env['CI'] = ci
      const opts = await resolveRunOptions(parseRunArgs(args), fixture.root, ['build'])
      return (opts as { remoteReadOnlyByDefault?: unknown }).remoteReadOnlyByDefault
    }
    try {
      await addProject(fixture.root, 'app', { files: { 'src/in.txt': 'v1' }, config: BUILD_CONFIG })
      expect(await scopeOf(['build', '--all'], undefined)).toBe(true)
      expect(await scopeOf(['build', '--all'], 'false')).toBe(true)
      expect(await scopeOf(['build', '--all'], 'true')).toBeUndefined()
      expect(
        await scopeOf(['build', '--all', '--cache-policy=remote:rw'], undefined),
      ).toBeUndefined()
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
        const pr = await runScoped(fixture, layer, 'pr-1', 'v1')
        expect(store.size).toBe(1)
        expect(store.has(pr.hash)).toBe(false)
        delete process.env['VX_CACHE_SCOPE']
        // Written under pr-9's key: pr-9 reads it back.
        expect((await runScoped(fixture, layer, 'pr-9', 'v1')).status).toBe('cache-hit-remote')
        process.env['VX_CACHE_SCOPE'] = 'pr 9'
        const refused = await runScoped(fixture, layer, undefined, 'v1').then(
          () => 'ran',
          (err: Error) => err.message,
        )
        expect(refused).toBe(
          "VX_CACHE_SCOPE must be a scope name of letters, digits and . _ - / @ (at most 128), like 'pr-123'",
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
        "--cache-scope must be a scope name of letters, digits and . _ - / @ (at most 128), like 'pr-123'",
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
        process.env['VX_CACHE_SCOPE'] = 'pr-1'
        const opts = await resolveRunOptions(
          parseRunArgs(['build', '--all', '--cache-scope=pr-7']),
          fixture.root,
          ['build'],
        )
        const scope = (opts as { cacheScope?: string }).cacheScope
        expect(scope).toBe('pr-7')
        const pr = await runScoped(fixture, layer, undefined, 'v1', undefined, scope)
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

  it('VX_CACHE_POLICY is the spec a run takes when no --cache-policy names one', () => {
    const saved = process.env['VX_CACHE_POLICY']
    try {
      process.env['VX_CACHE_POLICY'] = 'local:r,remote:'
      const off = { localRead: true, localWrite: false, remoteRead: false, remoteWrite: false }
      expect(parseRunArgs(['build']).cache).toEqual(off)
      expect(parseRunArgs(['build', '--cache-policy=local:rw']).cache).toEqual({
        localRead: true,
        localWrite: true,
        remoteRead: true,
        remoteWrite: true,
      })
      expect(parseRunArgs(['build', '--force']).cache).toEqual({ ...off, localRead: false })
      process.env['VX_CACHE_POLICY'] = 'remote:rw'
      expect(parseRunArgs(['build']).remoteRequested).toBe(true)
      process.env['VX_CACHE_POLICY'] = 'disk:r'
      expect(parseRunArgs(['build']).error).toContain("VX_CACHE_POLICY: invalid layer 'disk'")
      process.env['VX_CACHE_POLICY'] = ','
      expect(parseRunArgs(['build']).error).toContain('VX_CACHE_POLICY needs a spec')
    } finally {
      if (saved === undefined) delete process.env['VX_CACHE_POLICY']
      else process.env['VX_CACHE_POLICY'] = saved
    }
  })

  it('a batch probe that found only the scope key skips the default GET', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-scope-unit-'))
    const key = '0123456789abcdef'
    const gets: string[] = []
    // Every key but the task key is there: only the scope's key answers.
    // Not an artifact: the ingest refuses it, and only the GETs are counted.
    const remote: RemoteCacheLayer = {
      has: async (hash) => hash !== key,
      hasMany: async (hashes) => new Set(hashes.filter((h) => h !== key)),
      async get(hash) {
        gets.push(hash)
        return hash === key
          ? null
          : { body: new Blob([new Uint8Array([1])]), durationMs: undefined }
      },
      async put() {},
    }
    const local = new Cache(path.join(dir, 'cache'))
    try {
      const layered = new ScopedCache(
        layeredOver(local, remote, { policy: FULL_CACHE_POLICY, onRemoteError: () => {} }),
        'pr-1',
      )
      expect(await layered.remoteHasMany!([key])).toEqual(new Set([key]))
      await layered.get(key)
      expect(gets).toHaveLength(1)
      expect(gets[0]).not.toBe(key)
    } finally {
      local.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it(
    'a failed default lookup falls through to the scope key',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-fallthrough-')
      const { layer, store } = memoryRemote()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const pr = await runScoped(fixture, layer, 'pr-1', 'v1')
        // Only the default key fails: the scope's hit is there to be found.
        const refuse = (hash: string): void => {
          if (hash === pr.hash) throw new Error('default key unavailable')
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

  it(
    'a refused default artifact falls through to the scope key (Security F6)',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-f6-')
      const { layer, store } = memoryRemote()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const pr = await runScoped(fixture, layer, 'pr-1', 'v1')
        // A partial upload under the default key: the GET answers, the ingest refuses it.
        store.set(pr.hash, new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0]))
        expect((await runScoped(fixture, layer, 'pr-1', 'v1')).status).toBe('cache-hit-remote')
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it('a failed lookup warns, and the scope key is still asked', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-scope-warn-'))
    const key = '0123456789abcdef'
    const errors: string[] = []
    let scopeDown = false
    const remote: RemoteCacheLayer = {
      async has(hash) {
        if (hash === key) throw new Error('default down')
        return false
      },
      async get(hash) {
        if (hash === key) throw new Error('default down')
        if (scopeDown) throw new Error('scope down')
        return null
      },
      async put() {},
    }
    const local = new Cache(path.join(dir, 'cache'))
    const layered = (): ScopedCache =>
      new ScopedCache(
        layeredOver(local, remote, {
          policy: FULL_CACHE_POLICY,
          onRemoteError: (err) => errors.push(err.message),
        }),
        'pr-1',
      )
    try {
      expect(await layered().has(key)).toBeNull()
      expect(await layered().get(key)).toBeNull()
      expect(errors).toEqual([
        expect.stringContaining('default down'),
        expect.stringContaining('default down'),
      ])
      errors.length = 0
      scopeDown = true
      expect(await layered().get(key)).toBeNull()
      expect(errors).toEqual([
        expect.stringContaining('default down'),
        expect.stringContaining('scope down'),
      ])
    } finally {
      local.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it(
    'a local entry another scope saved is a miss (Security F4)',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-f4-')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        await Bun.write(path.join(fixture.root, '.vx/workspace.mjs'), `export default {}\n`)
        // One disk, no remote: a persistent runner or a laptop switching scopes.
        const status = async (cacheScope?: string): Promise<string> => {
          const r = await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            ...(cacheScope === undefined ? {} : { cacheScope }),
          })
          expect(r.ok).toBe(true)
          return r.outcomes[0]!.status
        }
        expect(await status('pr-1')).toBe('success')
        expect(await status('pr-1')).toBe('cache-hit')
        expect(await status('pr-2')).toBe('success')
        expect(await status()).toBe('success')
        // An unscoped entry serves every scope, as a scope reads the default keys first.
        expect(await status('pr-1')).toBe('cache-hit')
        expect(await status()).toBe('cache-hit')
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe("a cache plugin sees the run's scope", () => {
  it(
    'none is undefined; a named scope reaches the hook as given',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-hook-')
      const seen = path.join(fixture.root, 'seen.txt')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const hook = `{ cache(ctx) { require('node:fs').appendFileSync(${JSON.stringify(seen)}, String(ctx.scope) + '\\n') } }`
        await Bun.write(
          path.join(fixture.root, '.vx/workspace.mjs'),
          `${PLUGIN_IMPORT}export default { plugins: [${pluginSource('org/scope-probe', hook)}] }\n`,
        )
        for (const cacheScope of [undefined, 'pr-9']) {
          const r = await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            ...(cacheScope === undefined ? {} : { cacheScope }),
          })
          expect(r.ok).toBe(true)
        }
        expect(await Bun.file(seen).text()).toBe('undefined\npr-9\n')
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('cache.policy', () => {
  /** One run of `build` under a workspace body, from an empty local cache. */
  async function runUnder(
    fixture: Fixture,
    remote: RemoteCacheLayer,
    workspace: string,
    extra: Partial<Parameters<typeof run>[0]> = {},
  ): Promise<string> {
    await Bun.write(path.join(fixture.root, '.vx/workspace.mjs'), `export default ${workspace}\n`)
    await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
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
        // `--cache-policy` or `VX_CACHE_POLICY` hands `run()` a whole policy: the workspace's is not read.
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
        // A laptop's default of no remote write gives way to a policy naming the remote.
        const writes = memoryRemote()
        expect(
          await runUnder(fixture, writes.layer, `{ cache: { policy: 'remote:rw' } }`, {
            remoteReadOnlyByDefault: true,
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
          ".vx/workspace: `cache.policy`: invalid flag 'x' for 'local': expected 'r' and/or 'w'",
        )
        expect(await refusal(`{ cacheScope: 'pr-1' }`)).toContain('unknown field "cacheScope"')
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it('the CLI leaves the policy to the workspace when no spec names one', () => {
    const saved = process.env['VX_CACHE_POLICY']
    try {
      delete process.env['VX_CACHE_POLICY']
      expect(parseRunArgs(['build']).cacheFlags).toEqual({})
      expect(parseRunArgs(['build', '--force']).cacheFlags).toEqual({ force: true })
      expect(parseRunArgs(['build', '--no-cache', '--force']).cacheFlags).toEqual({
        noCache: true,
        force: true,
      })
      expect(parseRunArgs(['build', '--cache-policy=remote:']).cacheFlags).toBeUndefined()
      process.env['VX_CACHE_POLICY'] = 'remote:'
      expect(parseRunArgs(['build']).cacheFlags).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env['VX_CACHE_POLICY']
      else process.env['VX_CACHE_POLICY'] = saved
    }
  })
})
