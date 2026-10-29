// Tests for the cache-hit-path performance optimizations added in
// the `cache-hit-perf` PR. Each test targets one specific behavior
// rather than asserting wall-clock time (which is too flaky for CI).

import { indexDb } from '../src/cache/index.js'
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, utimes, stat, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ArtifactVanishedError,
  Cache,
  type RunRecord,
  FILE_HASH_RACY_MS,
} from '../src/cache/cache.js'
import { isInline, storedArtifact } from './helpers/stored-artifact.js'
import { TAR_STORE } from './helpers/tar-store.js'

/** Git blob OID (sha1 domain — fixtures live outside any repo). */
function blobOid(content: string): string {
  const bytes = new TextEncoder().encode(content)
  const hasher = new Bun.CryptoHasher('sha1')
  hasher.update(`blob ${bytes.byteLength}\0`)
  hasher.update(bytes)
  return hasher.digest('hex')
}

describe('Cache.hashFile (mtime+size fast path)', () => {
  let dir: string
  let cache: Cache

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-hashfile-'))
    cache = new Cache(
      path.join(dir, '.vx-cache'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
  })

  afterEach(async () => {
    cache.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the git blob OID on first call (cold path)', async () => {
    const f = path.join(dir, 'hello.txt')
    await writeFile(f, 'hello world')
    const h = await cache.hashFile(f)
    // git's well-known blob OID for "hello world" (no trailing newline).
    expect(h).toBe('95d09f2b10159347eece71399a7e2e907ea3df4f')
    expect(h).toBe(blobOid('hello world'))
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
    // Hash matches the blob OID of the new bytes.
    expect(second).toBe(blobOid('v2-longer-content'))
  })

  it('reuses stored digest when nothing about the file changed', async () => {
    // The memo's reason for existing: an untouched file is answered from
    // SQLite with no disk read. We cannot observe "did we read?" without
    // mocking fs, so assert the observable half — a second call on an
    // untouched file returns the same digest, and it is the RIGHT one.
    const f = path.join(dir, 'pinned.txt')
    await writeFile(f, 'AAAAAA')
    const firstHash = await cache.hashFile(f)
    expect(await cache.hashFile(f)).toBe(firstHash)
    expect(firstHash).toBe(blobOid('AAAAAA'))
  })

  it('does NOT reuse the digest when content changes with mtime preserved', async () => {
    // This case used to be recorded as an accepted "fast-path tradeoff" and
    // asserted the STALE digest. It is not a tradeoff, it is a stale cache
    // hit: `tar -x`, `unzip`, `cp -p`, `rsync --times` and SOURCE_DATE_EPOCH
    // generators all preserve mtime, so vx would replay an artifact built
    // from bytes that no longer exist. ctime is what closes it — `utimes`
    // cannot suppress ctime without root.
    const f = path.join(dir, 'pinned.txt')
    await writeFile(f, 'AAAAAA')
    const firstHash = await cache.hashFile(f)
    const s = await stat(f)
    // Same byte length, mtime forced back to what the first call recorded.
    await writeFile(f, 'BBBBBB')
    await utimes(f, s.atime, s.mtime)
    const secondHash = await cache.hashFile(f)
    expect(secondHash).not.toBe(firstHash)
    expect(secondHash).toBe(blobOid('BBBBBB'))
  })

  it('does not memoise a file changed within the racy window, and does once it has aged', async () => {
    // A rewrite landing in the same tick as the recorded stat keeps ctime,
    // size and inode equal (mtime can be restored), so a row stored from
    // that tick would serve a stale digest. The row is withheld until the
    // file is older than the window. The in-window half must PROVE it was
    // inside the window from the file's own ctime — a loaded box can put
    // more than 50 ms between the write and the hash, and then a stored
    // row is the correct outcome, not a failure.
    const f = path.join(dir, 'young.txt')
    const rows = () =>
      (
        indexDb(cache).query('SELECT COUNT(*) AS n FROM file_hashes WHERE path = ?').get(f) as {
          n: number
        }
      ).n
    let inWindow = false
    for (let attempt = 0; attempt < 50 && !inWindow; attempt++) {
      await writeFile(f, `AAAAAA${attempt}`)
      await cache.hashFile(f)
      const age = Date.now() - Math.floor((await stat(f)).ctimeMs)
      if (age < FILE_HASH_RACY_MS - 5) {
        inWindow = true
        expect(rows()).toBe(0) // fresh: hashed, not memoised
      }
      indexDb(cache).query('DELETE FROM file_hashes WHERE path = ?').run(f)
    }
    expect(inWindow).toBe(true) // the box managed one write+hash inside the window
    const first = await cache.hashFile(f)
    await Bun.sleep(FILE_HASH_RACY_MS + 20)
    expect(await cache.hashFile(f)).toBe(first)
    expect(rows()).toBe(1) // aged: memoised now
  })

  it('does NOT reuse the digest across an atomic write-then-rename', async () => {
    // The other way a producer keeps mtime AND size: build a temp file and
    // rename it into place. ctime moves, and so does the inode.
    const f = path.join(dir, 'renamed.txt')
    const tmp = path.join(dir, 'renamed.tmp')
    await writeFile(f, 'AAAAAA')
    const firstHash = await cache.hashFile(f)
    const s = await stat(f)
    await writeFile(tmp, 'BBBBBB')
    await rename(tmp, f)
    await utimes(f, s.atime, s.mtime)
    expect(await cache.hashFile(f)).toBe(blobOid('BBBBBB'))
    expect(await cache.hashFile(f)).not.toBe(firstHash)
  })
})

