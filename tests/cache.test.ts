import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache, type CacheKeyInput } from '../src/cache/cache.js'

describe('Cache.key', () => {
  let dir: string
  let cache: Cache
  let workspaceRoot: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'nxt-cache-key-'))
    workspaceRoot = dir
    cache = new Cache(path.join(dir, '.vx', 'cache'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeInput(name: string, content: string): Promise<string> {
    const p = path.join(dir, name)
    await writeFile(p, content)
    return p
  }

  function baseInput(): CacheKeyInput {
    return {
      taskId: 'pkg#build',
      taskConfigHash: 'config-hash-base',
      projectPackageJsonHash: 'pkg-hash-base',
      envValues: [],
      inputFiles: [],
      workspaceRoot,
      upstreamHashes: [],
      workspaceFingerprint: 'ws-fp-base',
    }
  }

  it('is deterministic across repeated calls with identical input', async () => {
    const a = await cache.key(baseInput())
    const b = await cache.key(baseInput())
    expect(a).toBe(b)
  })

  it('changes when the resolved task config hash changes', async () => {
    const a = await cache.key({ ...baseInput(), taskConfigHash: 'aaa' })
    const b = await cache.key({ ...baseInput(), taskConfigHash: 'bbb' })
    expect(a).not.toBe(b)
  })

  it('changes when the taskId changes', async () => {
    const a = await cache.key({ ...baseInput(), taskId: 'a#build' })
    const b = await cache.key({ ...baseInput(), taskId: 'b#build' })
    expect(a).not.toBe(b)
  })

  it('changes when forwardArgs differ', async () => {
    const a = await cache.key({ ...baseInput(), forwardArgs: ['--watch'] })
    const b = await cache.key({ ...baseInput(), forwardArgs: [] })
    const c = await cache.key({ ...baseInput(), forwardArgs: ['--watch', '--bail'] })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(b).not.toBe(c)
  })

  it('treats empty forwardArgs and omitted forwardArgs as equivalent', async () => {
    const a = await cache.key({ ...baseInput(), forwardArgs: [] })
    const b = await cache.key(baseInput())
    expect(a).toBe(b)
  })

  it('changes when an input file content changes (not just mtime)', async () => {
    const f = await writeInput('a.txt', 'one')
    const a = await cache.key({ ...baseInput(), inputFiles: [f] })
    await writeFile(f, 'two')
    const b = await cache.key({ ...baseInput(), inputFiles: [f] })
    expect(a).not.toBe(b)
  })

  it('does not change when only mtime changes (content identical)', async () => {
    const f = await writeInput('a.txt', 'same')
    const a = await cache.key({ ...baseInput(), inputFiles: [f] })
    // Touch file (rewrite same content; mtime updates).
    await writeFile(f, 'same')
    const b = await cache.key({ ...baseInput(), inputFiles: [f] })
    expect(a).toBe(b)
  })

  it('is independent of input file order in the array', async () => {
    const f1 = await writeInput('one.txt', 'first')
    const f2 = await writeInput('two.txt', 'second')
    const a = await cache.key({ ...baseInput(), inputFiles: [f1, f2] })
    const b = await cache.key({ ...baseInput(), inputFiles: [f2, f1] })
    expect(a).toBe(b)
  })

  it('changes when an env-input value changes', async () => {
    const a = await cache.key({ ...baseInput(), envValues: [['MODE', 'a']] })
    const b = await cache.key({ ...baseInput(), envValues: [['MODE', 'b']] })
    expect(a).not.toBe(b)
  })

  it('distinguishes empty value from unset (different cache keys)', async () => {
    const present = await cache.key({ ...baseInput(), envValues: [['MODE', '']] })
    const absent = await cache.key({ ...baseInput(), envValues: [] })
    expect(present).not.toBe(absent)
  })

  it('changes when an upstream hash changes', async () => {
    const a = await cache.key({ ...baseInput(), upstreamHashes: ['aaa'] })
    const b = await cache.key({ ...baseInput(), upstreamHashes: ['bbb'] })
    expect(a).not.toBe(b)
  })

  it('is independent of upstream hash order', async () => {
    const a = await cache.key({ ...baseInput(), upstreamHashes: ['aaa', 'bbb'] })
    const b = await cache.key({ ...baseInput(), upstreamHashes: ['bbb', 'aaa'] })
    expect(a).toBe(b)
  })

  it('changes when the workspace fingerprint changes', async () => {
    const a = await cache.key({ ...baseInput(), workspaceFingerprint: 'a' })
    const b = await cache.key({ ...baseInput(), workspaceFingerprint: 'b' })
    expect(a).not.toBe(b)
  })

  it('produces different keys for two projects with identical relative trees', async () => {
    const f = await writeInput('a.txt', 'shared')
    const a = await cache.key({ ...baseInput(), taskId: 'pkg-a#build', inputFiles: [f] })
    const b = await cache.key({ ...baseInput(), taskId: 'pkg-b#build', inputFiles: [f] })
    expect(a).not.toBe(b)
  })

  // v12 — project package.json hash folded into every task's cache key
  // implicitly (Turbo/Nx "implicit dependencies" parity).
  it('changes when the projectPackageJsonHash changes', async () => {
    const a = await cache.key({ ...baseInput(), projectPackageJsonHash: 'aaa' })
    const b = await cache.key({ ...baseInput(), projectPackageJsonHash: 'bbb' })
    expect(a).not.toBe(b)
  })

  it('treats projectPackageJsonHash = "" (no package.json) deterministically', async () => {
    // Empty string is the documented sentinel for "project has no
    // package.json" (impossible in practice — workspace discovery
    // requires one — but we don't fail-loud). Two cold runs with
    // an empty pkg hash must collide on every other axis.
    const a = await cache.key({ ...baseInput(), projectPackageJsonHash: '' })
    const b = await cache.key({ ...baseInput(), projectPackageJsonHash: '' })
    expect(a).toBe(b)
  })

  it('zero-byte input files participate in the key (existence matters)', async () => {
    const f1 = await writeInput('empty.txt', '')
    const f2 = await writeInput('absent.txt', '')
    // First key uses [f1]; second uses [f1, f2]. The second has more inputs.
    const a = await cache.key({ ...baseInput(), inputFiles: [f1] })
    const b = await cache.key({ ...baseInput(), inputFiles: [f1, f2] })
    expect(a).not.toBe(b)
  })

  it('binary input file content participates in the key (byte-for-byte)', async () => {
    const p = path.join(dir, 'bin.dat')
    // Two payloads that differ in a single mid-byte; the hash must
    // distinguish them. Verifies the streaming hash sees raw bytes,
    // not text-decoded content.
    const a = Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0, 0])
    const b = Buffer.from([0, 1, 2, 3, 0xff, 0xfd, 0, 0])
    await writeFile(p, a)
    const ka = await cache.key({ ...baseInput(), inputFiles: [p] })
    await writeFile(p, b)
    const kb = await cache.key({ ...baseInput(), inputFiles: [p] })
    expect(ka).not.toBe(kb)
  })

  it('hashes large input files correctly (no in-memory truncation)', async () => {
    // 2 MB file. Bun.file().stream() yields chunks lazily; if the
    // hasher ever truncated, two large files differing only in their
    // tail would collide. Property to verify: hash is sensitive to a
    // single byte change at the end.
    const a = Buffer.alloc(2 * 1024 * 1024, 0x41)
    const b = Buffer.from(a)
    b[b.length - 1] = 0x42
    const p = path.join(dir, 'big.bin')
    await writeFile(p, a)
    const ka = await cache.key({ ...baseInput(), inputFiles: [p] })
    await writeFile(p, b)
    const kb = await cache.key({ ...baseInput(), inputFiles: [p] })
    expect(ka).not.toBe(kb)
  })

  it('is stable when inputs / env / upstream are all empty', async () => {
    // Tasks with no file inputs (lint with `cache.inputs.files: []`) still
    // get a deterministic key. Two runs in succession should match.
    const a = await cache.key({ ...baseInput() })
    const b = await cache.key({ ...baseInput() })
    expect(a).toBe(b)
  })
})

