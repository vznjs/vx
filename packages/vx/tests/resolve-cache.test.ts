// How core layers the declared remotes over the local store: the plugin
// hook's return refused or taken (`resolveCache`), then the order a lookup
// asks them in and what a save reaches, over one local store.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache, LayeredCache, type CacheLayer, type RemoteCacheLayer } from '../src/cache/index.js'
import { resolveCache, type VxPlugin } from '../src/orchestrator/index.js'
import { testPlugin } from './helpers/plugin.js'
import { storedArtifact } from './helpers/stored-artifact.js'

function tmpCache(tag: string): { cache: Cache; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `vx-remotes-${tag}-`))
  return { cache: new Cache(dir, { read: true, write: true }), dir }
}

async function saveEntry(cache: CacheLayer, hash: string, projectDir: string) {
  await Bun.write(path.join(projectDir, 'out.txt'), `out-${hash}\n`)
  await cache.save({
    hash,
    entry: { taskId: 'p#t', command: 'echo', durationMs: 1, stdout: '' },
    projectDir,
    outputFiles: [path.join(projectDir, 'out.txt')],
  })
}

function withTwo(fn: (a: Cache, b: Cache, proj: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const a = tmpCache('a')
    const b = tmpCache('b')
    const proj = mkdtempSync(path.join(tmpdir(), 'vx-remotes-proj-'))
    try {
      await fn(a.cache, b.cache, proj)
    } finally {
      a.cache.close()
      b.cache.close()
      for (const d of [a.dir, b.dir, proj]) rmSync(d, { recursive: true, force: true })
    }
  }
}

const noRemote: RemoteCacheLayer = {
  has: async () => false,
  get: async () => null,
  put: async () => undefined,
}

describe('resolveCache — a plugin returns the remote, core layers it', () => {
  const baseCtx = {
    workspaceRoot: '/ws',
    cacheDir: '/ws/.vx/cache',
    warn: () => undefined,
    scope: undefined,
  }
  const policy = { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true }
  /** A remote that records each lookup and upload under `name`. */
  const recording = (name: string, log: string[], hits: Map<string, Uint8Array> = new Map()) =>
    ({
      has: async (h: string) => hits.has(h),
      get: async (h: string) => {
        log.push(`get ${name}`)
        const body = hits.get(h)
        return body === undefined ? null : { body: new Blob([body]), durationMs: 1 }
      },
      put: async (h: string) => {
        log.push(`put ${name} ${h}`)
      },
    }) satisfies RemoteCacheLayer

  it(
    'no remote → the local store alone',
    withTwo(async (a) => {
      const plugins: VxPlugin[] = [testPlugin('org/none', { cache: () => undefined })]
      expect(await resolveCache(plugins, { ...baseCtx, localCache: a, policy })).toBe(a)
    }),
  )

  it(
    'one remote → a LayeredCache over the local store',
    withTwo(async (a) => {
      const plugins: VxPlugin[] = [testPlugin('org/one', { cache: () => noRemote })]
      const resolved = await resolveCache(plugins, { ...baseCtx, localCache: a, policy })
      expect(resolved).toBeInstanceOf(LayeredCache)
      expect((resolved as LayeredCache).local).toBe(a)
    }),
  )

  it(
    'the local store is asked first, then each remote in declared order',
    withTwo(async (a, _b, proj) => {
      const log: string[] = []
      const resolved = await resolveCache(
        [
          testPlugin('org/first', { cache: () => recording('first', log) }),
          testPlugin('org/second', { cache: () => recording('second', log) }),
        ],
        { ...baseCtx, localCache: a, policy },
      )
      expect(resolved).toBeInstanceOf(LayeredCache)
      expect(await resolved.get('absent')).toBeNull()
      expect(log).toEqual(['get first', 'get second'])
      log.length = 0
      await saveEntry(a, 'h-local', proj)
      expect((await resolved.get('h-local'))?.source).toBe('local')
      expect(log).toEqual([])
    }),
  )

  it(
    'the first remote that has the artifact answers; a save reaches every remote',
    withTwo(async (a, b, proj) => {
      await saveEntry(b, 'h1', proj)
      const log: string[] = []
      const resolved = await resolveCache(
        [
          testPlugin('org/first', { cache: () => recording('first', log) }),
          testPlugin('org/second', {
            cache: () => recording('second', log, new Map([['h1', storedArtifact(b, 'h1')!]])),
          }),
          testPlugin('org/third', { cache: () => recording('third', log) }),
        ],
        { ...baseCtx, localCache: a, policy },
      )
      expect((await resolved.get('h1'))?.source).toBe('remote')
      expect(log).toEqual(['get first', 'get second'])
      log.length = 0
      await saveEntry(resolved, 'h2', proj)
      await resolved.drainUploads?.()
      expect(log.sort()).toEqual(['put first h2', 'put second h2', 'put third h2'])
    }),
  )

  it(
    "a remote's access narrows the run's policy: a read-only token never uploads",
    withTwo(async (a, _b, proj) => {
      const log: string[] = []
      const remote = { ...recording('ro', log), access: { read: true, write: false } }
      const resolved = await resolveCache([testPlugin('org/ro', { cache: () => remote })], {
        ...baseCtx,
        localCache: a,
        policy,
      })
      await resolved.get('absent')
      await saveEntry(resolved, 'h', proj)
      await resolved.drainUploads?.()
      expect(log).toEqual(['get ro'])
    }),
  )

  it(
    "the run's policy gates every remote: remote reads off asks none",
    withTwo(async (a) => {
      const log: string[] = []
      const resolved = await resolveCache(
        [testPlugin('org/one', { cache: () => recording('one', log) })],
        { ...baseCtx, localCache: a, policy: { ...policy, remoteRead: false } },
      )
      expect(await resolved.get('absent')).toBeNull()
      expect(log).toEqual([])
    }),
  )

  it(
    'a remote that throws is a miss and a warning naming its plugin; the local store still answers',
    withTwo(async (a, _b, proj) => {
      await saveEntry(a, 'h1', proj)
      const warned: string[] = []
      const broken: RemoteCacheLayer = {
        has: async () => false,
        get: async () => {
          throw new Error('get boom')
        },
        put: async () => undefined,
      }
      const resolved = await resolveCache([testPlugin('org/broken', { cache: () => broken })], {
        ...baseCtx,
        warn: (m) => warned.push(m),
        localCache: a,
        policy,
      })
      expect({
        first: (await resolved.get('h1'))?.hash,
        second: await resolved.get('absent'),
        named: warned.length > 0 && warned.every((w) => w.startsWith("[vx] plugin 'org/broken': ")),
      }).toEqual({ first: 'h1', second: null, named: true })
    }),
  )

  it(
    'a whole cache layer is refused: the hook returns the remote alone',
    withTwo(async (a) => {
      const old = new LayeredCache(a, [{ remote: noRemote, read: true, write: true }])
      await expect(
        resolveCache([testPlugin('org/old', { cache: () => old as never })], {
          ...baseCtx,
          localCache: a,
          policy,
        }),
      ).rejects.toThrow(
        "plugin 'org/old' returned from cache something that is not a remote cache layer: missing put()",
      )
    }),
  )
})

