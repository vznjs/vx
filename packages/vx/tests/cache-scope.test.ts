// `cache.scope`, end to end over an injected remote: a run with none reads
// and writes the default keys. A scoped run asks one key per task (owner,
// 2026-10-17): the scope's for a task the branch changed (every task when
// the run names no change), the default key for any other. The policy
// alone decides whether anything is written (owner, 2026-10-14).

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
import { BranchScope, Cache, FULL_CACHE_POLICY, type RemoteCacheLayer } from '../src/cache/index.js'
import { scopedKey } from '../src/cache/scoped-cache.js'
import { parseRunArgs, resolveRunOptions } from '../src/cli/run.js'
import { run } from './helpers/orchestrator.js'
import type { AffectedChanges } from '../src/workspace/index.js'
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
  /** What the branch changed; default the app's input, so the task is the scope's. Null: git says. */
  scopeChanges: AffectedChanges | null = changed('app', 'src/in.txt'),
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
    ...(scopeChanges === null ? {} : { scopeChanges }),
  })
  expect(result.ok).toBe(true)
  const outcome = result.outcomes[0]!
  return { status: outcome.status, hash: outcome.hash! }
}

/** What a branch changed: nothing, or one file of a project (named by its folder: the runs here declare no naming plugin). */
const NOTHING: AffectedChanges = {
  projects: new Set(),
  changed: [],
  paths: new Map(),
  whole: new Set(),
}
const changed = (project: string, rel: string): AffectedChanges => ({
  projects: new Set([`packages/${project}`]),
  changed: [`packages/${project}/${rel}`],
  paths: new Map([[`packages/${project}`, [rel]]]),
  whole: new Set(),
})

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
            cacheScope: 'pr-1',
            scopeChanges: changed('app', 'src/in.txt'),
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

  // A scoped upload went to the remote under the scope's key, and the
  // footer looked its traffic up by the task key: `local 1↑`, no remote
  // part, and a failed one never showed as ✗ (Growth, footer-scoped-upload.sh).
  it.each([undefined, 'pr-1'])(
    'the footer says what each layer restored and saved (scope %p; M, 2026-10-15)',
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
        expect(legend()).toBe('remote 1↑')
        fixture.log.length = 0
        await runScoped(fixture, layer, scope, 'v1')
        expect(legend()).toBe('remote 1↓')
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
        await Bun.write(path.join(fixture.root, '.vx/workspace.mjs'), `export default {}\n`)
        const once = () =>
          run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: counted,
            remoteReadOnlyByDefault: false,
            ...(scope === undefined
              ? {}
              : { cacheScope: scope, scopeChanges: changed('app', 'src/in.txt') }),
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
    "a scoped task asks one key: the scope's when the branch changed it, else the default",
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

        // Unchanged on the branch: the default key alone, which main wrote.
        gets.length = 0
        expect(
          (await runScoped(fixture, layer, 'ref-b', 'v1', false, undefined, NOTHING)).status,
        ).toBe('cache-hit-remote')
        expect(gets).toEqual([main.hash])

        // Changed on the branch: the scope's key alone; its work lands there.
        const edit = changed('app', 'src/in.txt')
        gets.length = 0
        const pr = await runScoped(fixture, layer, 'ref-b', 'v2', false, undefined, edit)
        expect(pr.status).toBe('success')
        // The batch probe found the scope's key absent: no GET.
        expect(gets).toEqual([])
        expect(store.has(scopedKey('ref-b', pr.hash))).toBe(true)
        expect(store.has(pr.hash)).toBe(false)

        // The same scope reads it back with one GET; another scope does not.
        gets.length = 0
        expect(
          (await runScoped(fixture, layer, 'ref-b', 'v2', false, undefined, edit)).status,
        ).toBe('cache-hit-remote')
        expect(gets).toEqual([scopedKey('ref-b', pr.hash)])
        expect(
          (await runScoped(fixture, layer, 'ref-c', 'v2', false, undefined, edit)).status,
        ).toBe('success')
        // Git names no change (the branch is main's commit): main's key.
        expect(
          (await runScoped(fixture, layer, 'ref-b', 'v1', false, undefined, null)).status,
        ).toBe('cache-hit-remote')
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    "a branch's README edit leaves build on main's key (EA, 2026-10-17)",
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-readme-')
      const { layer, gets } = memoryRemote()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1', 'README.md': 'one' },
          config: BUILD_CONFIG,
        })
        const main = await runScoped(fixture, layer, undefined, 'v1')
        await writeFile(path.join(fixture.root, 'packages/app/README.md'), 'two')
        gets.length = 0
        const readme = changed('app', 'README.md')
        const pr = await runScoped(fixture, layer, 'ref-b', 'v1', false, undefined, readme)
        expect(pr.status).toBe('cache-hit-remote')
        expect(gets).toEqual([main.hash])
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    "a task downstream of a changed one reads the scope: its key folds the change's",
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-closure-')
      const { layer, store } = memoryRemote()
      try {
        await addProject(fixture.root, 'lib', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'a' },
          config: `
            export default {
              tasks: {
                build: {
                  dependsOn: ['packages/lib#build'],
                  exec: { command: 'cat src/in.txt > out.txt' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
                },
              },
            }
          `,
        })
        await Bun.write(path.join(fixture.root, '.vx/workspace.mjs'), `export default {}\n`)
        await writeFile(path.join(fixture.root, 'packages/lib/src/in.txt'), 'v2')
        const r = await run({
          cwd: fixture.root,
          tasks: ['packages/app#build'],
          log: silentLogger(fixture),
          remoteCache: layer,
          remoteReadOnlyByDefault: false,
          cacheScope: 'ref-b',
          scopeChanges: changed('lib', 'src/in.txt'),
        })
        expect(r.ok).toBe(true)
        const hashes = r.outcomes.map((o) => o.hash!)
        expect([...store.keys()].sort()).toEqual(hashes.map((h) => scopedKey('ref-b', h)).sort())
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'an unchanged task saves where it reads when no write leaves the machine',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-laptop-')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        await Bun.write(path.join(fixture.root, '.vx/workspace.mjs'), `export default {}\n`)
        // A laptop: the remote is read-only, so the miss saves under the
        // default key it reads, and the next run hits it locally.
        const { layer, store } = memoryRemote()
        const once = async (): Promise<string> => {
          const r = await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: layer,
            remoteReadOnlyByDefault: true,
            cacheScope: 'ref-b',
            scopeChanges: NOTHING,
          })
          expect(r.ok).toBe(true)
          return r.outcomes[0]!.status
        }
        expect(await once()).toBe('success')
        expect(await once()).toBe('cache-hit')
        expect(store.size).toBe(0)
        // CI writes the remote: the same miss lands under the scope's key,
        // never the default key a branch must not write.
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
        await writeFile(path.join(fixture.root, 'packages/app/src/in.txt'), 'v2')
        const ci = await runScoped(fixture, layer, 'ref-b', 'v2', false, undefined, NOTHING)
        expect(ci.status).toBe('success')
        expect([...store.keys()]).toEqual([scopedKey('ref-b', ci.hash)])
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
        expect(
          (await runScoped(fixture, layer, 'pr-1', 'v1', true, undefined, NOTHING)).status,
        ).toBe('cache-hit-remote')
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
    "VX_CACHE_SCOPE beats a plugin's scope, empty turns it off, and a bad one is refused",
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
          scopeChanges: changed('app', 'src/in.txt'),
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
        expect([...store.keys()]).toEqual([scopedKey('org/r:b1', plugin)])
        store.clear()
        process.env['VX_CACHE_SCOPE'] = 'org/r:b9'
        const env = await once()
        expect([...store.keys()]).toEqual([scopedKey('org/r:b9', env)])
        store.clear()
        process.env['VX_CACHE_SCOPE'] = ''
        const off = await once()
        expect([...store.keys()]).toEqual([off])
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
          "VX_CACHE_SCOPE must be a scope name of letters, digits and . _ - / @ : (at most 128), like 'vznjs/vx:feat-x'",
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

  it('a scoped key is asked once, in a batch probe and a GET alike', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-scope-unit-'))
    const key = '0123456789abcdef'
    const asked: string[] = []
    const errors: string[] = []
    const remote: RemoteCacheLayer = {
      has: async (hash) => (asked.push(`has ${hash}`), false),
      hasMany: async (hashes) => (asked.push(`hasMany ${hashes.join(',')}`), new Set()),
      async get(hash) {
        asked.push(`get ${hash}`)
        throw new Error('down')
      },
      async put() {},
    }
    const local = new Cache(path.join(dir, 'cache'))
    try {
      for (const routed of [true, false]) {
        asked.length = 0
        const branch = new BranchScope('pr-1')
        const layered = layeredOver(local, remote, {
          policy: FULL_CACHE_POLICY,
          onRemoteError: (err) => errors.push(err.message),
          branch,
        })
        branch.routeTasks(new Set(routed ? ['app#build'] : []))
        layered.noteKey('app#build', key)
        const want = routed ? scopedKey('pr-1', key) : key
        expect(await layered.remoteHasMany!([key])).toEqual(new Set())
        // A failed lookup warns and is a miss; the other key is never asked.
        expect(await layered.get(key)).toBeNull()
        expect(asked).toEqual([`hasMany ${want}`])
      }
      expect(errors).toEqual([])
    } finally {
      local.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Owner, 2026-10-17: the local store never knows a scope. One disk is
  // one pool, whatever branch saved an entry: its key names its inputs.
  it(
    'the local store is one pool: an entry any scope saved hits under every scope and none',
    async () => {
      const fixture = await makeWorkspace('vx-cache-scope-local-')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        await Bun.write(path.join(fixture.root, '.vx/workspace.mjs'), `export default {}\n`)
        const status = async (
          cacheScope?: string,
          scopeChanges?: AffectedChanges,
        ): Promise<string> => {
          const r = await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            ...(cacheScope === undefined ? {} : { cacheScope }),
            ...(scopeChanges === undefined ? {} : { scopeChanges }),
          })
          expect(r.ok).toBe(true)
          return r.outcomes[0]!.status
        }
        const app = changed('app', 'src/in.txt')
        expect(await status('pr-1', app)).toBe('success')
        expect(await status('pr-1', app)).toBe('cache-hit')
        expect(await status('pr-2', app)).toBe('cache-hit')
        expect(await status()).toBe('cache-hit')
        expect(await status('pr-1', NOTHING)).toBe('cache-hit')
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