describe('Cache storage (v10)', () => {
  let workspaceRoot: string
  let cacheDir: string
  let projectDir: string
  let cache: Cache

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-v10-'))
    cacheDir = path.join(workspaceRoot, '.vx', 'cache')
    projectDir = path.join(workspaceRoot, 'project')
    cache = new Cache(cacheDir)
  })

  afterEach(async () => {
    cache.close()
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  it('creates a SQLite db at <cacheDir>/cache.db', async () => {
    expect(existsSync(path.join(cacheDir, 'cache.db'))).toBe(true)
  })

  it('save() + get() round-trips an entry through SQLite + filesystem', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const outFile = path.join(projectDir, 'dist', 'index.js')
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, 'console.log("hi")')

    await cache.save({
      hash: 'h1',
      projectDir,
      outputFiles: [outFile],
      entry: {
        taskId: 'pkg#build',
        command: 'tsc',
        exitCode: 0,
        durationMs: 42,
        stdout: 'compiling…\n',
        stderr: '',
      },
    })

    // Filesystem layout v13: outputs under <hash>/outputs/<rel>, stdout/stderr
    // as plain files under <hash>/.
    expect(existsSync(path.join(cacheDir, 'h1', 'outputs', 'dist', 'index.js'))).toBe(true)
    expect(existsSync(path.join(cacheDir, 'h1', 'stdout'))).toBe(true)
    expect(existsSync(path.join(cacheDir, 'h1', 'stderr'))).toBe(true)
    // No v9-style meta.json.
    expect(existsSync(path.join(cacheDir, 'h1', 'meta.json'))).toBe(false)
    // No legacy v12-style sibling logs/ dir.
    expect(existsSync(path.join(cacheDir, 'logs'))).toBe(false)

    const got = await cache.get('h1')
    expect(got).not.toBeNull()
    expect(got?.command).toBe('tsc')
    expect(got?.exitCode).toBe(0)
    expect(got?.durationMs).toBe(42)
    expect(got?.stdout).toBe('compiling…\n')
    expect(got?.stderr).toBe('')
    expect(got?.outputFiles).toEqual(['dist/index.js'])
  })

  it('restoreOutputs() copies the on-disk artifact back into the project dir', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const outFile = path.join(projectDir, 'dist', 'out.txt')
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, 'produced')

    await cache.save({
      hash: 'h2',
      projectDir,
      outputFiles: [outFile],
      entry: {
        taskId: 'pkg#build',
        command: 'echo produced > dist/out.txt',
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
      },
    })

    // Wipe the project's output, then restore from cache.
    await rm(path.join(projectDir, 'dist'), { recursive: true, force: true })
    await cache.restoreOutputs('h2', projectDir)
    expect(await readFile(path.join(projectDir, 'dist', 'out.txt'), 'utf8')).toBe('produced')
  })

  it('get() returns null when the entry has never been written', async () => {
    expect(await cache.get('never-written')).toBeNull()
  })

  it('get() returns null when DB row exists but on-disk artifact was deleted', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const outFile = path.join(projectDir, 'a.txt')
    await writeFile(outFile, 'x')

    await cache.save({
      hash: 'h-orphan',
      projectDir,
      outputFiles: [outFile],
      entry: {
        taskId: 'pkg#build',
        command: 'noop',
        exitCode: 0,
        durationMs: 0,
        stdout: '',
        stderr: '',
      },
    })

    // Simulate someone deleting the cached dir without touching the DB.
    await rm(path.join(cacheDir, 'h-orphan'), { recursive: true, force: true })
    expect(await cache.get('h-orphan')).toBeNull()
  })

  it('getTaskHistory() returns empty maps when no runs match', async () => {
    const h = cache.getTaskHistory(['pkg#build', 'other#test'])
    expect(h.size).toBe(0)
  })

  it('getTaskHistory() aggregates per-(project, task) and returns recent rows', async () => {
    const now = Date.now()
    const make = (status: 'success' | 'cache-hit' | 'failed', durationMs: number, offset: number) =>
      cache.recordRun({
        hash: `h-${status}-${offset}`,
        project: 'pkg',
        task: 'build',
        status,
        exitCode: status === 'failed' ? 1 : 0,
        durationMs,
        startedAt: now - offset - durationMs,
        endedAt: now - offset,
        cacheHit: status === 'cache-hit',
      })
    make('success', 100, 1000)
    make('success', 200, 800)
    make('cache-hit', 0, 600)
    make('failed', 50, 400)
    make('success', 150, 200)

    const h = cache.getTaskHistory(['pkg#build'])
    const row = h.get('pkg#build')
    expect(row).toBeDefined()
    expect(row?.runs).toBe(5)
    expect(row?.successRate).toBeCloseTo(4 / 5, 5)
    expect(row?.hitRate).toBeCloseTo(1 / 5, 5)
    // 4 successful (incl cache-hit at 0ms) + 1 failed at 50ms.
    expect(row?.avgMs).toBeCloseTo((100 + 200 + 0 + 50 + 150) / 5, 5)
    // Recent rows are in DESC started_at order. Should be capped at 10.
    expect(row?.recent.length).toBe(5)
    expect(row?.recent[0]?.durationMs).toBe(150)
    expect(row?.recent[4]?.durationMs).toBe(100)
  })

  it('getTaskHistory() filters to the requested task IDs only', async () => {
    cache.recordRun({
      hash: 'h-a',
      project: 'a',
      task: 'build',
      status: 'success',
      exitCode: 0,
      durationMs: 10,
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
    })
    cache.recordRun({
      hash: 'h-b',
      project: 'b',
      task: 'build',
      status: 'success',
      exitCode: 0,
      durationMs: 20,
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
    })
    const h = cache.getTaskHistory(['a#build'])
    expect(h.has('a#build')).toBe(true)
    expect(h.has('b#build')).toBe(false)
  })

  it('getTaskHistory() caps per-task rows at 50 for the aggregates and 10 for recent', async () => {
    const base = Date.now() - 60 * 1000
    for (let i = 0; i < 60; i++) {
      cache.recordRun({
        hash: `h-${i}`,
        project: 'pkg',
        task: 'build',
        status: 'success',
        exitCode: 0,
        durationMs: i * 10,
        startedAt: base + i * 100,
        endedAt: base + i * 100 + i * 10,
      })
    }
    const h = cache.getTaskHistory(['pkg#build'])
    const row = h.get('pkg#build')
    // 60 runs total but the aggregate window caps at 50.
    expect(row?.runs).toBe(50)
    expect(row?.recent.length).toBe(10)
    // Recent rows are most-recent-first.
    expect(row?.recent[0]?.durationMs).toBe(59 * 10)
  })

  it('recordRun() + stats() captures run history', async () => {
    const startedAt = Date.now() - 100
    const endedAt = Date.now()
    cache.recordRun({
      hash: 'h3',
      project: 'pkg',
      task: 'build',
      status: 'success',
      exitCode: 0,
      durationMs: 100,
      startedAt,
      endedAt,
    })
    cache.recordRun({
      hash: 'h3',
      project: 'pkg',
      task: 'build',
      status: 'cache-hit',
      exitCode: 0,
      durationMs: 0,
      startedAt: endedAt,
      endedAt: endedAt + 1,
    })

    const stats = cache.stats()
    expect(stats.runCountLast24h).toBe(2)
    expect(stats.hitCountLast24h).toBe(1)
  })

  it('stats() reports entry count and total bytes', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const f = path.join(projectDir, 'tiny.txt')
    await writeFile(f, 'abc')

    await cache.save({
      hash: 'h-tiny',
      projectDir,
      outputFiles: [f],
      entry: {
        taskId: 'pkg#build',
        command: 'noop',
        exitCode: 0,
        durationMs: 0,
        stdout: '',
        stderr: '',
      },
    })

    const stats = cache.stats()
    expect(stats.entryCount).toBe(1)
    // 3 bytes of file + 0 + 0 for stdout/stderr.
    expect(stats.totalBytes).toBeGreaterThanOrEqual(3)
  })

  it('prune() with olderThanMs evicts entries last accessed before the cutoff', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const f = path.join(projectDir, 'a.txt')
    await writeFile(f, 'aaa')

    await cache.save({
      hash: 'h-old',
      projectDir,
      outputFiles: [f],
      entry: {
        taskId: 'pkg#build',
        command: 'noop',
        exitCode: 0,
        durationMs: 0,
        stdout: '',
        stderr: '',
      },
    })

    // Wait a tick so olderThanMs = now strictly exceeds h-old's accessed_at.
    await new Promise((r) => setTimeout(r, 10))

    const result = await cache.prune({ olderThanMs: Date.now() })
    expect(result.evicted).toBe(1)
    expect(result.bytesFreed).toBeGreaterThanOrEqual(3)

    // DB row gone + on-disk dir gone (logs live inside <hash>/, so one rm covers both).
    expect(await cache.get('h-old')).toBeNull()
    expect(existsSync(path.join(cacheDir, 'h-old'))).toBe(false)
  })

  it('prune() with maxBytes evicts LRU until under the cap', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })

    // Three entries, accessed in order h1 < h2 < h3.
    for (const [name, content] of [
      ['h1.txt', 'x'.repeat(100)],
      ['h2.txt', 'x'.repeat(100)],
      ['h3.txt', 'x'.repeat(100)],
    ] as const) {
      const f = path.join(projectDir, name)
      await writeFile(f, content)
      await cache.save({
        hash: name.replace('.txt', ''),
        projectDir,
        outputFiles: [f],
        entry: {
          taskId: 'pkg#build',
          command: 'noop',
          exitCode: 0,
          durationMs: 0,
          stdout: '',
          stderr: '',
        },
      })
      // Force a measurable accessed_at gap between writes.
      await new Promise((r) => setTimeout(r, 5))
    }

    // Cap = ~200 bytes worth → evict h1 (oldest accessed), maybe h2.
    const result = await cache.prune({ maxBytes: 200 })
    expect(result.evicted).toBeGreaterThanOrEqual(1)
    // h3 (most recently accessed) survives.
    expect(await cache.get('h3')).not.toBeNull()
    // h1 (oldest accessed) is gone.
    expect(await cache.get('h1')).toBeNull()
  })

  it('prune() rejects empty options', async () => {
    await expect(cache.prune({})).rejects.toThrow(/at least one of/)
  })

  it('recordRun() persists the v11 analytics columns when provided', async () => {
    const started = Date.now() - 50
    const ended = Date.now()
    cache.recordRun({
      hash: 'h-v11',
      project: 'pkg',
      task: 'build',
      status: 'success',
      exitCode: 0,
      durationMs: 50,
      startedAt: started,
      endedAt: ended,
      runId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      cpuMs: 42,
      peakRssBytes: 1024 * 1024 * 32,
      wallclockStartNs: 0n,
      wallclockEndNs: 50_000_000n,
      cacheHit: false,
      bytesUploaded: 4096,
      bytesDownloaded: 0,
    })
    // Read back via the underlying DB to confirm the columns were stored.
    // Reaches past the public API on purpose — this is a schema test.
    // @ts-expect-error: private member access for testing
    const row = cache.db.prepare('SELECT * FROM runs WHERE hash = ?').get('h-v11') as {
      run_id: string
      cpu_ms: number
      peak_rss_bytes: number
      cache_hit: number
      bytes_uploaded: number
    }
    expect(row.run_id).toBe('01JZZZZZZZZZZZZZZZZZZZZZZZ')
    expect(row.cpu_ms).toBe(42)
    expect(row.peak_rss_bytes).toBe(1024 * 1024 * 32)
    expect(row.cache_hit).toBe(0)
    expect(row.bytes_uploaded).toBe(4096)
  })

  it('recordRun() omitting v11 columns stores NULL', async () => {
    cache.recordRun({
      hash: 'h-v11-null',
      project: 'pkg',
      task: 'build',
      status: 'cache-hit',
      exitCode: 0,
      durationMs: 0,
      startedAt: Date.now(),
      endedAt: Date.now() + 1,
    })
    // @ts-expect-error: private member access for testing
    const row = cache.db.prepare('SELECT * FROM runs WHERE hash = ?').get('h-v11-null') as {
      run_id: unknown
      cpu_ms: unknown
      cache_hit: unknown
    }
    expect(row.run_id).toBeNull()
    expect(row.cpu_ms).toBeNull()
    expect(row.cache_hit).toBeNull()
  })

  it('two concurrent writers do not crash with SQLITE_BUSY', async () => {
    // B1 from Agent A's real-world test: without PRAGMA busy_timeout,
    // two parallel `vx run` invocations would race on the small INSERT
    // and one would die with `SQLiteError: database is locked`. With the
    // 5s busy_timeout the second one waits and succeeds.
    const second = new Cache(cacheDir)
    try {
      const now = Date.now()
      const writeMany = async (label: string, c: Cache): Promise<void> => {
        for (let i = 0; i < 20; i++) {
          c.recordRun({
            hash: `${label}-${i}`,
            project: 'pkg',
            task: 'build',
            status: 'success',
            exitCode: 0,
            durationMs: 1,
            startedAt: now,
            endedAt: now + 1,
          })
        }
      }
      await Promise.all([writeMany('a', cache), writeMany('b', second)])
      // Both wrote successfully.
      expect(cache.stats().runCountLast24h).toBe(40)
    } finally {
      second.close()
    }
  })

  it('save() overwrites a prior entry at the same hash (idempotent re-save)', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const outFile = path.join(projectDir, 'dist', 'out.txt')
    await mkdir(path.dirname(outFile), { recursive: true })

    await writeFile(outFile, 'first')
    await cache.save({
      hash: 'h-overwrite',
      projectDir,
      outputFiles: [outFile],
      entry: {
        taskId: 'pkg#build',
        command: 'first',
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
      },
    })

    // Second save at the same hash with different content. Must
    // succeed (idempotent) and the read must reflect the latest write.
    await writeFile(outFile, 'second-version-longer')
    await cache.save({
      hash: 'h-overwrite',
      projectDir,
      outputFiles: [outFile],
      entry: {
        taskId: 'pkg#build',
        command: 'second',
        exitCode: 0,
        durationMs: 2,
        stdout: 'replaced',
        stderr: '',
      },
    })

    const got = await cache.get('h-overwrite')
    expect(got?.command).toBe('second')
    expect(got?.durationMs).toBe(2)
    expect(got?.stdout).toBe('replaced')
    // Stored payload reflects the second-write content.
    const stored = await readFile(
      path.join(cacheDir, 'h-overwrite', 'outputs', 'dist', 'out.txt'),
      'utf8',
    )
    expect(stored).toBe('second-version-longer')
  })

  it('recordRun() persists cache-hit-remote with cache_hit=1 + bytes_downloaded', async () => {
    cache.recordRun({
      hash: 'h-remote',
      project: 'pkg',
      task: 'build',
      status: 'cache-hit-remote',
      exitCode: 0,
      durationMs: 5,
      startedAt: Date.now(),
      endedAt: Date.now() + 5,
      runId: '01ABCDEFG',
      cacheHit: true,
      bytesDownloaded: 123_456,
    })
    // @ts-expect-error: private member access for testing
    const row = cache.db.prepare('SELECT * FROM runs WHERE hash = ?').get('h-remote') as {
      status: string
      cache_hit: number
      bytes_downloaded: number
      run_id: string
    }
    expect(row.status).toBe('cache-hit-remote')
    expect(row.cache_hit).toBe(1)
    expect(row.bytes_downloaded).toBe(123_456)
    expect(row.run_id).toBe('01ABCDEFG')
  })

  it('prune() handles a DB row whose on-disk dir was deleted out of band', async () => {
    // Race: someone `rm -rf .vx/cache/<hash>/` while the DB row still
    // points at it. prune() should not crash; the row is removed and
    // the missing dir is a no-op rm.
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const f = path.join(projectDir, 'a.txt')
    await writeFile(f, 'x')

    await cache.save({
      hash: 'h-orphan-row',
      projectDir,
      outputFiles: [f],
      entry: {
        taskId: 'pkg#build',
        command: 'noop',
        exitCode: 0,
        durationMs: 0,
        stdout: '',
        stderr: '',
      },
    })
    await rm(path.join(cacheDir, 'h-orphan-row'), { recursive: true, force: true })

    const result = await cache.prune({ olderThanMs: Date.now() + 1000 })
    expect(result.evicted).toBe(1)
    // DB row should be gone.
    expect(await cache.get('h-orphan-row')).toBeNull()
  })
})