describe('Cache.recordRuns (batched)', () => {
  let dir: string
  let cache: Cache

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-recordRuns-'))
    cache = new Cache(
      path.join(dir, '.vx-cache'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
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
    const cache2 = new Cache(dir2, undefined, undefined, undefined, undefined, undefined, TAR_STORE)
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
    cache = new Cache(
      path.join(dir, '.vx-cache'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
  })

  afterEach(async () => {
    cache.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('taskConfig memo returns identical hash on repeated calls (same object)', async () => {
    const { createHashCache, computeTaskHash } = await import('../src/orchestrator/task-hash.ts')
    const hashCache = createHashCache()
    const sharedConfig = {
      exec: { command: 'noop' },
      inputs: { files: [] },
      cache: { outputs: { files: [] } },
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
      cache,
      nestedProjectDirs: [],
      hashCache,
    })
    const h2 = await computeTaskHash({
      node,
      upstream: [],
      workspaceRoot: dir,
      cache,
      nestedProjectDirs: [],
      hashCache,
    })
    expect(h2).toBe(h1)
    // The WeakMap should have the config in it after the first call.
    expect(hashCache.taskConfig.has(sharedConfig)).toBe(true)
  })
})

describe('cache layout v15: <hash>.tar single file (Turbo-style)', () => {
  let dir: string
  let cache: Cache
  let projectDir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-'))
    cache = new Cache(
      path.join(dir, '.vx-cache'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
    projectDir = path.join(dir, 'project')
    await mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    cache.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function saveSample(
    hash: string,
    files: Record<string, string | Uint8Array>,
  ): Promise<void> {
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
        durationMs: 5,
        stdout: 'compiling…',
      },
    })
  }

  it('save writes a large artifact as a single <hash>.tar.zst file (not a directory)', async () => {
    const big = crypto.getRandomValues(new Uint8Array(48 * 1024))
    await saveSample('h-tar', { 'dist/a.js': big, 'dist/b.js': 'B' })
    const cacheDir = path.join(dir, '.vx-cache')
    // The artifact is one file, not a directory tree.
    const stats = await stat(path.join(cacheDir, 'h-tar.tar.zst'))
    expect([stats.isFile(), isInline(cache, 'h-tar')]).toEqual([true, false])
    // No more <hash>/ subdir layout.
    expect(await Bun.file(path.join(cacheDir, 'h-tar', 'outputs', 'dist', 'a.js')).exists()).toBe(
      false,
    )
  })

  it('save keeps a small artifact as one row in the index, with no file', async () => {
    await saveSample('h-row', { 'dist/a.js': 'A', 'dist/b.js': 'B' })
    const cacheDir = path.join(dir, '.vx-cache')
    expect([
      isInline(cache, 'h-row'),
      await Bun.file(path.join(cacheDir, 'h-row.tar.zst')).exists(),
    ]).toEqual([true, false])
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

  it('restoreOutputs REFUSES when the artifact is missing', async () => {
    // This used to return quietly, which is silent data loss: the caller has
    // already wiped the declared outputs by the time it restores, so a quiet
    // return reports a green cache hit over an emptied output tree.
    // Gone, not corrupt: the caller turns it into a miss (vanished-artifact.test.ts).
    await expect(cache.restoreOutputs('does-not-exist', projectDir)).rejects.toBeInstanceOf(
      ArtifactVanishedError,
    )
  })

  it('outputsPath returns the tar file path', () => {
    const p = cache.outputsPath('h-path')
    expect(p.endsWith('h-path.tar.zst')).toBe(true)
  })

  it('prune removes the artifacts, inline and file alike', async () => {
    await saveSample('h-prune', { 'a.txt': 'a' })
    await saveSample('h-prune-file', { 'a.txt': crypto.getRandomValues(new Uint8Array(48 * 1024)) })
    const cacheDir = path.join(dir, '.vx-cache')
    expect([
      isInline(cache, 'h-prune'),
      await Bun.file(path.join(cacheDir, 'h-prune-file.tar.zst')).exists(),
    ]).toEqual([true, true])
    await cache.prune({ olderThanMs: Date.now() + 2 * 60 * 60 * 1000 }) // evict everything
    expect([
      storedArtifact(cache, 'h-prune'),
      await Bun.file(path.join(cacheDir, 'h-prune-file.tar.zst')).exists(),
    ]).toEqual([null, false])
  })
})
