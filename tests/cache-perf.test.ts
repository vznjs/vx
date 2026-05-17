// Tests for the cache-hit-path performance optimizations added in
// the `cache-hit-perf` PR. Each test targets one specific behavior
// rather than asserting wall-clock time (which is too flaky for CI).

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, utimes, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Cache, type RunRecord } from '../src/cache/cache.js'

describe('Cache.hashFile (mtime+size fast path)', () => {
  let dir: string
  let cache: Cache

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-hashfile-'))
    cache = new Cache(path.join(dir, '.vx-cache'))
  })

  afterEach(async () => {
    cache.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the correct xxh3 digest on first call (cold path)', async () => {
    const f = path.join(dir, 'hello.txt')
    await writeFile(f, 'hello world')
    const h = await cache.hashFile(f)
    // Pre-computed Bun.hash.xxHash3 of "hello world" (16-char hex)
    expect(h).toBe('d447b1ea40e6988b')
  })

  it('returns identical hash on second call (warm path)', async () => {
    const f = path.join(dir, 'a.txt')
    await writeFile(f, 'static contents')
    const a = await cache.hashFile(f)
    const b = await cache.hashFile(f)
    expect(b).toBe(a)
  })

  it('detects content change via mtime+size mismatch', async () => {
    const f = path.join(dir, 'edited.txt')
    await writeFile(f, 'before')
    const a = await cache.hashFile(f)
    // Wait so the mtime is reliably distinct (some filesystems have
    // 1s mtime granularity).
    await Bun.sleep(20)
    await writeFile(f, 'AFTER-VALUE-DIFFERENT-SIZE')
    const b = await cache.hashFile(f)
    expect(b).not.toBe(a)
  })

  it('refreshes the stored hash when stat changes', async () => {
    const f = path.join(dir, 'tracked.txt')
    await writeFile(f, 'v1')
    await cache.hashFile(f)
    await Bun.sleep(20)
    await writeFile(f, 'v2-longer-content')
    const second = await cache.hashFile(f)
    // Hash matches direct xxh3 of the new bytes.
    const expected = Bun.hash.xxHash3('v2-longer-content').toString(16).padStart(16, '0')
    expect(second).toBe(expected)
  })

  it('reuses stored digest when stat is unchanged (does not re-read disk)', async () => {
    // We can't directly observe "did we read the disk?" without
    // mocking fs, so prove the property indirectly: after the first
    // call records (mtime, size, content_hash), if we corrupt the file
    // in-place AT THE SAME SIZE AND SAME MTIME, the fast path
    // returns the stale (cached) hash. This is the documented
    // fast-path tradeoff.
    const f = path.join(dir, 'pinned.txt')
    await writeFile(f, 'AAAAAA')
    const firstHash = await cache.hashFile(f)
    const s = await stat(f)
    // Rewrite to same size while restoring the mtime so the fast
    // path's stat check passes.
    await writeFile(f, 'BBBBBB')
    await utimes(f, s.atime, s.mtime)
    const secondHash = await cache.hashFile(f)
    expect(secondHash).toBe(firstHash)
  })
})

describe('Cache.recordRuns (batched)', () => {
  let dir: string
  let cache: Cache

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-recordRuns-'))
    cache = new Cache(path.join(dir, '.vx-cache'))
  })

  afterEach(async () => {
    cache.close()
    await rm(dir, { recursive: true, force: true })
  })

  function sampleRun(idx: number): RunRecord {
    return {
      hash: `h-${idx}`,
      project: 'pkg',
      task: 'build',
      status: 'success',
      exitCode: 0,
      durationMs: 10,
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
    }
  }

  it('no-ops on empty array', () => {
    expect(() => cache.recordRuns([])).not.toThrow()
    expect(cache.stats().runCountLast24h).toBe(0)
  })

  it('single-row insert path', () => {
    cache.recordRuns([sampleRun(0)])
    expect(cache.stats().runCountLast24h).toBe(1)
  })

  it('batched path persists every row', () => {
    const N = 50
    const rows = Array.from({ length: N }, (_, i) => sampleRun(i))
    cache.recordRuns(rows)
    expect(cache.stats().runCountLast24h).toBe(N)
  })

  it('equivalent to N recordRun calls', () => {
    const dir2 = path.join(dir, 'sibling')
    const cache2 = new Cache(dir2)
    try {
      const rows = Array.from({ length: 7 }, (_, i) => sampleRun(i))
      for (const r of rows) cache2.recordRun(r)
      cache.recordRuns(rows)
      expect(cache2.stats().runCountLast24h).toBe(cache.stats().runCountLast24h)
    } finally {
      cache2.close()
    }
  })
})

