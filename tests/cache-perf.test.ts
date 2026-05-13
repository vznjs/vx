// Tests for the cache-hit-path performance optimizations added in
// the `cache-hit-perf` PR. Each test targets one specific behavior
// rather than asserting wall-clock time (which is too flaky for CI).

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, utimes, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Cache, type RunRecord } from '../src/cache/cache.js'
import { outputsMatchCache } from '../src/cache/inputs.js'

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

  it('returns the correct sha256 on first call (cold path)', async () => {
    const f = path.join(dir, 'hello.txt')
    await writeFile(f, 'hello world')
    const h = await cache.hashFile(f)
    // Pre-computed sha256 of "hello world"
    expect(h).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
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
    // Hash matches direct sha256 of the new bytes.
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update('v2-longer-content')
    expect(second).toBe(hasher.digest('hex'))
  })

  it('reuses stored sha256 when stat is unchanged (does not re-read disk)', async () => {
    // We can't directly observe "did we read the disk?" without
    // mocking fs, so prove the property indirectly: after the first
    // call records (mtime, size, sha256), if we corrupt the file
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

describe('outputsMatchCache (cache-hit skip-clean-restore optimization)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-omc-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function makeTree(root: string, files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, content)
    }
  }

  it('returns true when project tree matches cache snapshot exactly', async () => {
    const projectDir = path.join(dir, 'project')
    const outputsDir = path.join(dir, 'cache', 'outputs')
    await makeTree(projectDir, { 'dist/index.js': 'OUT', 'dist/nested/file.txt': 'NESTED' })
    await makeTree(outputsDir, { 'dist/index.js': 'OUT', 'dist/nested/file.txt': 'NESTED' })

    const match = await outputsMatchCache({
      projectDir,
      outputsDir,
      outputs: ['dist/**'],
      nestedProjectDirs: [],
    })
    expect(match).toBe(true)
  })

  it('returns false when a project file is missing vs cache', async () => {
    const projectDir = path.join(dir, 'project')
    const outputsDir = path.join(dir, 'cache', 'outputs')
    await makeTree(projectDir, { 'dist/index.js': 'OUT' })
    await makeTree(outputsDir, { 'dist/index.js': 'OUT', 'dist/extra.js': 'X' })

    const match = await outputsMatchCache({
      projectDir,
      outputsDir,
      outputs: ['dist/**'],
      nestedProjectDirs: [],
    })
    expect(match).toBe(false)
  })

  it('returns false when a stale extra file is on disk but not in cache', async () => {
    const projectDir = path.join(dir, 'project')
    const outputsDir = path.join(dir, 'cache', 'outputs')
    await makeTree(projectDir, { 'dist/index.js': 'OUT', 'dist/stale.txt': 'STALE' })
    await makeTree(outputsDir, { 'dist/index.js': 'OUT' })

    const match = await outputsMatchCache({
      projectDir,
      outputsDir,
      outputs: ['dist/**'],
      nestedProjectDirs: [],
    })
    expect(match).toBe(false)
  })

  it('returns false when file size differs', async () => {
    const projectDir = path.join(dir, 'project')
    const outputsDir = path.join(dir, 'cache', 'outputs')
    await makeTree(projectDir, { 'dist/index.js': 'SHORT' })
    await makeTree(outputsDir, { 'dist/index.js': 'LONGER-CONTENT' })

    const match = await outputsMatchCache({
      projectDir,
      outputsDir,
      outputs: ['dist/**'],
      nestedProjectDirs: [],
    })
    expect(match).toBe(false)
  })

  it('returns false when cache dir does not exist', async () => {
    const projectDir = path.join(dir, 'project')
    await makeTree(projectDir, { 'dist/index.js': 'OUT' })
    const match = await outputsMatchCache({
      projectDir,
      outputsDir: path.join(dir, 'missing-cache'),
      outputs: ['dist/**'],
      nestedProjectDirs: [],
    })
    expect(match).toBe(false)
  })

  it('returns true when both cache and project are empty', async () => {
    const projectDir = path.join(dir, 'project')
    const outputsDir = path.join(dir, 'cache', 'outputs')
    await mkdir(projectDir, { recursive: true })
    await mkdir(outputsDir, { recursive: true })
    const match = await outputsMatchCache({
      projectDir,
      outputsDir,
      outputs: ['dist/**'],
      nestedProjectDirs: [],
    })
    expect(match).toBe(true)
  })
})