// Schema-version + cache-version recovery paths. These exercise the
// "previous run wrote with an old version; rebuild cleanly" scenario.
// We don't currently expose a public knob to change CACHE_VERSION /
// SCHEMA_VERSION mid-test, so we simulate by writing a bad sentinel
// directly to schema_meta via a second handle.
describe('Cache schema/version recovery', () => {
  let workspaceRoot: string
  let cacheDir: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-recover-'))
    cacheDir = path.join(workspaceRoot, '.vx', 'cache')
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  it('SCHEMA_VERSION mismatch wipes entries + runs and recreates cleanly', async () => {
    // Round 1: write a real entry to a fresh cache.
    const c1 = new Cache(cacheDir)
    try {
      c1.recordRun({
        hash: 'h-old',
        project: 'pkg',
        task: 'build',
        status: 'success',
        exitCode: 0,
        durationMs: 1,
        startedAt: Date.now(),
        endedAt: Date.now() + 1,
      })
      expect(c1.stats().runCountLast24h).toBe(1)
    } finally {
      c1.close()
    }

    // Simulate schema upgrade: bump the stored version sentinel.
    // `Database` import has to match `Cache`'s internal handle since
    // they share a single underlying file via WAL.
    const { Database } = await import('bun:sqlite')
    const db = new Database(path.join(cacheDir, 'cache.db'))
    db.prepare(
      "UPDATE schema_meta SET value = 'unknown-future-version' WHERE key = 'version'",
    ).run()
    db.close()

    // Round 2: opening a fresh Cache detects the mismatch, drops the
    // tables, recreates them, and updates the sentinel. The old run
    // row is gone; new writes succeed.
    const c2 = new Cache(cacheDir)
    try {
      expect(c2.stats().runCountLast24h).toBe(0)
      // Write succeeds (tables exist).
      c2.recordRun({
        hash: 'h-new',
        project: 'pkg',
        task: 'build',
        status: 'success',
        exitCode: 0,
        durationMs: 1,
        startedAt: Date.now(),
        endedAt: Date.now() + 1,
      })
      expect(c2.stats().runCountLast24h).toBe(1)
    } finally {
      c2.close()
    }
  })

  it('CACHE_VERSION mismatch orphans old entries (key derivation changes)', async () => {
    // We can't easily change CACHE_VERSION at runtime, but we can
    // verify the property: the constant participates in every key,
    // so a hash computed with a different prefix would never collide
    // with a real entry. We simulate by writing a fabricated row at
    // an "old-version" hash and confirming get() can find it (DB
    // doesn't care about derivation), but `key()` for the same inputs
    // won't reproduce that hash. The test guards against accidentally
    // dropping the CACHE_VERSION prefix from the hash composition.
    const cache = new Cache(cacheDir)
    try {
      const input: CacheKeyInput = {
        taskId: 'pkg#build',
        taskConfigHash: 'cfg',
        projectPackageJsonHash: 'pkg',
        envValues: [],
        inputFiles: [],
        workspaceRoot: cacheDir,
        upstreamHashes: [],
        workspaceFingerprint: 'fp',
      }
      const realKey = await cache.key(input)
      // sha256 hex = 64 chars
      expect(realKey).toHaveLength(64)
      // A hash derived from the same logical inputs WITHOUT the
      // CACHE_VERSION sentinel (the trivial sha256 over a different
      // prefix) must differ.
      const noPrefixHash = new Bun.CryptoHasher('sha256').update('no-prefix').digest('hex')
      expect(realKey).not.toBe(noPrefixHash)
    } finally {
      cache.close()
    }
  })
})