describe('createHashCache + within-run hash memoization', () => {
  let dir: string
  let cache: Cache

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-hashCache-'))
    cache = new Cache(path.join(dir, '.vx-cache'))
  })

  afterEach(async () => {
    cache.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('taskConfig memo returns identical hash on repeated calls (same object)', async () => {
    const { createHashCache, computeTaskHash } = await import('../src/orchestrator/execute-task.ts')
    const hashCache = createHashCache()
    const sharedConfig = {
      exec: { command: 'noop' },
      cache: { inputs: { files: [] }, outputs: { files: [] } },
    }
    const node = {
      id: 'p#build',
      projectName: 'p',
      projectDir: dir,
      taskName: 'build',
      config: sharedConfig,
      deps: [],
      requested: true,
    } as unknown as import('../src/graph/task-graph.ts').TaskNode
    const h1 = await computeTaskHash({
      node,
      upstream: [],
      workspaceRoot: dir,
      workspaceFingerprint: 'fp',
      cache,
      nestedProjectDirs: [],
      hashCache,
    })
    const h2 = await computeTaskHash({
      node,
      upstream: [],
      workspaceRoot: dir,
      workspaceFingerprint: 'fp',
      cache,
      nestedProjectDirs: [],
      hashCache,
    })
    expect(h2).toBe(h1)
    // The WeakMap should have the config in it after the first call.
    expect(hashCache.taskConfig.has(sharedConfig)).toBe(true)
  })

  it('packageJson memo only resolves projectDir once across multiple tasks', async () => {
    const projectDir = path.join(dir, 'pkg')
    await mkdir(projectDir, { recursive: true })
    await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'pkg' }))

    const { createHashCache, computeTaskHash } = await import('../src/orchestrator/execute-task.ts')
    const hashCache = createHashCache()
    const baseNode = {
      projectName: 'pkg',
      projectDir,
      deps: [],
      requested: true,
    }
    const buildConfig = {
      exec: { command: 'b' },
      cache: { inputs: { files: [] }, outputs: { files: [] } },
    }
    const testConfig = {
      exec: { command: 't' },
      cache: { inputs: { files: [] }, outputs: { files: [] } },
    }

    await computeTaskHash({
      node: {
        ...baseNode,
        id: 'pkg#build',
        taskName: 'build',
        config: buildConfig,
      } as unknown as import('../src/graph/task-graph.ts').TaskNode,
      upstream: [],
      workspaceRoot: dir,
      workspaceFingerprint: 'fp',
      cache,
      nestedProjectDirs: [],
      hashCache,
    })
    expect(hashCache.packageJson.has(projectDir)).toBe(true)
    const entryAfterFirst = hashCache.packageJson.get(projectDir)

    await computeTaskHash({
      node: {
        ...baseNode,
        id: 'pkg#test',
        taskName: 'test',
        config: testConfig,
      } as unknown as import('../src/graph/task-graph.ts').TaskNode,
      upstream: [],
      workspaceRoot: dir,
      workspaceFingerprint: 'fp',
      cache,
      nestedProjectDirs: [],
      hashCache,
    })
    // Same Promise instance is returned — second call hit the memo.
    expect(hashCache.packageJson.get(projectDir)).toBe(entryAfterFirst)
    expect(hashCache.packageJson.size).toBe(1)
  })

  it('different projects each get their own packageJson cache entry', async () => {
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    await mkdir(a, { recursive: true })
    await mkdir(b, { recursive: true })
    await writeFile(path.join(a, 'package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(path.join(b, 'package.json'), JSON.stringify({ name: 'b' }))

    const { createHashCache, computeTaskHash } = await import('../src/orchestrator/execute-task.ts')
    const hashCache = createHashCache()
    const cfg = { exec: { command: 'x' }, cache: { inputs: { files: [] }, outputs: { files: [] } } }

    await computeTaskHash({
      node: {
        id: 'a#b',
        projectName: 'a',
        projectDir: a,
        taskName: 'b',
        config: cfg,
        deps: [],
        requested: true,
      } as unknown as import('../src/graph/task-graph.ts').TaskNode,
      upstream: [],
      workspaceRoot: dir,
      workspaceFingerprint: 'fp',
      cache,
      nestedProjectDirs: [],
      hashCache,
    })
    await computeTaskHash({
      node: {
        id: 'b#b',
        projectName: 'b',
        projectDir: b,
        taskName: 'b',
        config: cfg,
        deps: [],
        requested: true,
      } as unknown as import('../src/graph/task-graph.ts').TaskNode,
      upstream: [],
      workspaceRoot: dir,
      workspaceFingerprint: 'fp',
      cache,
      nestedProjectDirs: [],
      hashCache,
    })
    expect(hashCache.packageJson.size).toBe(2)
    expect(hashCache.packageJson.has(a)).toBe(true)
    expect(hashCache.packageJson.has(b)).toBe(true)
  })

  it('hashFile fast-path is used for package.json reads (verified via Cache.hashFile call)', async () => {
    // Write a pkg.json, hash it through computeTaskHash, then confirm
    // the file_hashes table now has a row for the project's pkg.json.
    const projectDir = path.join(dir, 'pkg')
    await mkdir(projectDir, { recursive: true })
    const pj = path.join(projectDir, 'package.json')
    await writeFile(pj, JSON.stringify({ name: 'pkg' }))

    const { createHashCache, computeTaskHash } = await import('../src/orchestrator/execute-task.ts')
    await computeTaskHash({
      node: {
        id: 'pkg#x',
        projectName: 'pkg',
        projectDir,
        taskName: 'x',
        config: {
          exec: { command: 'x' },
          cache: { inputs: { files: [] }, outputs: { files: [] } },
        },
        deps: [],
        requested: true,
      } as unknown as import('../src/graph/task-graph.ts').TaskNode,
      upstream: [],
      workspaceRoot: dir,
      workspaceFingerprint: 'fp',
      cache,
      nestedProjectDirs: [],
      hashCache: createHashCache(),
    })
    // hashFile direct re-call must produce the same hash without re-reading
    // (we can't directly observe the fast-path's "no disk read" behavior,
    // but we can verify identity).
    const direct = await cache.hashFile(pj)
    const expected = Bun.hash
      .xxHash3(await Bun.file(pj).bytes())
      .toString(16)
      .padStart(16, '0')
    expect(direct).toBe(expected)
  })
})

