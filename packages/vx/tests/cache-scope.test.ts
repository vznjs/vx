// The run's cache scope and policy, end to end over an injected remote. A
// task key reaches every remote plain, whatever the scope: a remote plugin
// keeps branches apart itself (`scope` on turboCache/nxCache, 2026-10-20).
// The policy alone decides whether anything is written (2026-10-14).

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
import { FULL_CACHE_POLICY, type RemoteCacheLayer } from '../src/cache/index.js'
import { parseRunArgs, resolveRunOptions } from '../src/cli/run.js'
import { run } from './helpers/orchestrator.js'
import { outcomeWord } from '../src/report/index.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'

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

function memoryRemote(probeDelayMs = 0): {
  layer: RemoteCacheLayer
  store: Map<string, Uint8Array>
  gets: string[]
} {
  const store = new Map<string, Uint8Array>()
  const gets: string[] = []
  const layer: RemoteCacheLayer = {
    async has(hash) {
      return store.has(hash) ? {} : null
    },
    async hasMany(hashes) {
      if (probeDelayMs > 0) await Bun.sleep(probeDelayMs)
      return new Map(hashes.filter((h) => store.has(h)).map((h) => [h, {}]))
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
  await Bun.write(path.join(fixture.root, '.vx/workspace.mjs'), `export default {}\n`)
  await writeFile(path.join(fixture.root, 'packages/app/src/in.txt'), input)
  const named = cacheScope ?? scope
  // Only the remote may answer: every run starts from an empty local cache.
  await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
  const result = await run({
    cwd: fixture.root,
    tasks: ['build'],
    log: silentLogger(fixture),
    remoteCache: remote,
    ...(remoteReadOnlyByDefault === undefined ? {} : { remoteReadOnlyByDefault }),
    ...(named === undefined ? {} : { cacheScope: named }),
  })
  expect(result.ok).toBe(true)
  const outcome = result.outcomes[0]!
  return { status: outcome.status, hash: outcome.hash! }
}

describe('cache.scope', () => {
  // A scoped upload went to the remote under the scope's key, and the
  // footer looked its traffic up by the task key: `local 1↑`, no remote
  // part, and a failed one never showed as ✗ (Growth, footer-scoped-upload.sh).
  it.each([undefined, 'pr-1'])(
    'the footer says what each layer restored and saved (scope %p; 2026-10-15)',
    async (scope) => {
      const fixture = await makeWorkspace('vx-cache-footer-uploads-')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const { layer } = memoryRemote()
        await runScoped(fixture, layer, scope, 'v1')
        const legend = (): string =>
          fixture.log[fixture.log.findIndex((l) => l.startsWith('  cache')) + 1]!.trim()
        // Each task counts once, under its strongest state: saved here and uploaded is `remote ↑`.
        expect(legend()).toMatch(/^remote 1↑ \d+ B$/)
        fixture.log.length = 0
        await runScoped(fixture, layer, scope, 'v1')
        expect(legend()).toMatch(/^remote 1↓ \d+ B$/)
        fixture.log.length = 0
        const failing: RemoteCacheLayer = {
          ...layer,
          async put() {
            throw new Error('503')
          },
        }
        await runScoped(fixture, failing, scope, 'v2')
        expect(legend()).toBe('remote 1✗')
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it.each([undefined, 'pr-1'])(
    'a run the local cache answers asks the remote nothing (scope %p; 2026-10-15)',
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
        await Bun.write(path.join(fixture.root, '.vx/workspace.mjs'), `export default {}\n`)
        const once = () =>
          run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: counted,
            remoteReadOnlyByDefault: false,
            ...(scope === undefined ? {} : { cacheScope: scope }),
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
    'a lookup that lands before the batch probe answers GETs at once, absent key or not',
    async () => {
      // Waiting on the probe made every remote hit two round-trips (~300 ms
      // an up-to-date task on CI, 2026-10-24). A GET answers a miss as fast.
      const fixture = await makeWorkspace('vx-cache-scope-')
      const { layer, gets } = memoryRemote(300)
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        expect((await runScoped(fixture, layer, undefined, 'v1')).status).toBe('success')
        expect(gets).toHaveLength(1)
        // An absent key: its 404 is the answer the probe would have given.
        expect((await runScoped(fixture, layer, 'ref-b', 'v2')).status).toBe('success')
        expect(gets).toHaveLength(2)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a remote hit is never up to date, outputs or none; a local one with nothing to restore is',
    async () => {
      // CI's summary called a remote hit of a task with no outputs up to
      // date, at ~300 ms of network (2026-10-24: "Up to date is a fresh.
      // It should not require any cache").
      const fixture = await makeWorkspace('vx-cache-uptodate-')
      const { layer } = memoryRemote()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: `export default { tasks: { check: {
            exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
          } } }`,
        })
        const once = async (): Promise<string> => {
          const result = await run({
            cwd: fixture.root,
            tasks: ['check'],
            log: silentLogger(fixture),
            remoteCache: layer,
          })
          return outcomeWord(result.outcomes[0]!)
        }
        expect(await once()).toBe('success')
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
        expect(await once()).toBe('restored-remote')
        expect(await once()).toBe('up-to-date')
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
    'a task key reaches the remote plain whatever the scope, and a bad VX_CACHE_SCOPE is refused',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-env-')
      const { layer, store } = memoryRemote()
      const saved = process.env['VX_CACHE_SCOPE']
      const once = async (): Promise<string> => {
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
        const r = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: layer,
          remoteReadOnlyByDefault: false,
        })
        expect(r.ok).toBe(true)
        return r.outcomes[0]!.hash!
      }
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        await Bun.write(
          path.join(fixture.root, '.vx/workspace.mjs'),
          `${PLUGIN_IMPORT}export default { plugins: [${pluginSource('org/ci', "{ config(_w, ctx) { ctx.setBranch({ scope: 'org/r:b1' }) } }")}] }\n`,
        )
        const plugin = await once()
        expect([...store.keys()]).toEqual([plugin])
        store.clear()
        process.env['VX_CACHE_SCOPE'] = 'org/r:b9'
        expect([...store.keys(), await once()]).toEqual([plugin])
        process.env['VX_CACHE_SCOPE'] = 'pr 9'
        const refused = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: layer,
        }).then(
          () => 'ran',
          (err: Error) => err.message,
        )
        expect(refused).toBe(
          "VX_CACHE_SCOPE must be a scope name of letters, digits and . _ - / @ : (at most 128), like 'vznjs/vx:feat-x' (got pr 9)",
        )
      } finally {
        if (saved === undefined) delete process.env['VX_CACHE_SCOPE']
        else process.env['VX_CACHE_SCOPE'] = saved
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it('--cache-scope and cache.scope are gone', async () => {
    expect(parseRunArgs(['build', '--cache-scope', 'pr-7']).error).toBeDefined()
    const fixture = await makeWorkspace('vx-cache-scope-key-')
    try {
      await addProject(fixture.root, 'app', { files: { 'src/in.txt': 'v1' }, config: BUILD_CONFIG })
      await Bun.write(
        path.join(fixture.root, '.vx/workspace.mjs'),
        `export default { cache: { scope: 'pr-1' } }\n`,
      )
      const refused = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
      }).then(
        () => 'ran',
        (err: Error) => err.message,
      )
      expect(refused).toContain('scope')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

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
      expect(parseRunArgs(['build']).remoteRequested).toBe('VX_CACHE_POLICY')
      process.env['VX_CACHE_POLICY'] = 'disk:r'
      expect(parseRunArgs(['build']).error).toContain("VX_CACHE_POLICY: invalid layer 'disk'")
      process.env['VX_CACHE_POLICY'] = ','
      expect(parseRunArgs(['build']).error).toContain('VX_CACHE_POLICY needs a spec')
    } finally {
      if (saved === undefined) delete process.env['VX_CACHE_POLICY']
      else process.env['VX_CACHE_POLICY'] = saved
    }
  })
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
