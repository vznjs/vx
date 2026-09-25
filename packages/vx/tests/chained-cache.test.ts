import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  Cache,
  ChainedCache,
  LayeredCache,
  type CacheEntry,
  type CacheLayer,
  type InvocationRecord,
  type RemoteCacheLayer,
} from '../src/cache/index.js'
import { resolveCache, type VxPlugin } from '../src/orchestrator/index.js'
import { testPlugin } from './helpers/plugin.js'

/** A minimal invocation row: `recordRunBundle` is the only run-history write a layer takes. */
function invocation(runId: string): InvocationRecord {
  return {
    runId,
    command: 'vx run t',
    requestedTasks: JSON.stringify(['t']),
    cachePolicy: 'lR,lW',
    concurrency: 1,
    flow: 'broad',
    startedAt: Date.now() - 10,
    endedAt: Date.now(),
    totalDurationMs: 10,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    commitSha: null,
    branch: null,
    dirty: null,
    ci: false,
    ciProvider: null,
    host: null,
    os: null,
    arch: null,
    vxVersion: '0.0.0',
    tags: '{}',
  }
}

function tmpCache(tag: string): { cache: Cache; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `vx-chained-${tag}-`))
  return { cache: new Cache(dir, { read: true, write: true }), dir }
}

async function saveEntry(cache: Cache | ChainedCache, hash: string, projectDir: string) {
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
    const proj = mkdtempSync(path.join(tmpdir(), 'vx-chained-proj-'))
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

describe('ChainedCache', () => {
  it(
    'get walks the layers in order and the first hit wins',
    withTwo(async (a, b, proj) => {
      await saveEntry(b, 'h1', proj)
      const chained = new ChainedCache([a, b])
      expect((await chained.get('h1'))?.hash).toBe('h1')
      expect(await chained.has('h1')).toBe('local')
      expect(await a.get('h1')).toBeNull()
      expect(await chained.get('missing')).toBeNull()
    }),
  )

  it(
    'save writes to every layer',
    withTwo(async (a, b, proj) => {
      await saveEntry(new ChainedCache([a, b]), 'h2', proj)
      expect((await a.get('h2'))?.hash).toBe('h2')
      expect((await b.get('h2'))?.hash).toBe('h2')
    }),
  )

  it(
    'restoreOutputs restores from the layer that had the hit',
    withTwo(async (a, b, proj) => {
      await saveEntry(b, 'h3', proj)
      rmSync(path.join(proj, 'out.txt'))
      const chained = new ChainedCache([a, b])
      expect(await chained.get('h3')).not.toBeNull()
      await chained.restoreOutputs('h3', proj)
      expect(await Bun.file(path.join(proj, 'out.txt')).text()).toBe('out-h3\n')
    }),
  )

  it(
    'the FIRST layer owns the run index: recordRunBundle reaches only it',
    withTwo(async (a, b) => {
      const now = Date.now()
      new ChainedCache([a, b]).recordRunBundle({
        runs: [
          {
            project: 'p',
            task: 't',
            status: 'success',
            exitCode: 0,
            durationMs: 1,
            startedAt: now,
            endedAt: now + 1,
          },
        ],
        invocation: invocation('run-1'),
      })
      expect(a.stats().runCountLast24h).toBe(1)
      expect(b.stats().runCountLast24h).toBe(0)
    }),
  )

  it(
    'hasRemote is true when any layer has a remote; close closes every layer',
    withTwo(async (a, b) => {
      expect(new ChainedCache([a, new LayeredCache(b, noRemote)]).hasRemote).toBe(true)
      expect(new ChainedCache([a, b]).hasRemote).toBe(false)
    }),
  )
})

describe('resolveCache — chaining', () => {
  const baseCtx = { workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache', warn: () => undefined }
  const policy = { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false }

  it(
    'one contributing plugin → that layer, unwrapped',
    withTwo(async (a) => {
      const plugins: VxPlugin[] = [testPlugin('org/one', { cache: () => a })]
      expect(await resolveCache(plugins, { ...baseCtx, localCache: a, policy })).toBe(a)
    }),
  )

  it(
    'two contributing plugins → a ChainedCache in declaration order',
    withTwo(async (a, b) => {
      const plugins: VxPlugin[] = [
        testPlugin('org/first', { cache: () => b }),
        testPlugin('org/second', { cache: () => a }),
      ]
      const resolved = await resolveCache(plugins, { ...baseCtx, localCache: a, policy })
      expect(resolved).toBeInstanceOf(ChainedCache)
      expect((resolved as ChainedCache).layers).toEqual([b, a])
    }),
  )

  it(
    'a layer that WRAPS the local handle subsumes a bare local layer beside it',
    withTwo(async (a) => {
      const layered = new LayeredCache(a, noRemote)
      const plugins: VxPlugin[] = [
        testPlugin('org/cloud-like', { cache: () => layered }),
        testPlugin('vx/local-cache', { cache: (ctx) => ctx.localCache }),
      ]
      expect(await resolveCache(plugins, { ...baseCtx, localCache: a, policy })).toBe(layered)
    }),
  )
})

describe('ChainedCache — layers sharing one local handle', () => {
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

  it('save packs the shared local artifact ONCE, not once per layer', async () => {
    // `reapi({endpoint:A}), reapi({endpoint:B})` is a legitimate composition
    // (two CAS endpoints); both wrap ctx.localCache, so resolveCache chains
    // two LayeredCaches over the SAME Cache. Without dedup, save() walks
    // both and Cache.save packs the tar twice per miss — pure waste, and
    // pack is the dominant save cost.
    const { cache: local, dir } = tmpCache('shared')
    const proj = mkdtempSync(path.join(tmpdir(), 'vx-chained-proj-'))
    try {
      const ra = remoteStub()
      const rb = remoteStub()
      const policy = { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true }
      const chained = new ChainedCache([
        new LayeredCache(local, ra, { policy }),
        new LayeredCache(local, rb, { policy }),
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
      await saveEntry(chained, 'h-shared', proj)
      await chained.drainUploads()
      expect(packs).toBe(1)
      // Both REMOTES still received the artifact — dedup is local-only.
      expect(ra.puts).toEqual(['h-shared'])
      expect(rb.puts).toEqual(['h-shared'])
      expect((await chained.get('h-shared'))?.hash).toBe('h-shared')
    } finally {
      local.close()
      for (const d of [dir, proj]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('a batch-probe answer from one layer must not poison a layer that cannot batch', async () => {
    // The remote-prefetch caller treats remoteHasMany's result as
    // authoritative: complement = absent, broadcast via markRemoteAbsent.
    // If layer A answers (empty) and layer B cannot batch (no hasMany),
    // the union is A's answer alone — broadcasting its complement marks
    // B's inflight false for a hash B's remote actually HAS, and the
    // later lazy get() silently re-executes a task with a real remote hit.
    const a = tmpCache('pa')
    const b = tmpCache('pb')
    const src = tmpCache('psrc')
    const proj = mkdtempSync(path.join(tmpdir(), 'vx-chained-proj-'))
    try {
      // A real artifact for B's remote to serve.
      await saveEntry(src.cache, 'h-poison', proj)
      const artifact = await Bun.file(src.cache.outputsPath('h-poison')).bytes()
      const remoteA: RemoteCacheLayer = {
        has: async () => false,
        get: async () => null,
        put: async () => undefined,
        hasMany: async () => new Set<string>(),
      }
      const remoteB: RemoteCacheLayer = {
        // No hasMany — an older serve / a wire without a batch probe.
        has: async () => true,
        get: async () => ({ body: new Blob([artifact]), durationMs: 1 }),
        put: async () => undefined,
      }
      const policy = { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true }
      const chained = new ChainedCache([
        new LayeredCache(a.cache, remoteA, { policy }),
        new LayeredCache(b.cache, remoteB, { policy }),
      ])
      // Exactly the remote-prefetch call sequence, guard included: the
      // caller marks absences ONLY from a non-null batch answer.
      const present = await chained.remoteHasMany(['h-poison'])
      if (present !== null) {
        chained.markRemoteAbsent(['h-poison'].filter((h) => !present.has(h)))
      }
      const entry = await chained.get('h-poison', { taskId: 'p#t', command: 'echo' })
      expect(entry?.hash).toBe('h-poison')
    } finally {
      for (const c of [a, b, src]) c.cache.close()
      for (const d of [a.dir, b.dir, src.dir, proj]) rmSync(d, { recursive: true, force: true })
    }
  })
})

// Every chain method over layers that only record what reached them: the
// rows above drive real caches, which answer from one layer at a time, so a
// broadcast narrowed to the first layer or an answer forgotten by `has()`
// changed nothing they could see (item 775).
type FileRows =
  ReturnType<CacheLayer['loadOutputFilesBatch']> extends Map<string, infer R> ? R : never
interface Fake {
  name: string
  calls: string[]
  layer: CacheLayer
}
function fake(
  name: string,
  opts: {
    hits?: string[]
    remote?: boolean
    remoteHas?: string[] | null
    local?: object
    rows?: Record<string, string>
    closeThrows?: boolean
  } = {},
): Fake {
  const calls: string[] = []
  const hits = new Set(opts.hits ?? [])
  const layer = {
    hasRemote: opts.remote === true,
    local: opts.local,
    get: async (h: string) => {
      calls.push(`get ${h}`)
      return hits.has(h) ? ({ hash: h, from: name } as unknown as CacheEntry) : null
    },
    has: async (h: string) => (hits.has(h) ? 'local' : null),
    prefetch: async (h: string) => hits.has(h),
    ...(opts.remoteHas !== undefined
      ? {
          remoteHasMany: async () => (opts.remoteHas === null ? null : new Set(opts.remoteHas)),
        }
      : {}),
    markRemoteAbsent: (hs: Iterable<string>) => calls.push(`absent ${[...hs].join(',')}`),
    drainUploads: async () => {
      calls.push('drain')
    },
    loadOutputFilesBatch: (hs: readonly string[]) =>
      new Map(
        hs
          .filter((h) => opts.rows?.[h] !== undefined)
          .map((h) => [h, [{ path: opts.rows![h]! }] as unknown as FileRows]),
      ),
    restoreOutputs: async (h: string) => {
      calls.push(`restore ${h}`)
    },
    outputsPath: (h: string) => `${name}/${h}`,
    save: async (args: { skipLocalWrite?: boolean }) => {
      calls.push(args.skipLocalWrite === true ? 'save skip' : 'save write')
    },
    close: () => {
      calls.push('close')
      if (opts.closeThrows === true) throw new Error(`${name} close`)
    },
  }
  return { name, calls, layer: layer as unknown as CacheLayer }
}

describe('ChainedCache — each method over recording layers', () => {
  it('get asks in declaration order and stops at the first layer that answers', async () => {
    const a = fake('a', { hits: ['h'] })
    const b = fake('b', { hits: ['h'] })
    const chained = new ChainedCache([a.layer, b.layer])
    expect(((await chained.get('h')) as unknown as { from: string }).from).toBe('a')
    expect(b.calls).toEqual([])
  })

  it('has() and prefetch() remember the layer that answered: restore and outputsPath go there', async () => {
    const a = fake('a')
    const b = fake('b', { hits: ['viaHas', 'viaPrefetch'] })
    const chained = new ChainedCache([a.layer, b.layer])
    expect(await chained.has('viaHas')).toBe('local')
    await chained.restoreOutputs('viaHas', '/p')
    expect(await chained.prefetch('viaPrefetch')).toBe(true)
    expect(chained.outputsPath('viaPrefetch')).toBe('b/viaPrefetch')
    expect({ a: a.calls, b: b.calls }).toEqual({ a: [], b: ['restore viaHas'] })
  })

  it('remoteHasMany: local layers are not asked, each remote marks its own complement, the union returns', async () => {
    const local = fake('local')
    const r1 = fake('r1', { remote: true, remoteHas: ['x'] })
    const r2 = fake('r2', { remote: true, remoteHas: ['y'] })
    const chained = new ChainedCache([local.layer, r1.layer, r2.layer])
    expect([...((await chained.remoteHasMany(['x', 'y', 'z'])) ?? [])].sort()).toEqual(['x', 'y'])
    expect({ local: local.calls, r1: r1.calls, r2: r2.calls }).toEqual({
      local: [],
      r1: ['absent y,z'],
      r2: ['absent x,z'],
    })
  })

  it('markRemoteAbsent and drainUploads reach every layer', async () => {
    const layers = [fake('a'), fake('b'), fake('c')]
    const chained = new ChainedCache(layers.map((l) => l.layer))
    chained.markRemoteAbsent(['h'])
    await chained.drainUploads()
    expect(layers.map((l) => l.calls)).toEqual([
      ['absent h', 'drain'],
      ['absent h', 'drain'],
      ['absent h', 'drain'],
    ])
  })

  it("loadOutputFilesBatch: the first layer's rows win; a later layer fills only what earlier ones lack", async () => {
    const a = fake('a', { rows: { both: 'from-a' } })
    const b = fake('b', { rows: { both: 'from-b', onlyB: 'from-b' } })
    const got = new ChainedCache([a.layer, b.layer]).loadOutputFilesBatch(['both', 'onlyB'])
    expect(Object.fromEntries([...got].map(([h, rows]) => [h, rows.map((r) => r.path)]))).toEqual({
      both: ['from-a'],
      onlyB: ['from-b'],
    })
  })

  it('save: a layer over a DIFFERENT local handle writes it; only a repeat of the same handle skips', async () => {
    const x = {}
    const y = {}
    const layers = [fake('a', { local: x }), fake('b', { local: y }), fake('c', { local: x })]
    await new ChainedCache(layers.map((l) => l.layer)).save({} as never)
    expect(layers.map((l) => l.calls)).toEqual([['save write'], ['save write'], ['save skip']])
  })

  it('close closes every layer even after one throws, then throws the first error', () => {
    const layers = [fake('a', { closeThrows: true }), fake('b', { closeThrows: true }), fake('c')]
    expect(() => new ChainedCache(layers.map((l) => l.layer)).close()).toThrow('a close')
    expect(layers.map((l) => l.calls)).toEqual([['close'], ['close'], ['close']])
  })

  it('fewer than two layers is refused: one layer is that layer, not a chain', () => {
    expect(() => new ChainedCache([fake('a').layer])).toThrow(
      'ChainedCache needs at least two layers',
    )
  })
})