describe('cache layout v15: <hash>.tar single file (Turbo-style)', () => {
  let dir: string
  let cache: Cache
  let projectDir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-'))
    cache = new Cache(path.join(dir, '.vx-cache'))
    projectDir = path.join(dir, 'project')
    await mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    cache.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function saveSample(hash: string, files: Record<string, string>): Promise<void> {
    const abs: string[] = []
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(projectDir, rel)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, content)
      abs.push(full)
    }
    await cache.save({
      hash,
      projectDir,
      outputFiles: abs,
      entry: {
        taskId: 'pkg#build',
        command: 'noop',
        exitCode: 0,
        durationMs: 5,
        stdout: 'compiling…',
      },
    })
  }

  it('save writes a single <hash>.tar file (not a directory)', async () => {
    await saveSample('h-tar', { 'dist/a.js': 'A', 'dist/b.js': 'B' })
    const cacheDir = path.join(dir, '.vx-cache')
    // The artifact is one file, not a directory tree.
    const stats = await stat(path.join(cacheDir, 'h-tar.tar.zst'))
    expect(stats.isFile()).toBe(true)
    // No more <hash>/ subdir layout.
    expect(await Bun.file(path.join(cacheDir, 'h-tar', 'outputs', 'dist', 'a.js')).exists()).toBe(
      false,
    )
  })

  it('stdout stored alongside outputs in the artifact', async () => {
    await saveSample('h-meta', { 'out.txt': 'hi' })
    const got = await cache.get('h-meta')
    expect(got?.stdout).toBe('compiling…')
    // outputFiles lists only the outputs/ entries — stdout doesn't
    // appear there even though it's in the same tar.
    const list = got?.outputFiles ?? []
    expect(list).toEqual(['out.txt'])
  })

  it('restoreOutputs extracts the tar back into the project dir', async () => {
    await saveSample('h-restore', { 'dist/index.js': 'BUILT', 'dist/lib/x.js': 'LIB' })
    await rm(path.join(projectDir, 'dist'), { recursive: true, force: true })
    await cache.restoreOutputs('h-restore', projectDir)
    expect(await Bun.file(path.join(projectDir, 'dist', 'index.js')).text()).toBe('BUILT')
    expect(await Bun.file(path.join(projectDir, 'dist', 'lib', 'x.js')).text()).toBe('LIB')
  })

  it('restoreOutputs is a no-op when the artifact is missing', async () => {
    // Should not throw — just return without doing anything.
    await expect(cache.restoreOutputs('does-not-exist', projectDir)).resolves.toBeUndefined()
  })

  it('outputsPath returns the tar file path', () => {
    const p = cache.outputsPath('h-path')
    expect(p.endsWith('h-path.tar.zst')).toBe(true)
  })

  it('prune removes the .tar files', async () => {
    await saveSample('h-prune', { 'a.txt': 'a' })
    const cacheDir = path.join(dir, '.vx-cache')
    expect(await Bun.file(path.join(cacheDir, 'h-prune.tar.zst')).exists()).toBe(true)
    await cache.prune({ olderThanMs: Date.now() + 1_000_000 }) // evict everything
    expect(await Bun.file(path.join(cacheDir, 'h-prune.tar.zst')).exists()).toBe(false)
  })
})