describe('LayeredCache — several remotes over one local store', () => {
  const both = { read: true, write: true }
  const remoteStub = (): RemoteCacheLayer & { puts: string[] } => {
    const puts: string[] = []
    return {
      puts,
      has: async () => false,
      get: async () => null,
      put: async (hash: string) => {
        puts.push(hash)
      },
    }
  }

  it('save packs the local artifact ONCE and uploads it to every remote', async () => {
    // `reapi({endpoint:A}), reapi({endpoint:B})` is a legitimate composition
    // (two CAS endpoints). Pack is the dominant save cost, so a second
    // remote must not pack the tar again.
    const { cache: local, dir } = tmpCache('shared')
    const proj = mkdtempSync(path.join(tmpdir(), 'vx-remotes-proj-'))
    try {
      const ra = remoteStub()
      const rb = remoteStub()
      const layered = new LayeredCache(local, [
        { remote: ra, ...both },
        { remote: rb, ...both },
      ])
      // packArtifactToTemp is private (the pack step a local save runs);
      // the structural cast is the narrowest spy that can count the
      // expensive step without widening the class API.
      type PackSpy = {
        packArtifactToTemp(tmp: string, args: unknown): Promise<Uint8Array | { tmpPath: string }>
      }
      const spyable = local as unknown as PackSpy
      let packs = 0
      const orig = spyable.packArtifactToTemp.bind(local)
      spyable.packArtifactToTemp = (tmp: string, args: unknown) => {
        packs++
        return orig(tmp, args)
      }
      await saveEntry(layered, 'h-shared', proj)
      await layered.drainUploads()
      expect(packs).toBe(1)
      expect(ra.puts).toEqual(['h-shared'])
      expect(rb.puts).toEqual(['h-shared'])
      expect((await layered.get('h-shared'))?.hash).toBe('h-shared')
    } finally {
      local.close()
      for (const d of [dir, proj]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('a hit the second remote prefetched still reports remote', async () => {
    // `turboCache(), nxCache()`: the prefetch finds the hash in the SECOND
    // remote and pulls it into the local store; the task's own lookup then
    // finds the pulled copy locally and must not call it a local hit
    // (item 889).
    const { cache: local, dir } = tmpCache('prov')
    const src = tmpCache('prov-src')
    const proj = mkdtempSync(path.join(tmpdir(), 'vx-remotes-proj-'))
    try {
      await saveEntry(src.cache, 'h-prov', proj)
      const artifact = storedArtifact(src.cache, 'h-prov')!
      const second: RemoteCacheLayer = {
        has: async () => true,
        get: async () => ({ body: new Blob([artifact]), durationMs: 1 }),
        put: async () => undefined,
      }
      const layered = new LayeredCache(local, [
        { remote: noRemote, ...both },
        { remote: second, ...both },
      ])
      const ctx = { taskId: 'p#t', command: 'echo' }
      expect(await layered.prefetch('h-prov', ctx)).toBe(true)
      const entry = await layered.get('h-prov', ctx)
      expect({ hash: entry?.hash, source: entry?.source }).toEqual({
        hash: 'h-prov',
        source: 'remote',
      })
    } finally {
      local.close()
      src.cache.close()
      for (const d of [dir, src.dir, proj]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('a batch-probe answer from one remote must not poison a remote that cannot batch', async () => {
    // The remote-prefetch caller treats remoteHasMany's result as
    // authoritative: complement = absent, via markRemoteAbsent. If remote
    // A answers (empty) and remote B cannot batch (no hasMany), A's answer
    // alone would mark absent a hash B HAS, and the later lazy get()
    // would silently re-execute a task with a real remote hit.
    const { cache: local, dir } = tmpCache('poison')
    const src = tmpCache('psrc')
    const proj = mkdtempSync(path.join(tmpdir(), 'vx-remotes-proj-'))
    try {
      await saveEntry(src.cache, 'h-poison', proj)
      const artifact = storedArtifact(src.cache, 'h-poison')!
      const remoteA: RemoteCacheLayer = { ...noRemote, hasMany: async () => new Set<string>() }
      const remoteB: RemoteCacheLayer = {
        // No hasMany — an older serve / a wire without a batch probe.
        has: async () => true,
        get: async () => ({ body: new Blob([artifact]), durationMs: 1 }),
        put: async () => undefined,
      }
      const layered = new LayeredCache(local, [
        { remote: remoteA, ...both },
        { remote: remoteB, ...both },
      ])
      // Exactly the remote-prefetch call sequence, guard included: the
      // caller marks absences ONLY from a non-null batch answer.
      const present = await layered.remoteHasMany(['h-poison'])
      if (present !== null) {
        layered.markRemoteAbsent(['h-poison'].filter((h) => !present.has(h)))
      }
      const entry = await layered.get('h-poison', { taskId: 'p#t', command: 'echo' })
      expect(entry?.hash).toBe('h-poison')
    } finally {
      local.close()
      src.cache.close()
      for (const d of [dir, src.dir, proj]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('each answering remote keeps its own absences: a hash only a sibling holds costs it no GET', async () => {
    const { cache: local, dir } = tmpCache('own')
    const src = tmpCache('own-src')
    const proj = mkdtempSync(path.join(tmpdir(), 'vx-remotes-proj-'))
    try {
      await saveEntry(src.cache, 'h-b', proj)
      const artifact = storedArtifact(src.cache, 'h-b')!
      const gets: string[] = []
      const remoteA: RemoteCacheLayer = {
        ...noRemote,
        hasMany: async () => new Set<string>(),
        get: async (h) => {
          gets.push(`a ${h}`)
          return null
        },
      }
      const remoteB: RemoteCacheLayer = {
        has: async () => true,
        hasMany: async () => new Set(['h-b']),
        get: async (h) => {
          gets.push(`b ${h}`)
          return { body: new Blob([artifact]), durationMs: 1 }
        },
        put: async () => undefined,
      }
      const layered = new LayeredCache(local, [
        { remote: remoteA, ...both },
        { remote: remoteB, ...both },
      ])
      expect(await layered.remoteHasMany(['h-b', 'h-none'])).toEqual(new Set(['h-b']))
      expect((await layered.get('h-b', { taskId: 'p#t', command: 'echo' }))?.source).toBe('remote')
      expect(gets).toEqual(['b h-b'])
    } finally {
      local.close()
      src.cache.close()
      for (const d of [dir, src.dir, proj]) rmSync(d, { recursive: true, force: true })
    }
  })
})
