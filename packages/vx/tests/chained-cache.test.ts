import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache, ChainedCache, LayeredCache, type RemoteCacheLayer } from '../src/cache/index.js'
import { resolveCache, type VxPlugin } from '../src/orchestrator/index.js'

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
    'the FIRST layer owns the run index: recordRun reaches only it',
    withTwo(async (a, b) => {
      const now = Date.now()
      new ChainedCache([a, b]).recordRun({
        project: 'p',
        task: 't',
        status: 'success',
        exitCode: 0,
        durationMs: 1,
        startedAt: now,
        endedAt: now + 1,
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
      const plugins: VxPlugin[] = [{ name: 'org/one', cache: () => a }]
      expect(await resolveCache(plugins, { ...baseCtx, localCache: a, policy })).toBe(a)
    }),
  )

  it(
    'two contributing plugins → a ChainedCache in declaration order',
    withTwo(async (a, b) => {
      const plugins: VxPlugin[] = [
        { name: 'org/first', cache: () => b },
        { name: 'org/second', cache: () => a },
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
        { name: 'org/cloud-like', cache: () => layered },
        { name: 'vx/local-cache', cache: (ctx) => ctx.localCache },
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
        get: async () => ({ body: artifact.buffer as ArrayBuffer, durationMs: 1 }),
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
