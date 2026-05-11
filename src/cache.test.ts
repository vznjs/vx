import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache, type CacheKeyInput } from './cache.js'

describe('Cache.key', () => {
  let dir: string
  let cache: Cache
  let workspaceRoot: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'nxt-cache-key-'))
    workspaceRoot = dir
    cache = new Cache(path.join(dir, '.vzn', 'cache'))
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
})

describe('Cache storage (v10)', () => {
  let workspaceRoot: string
  let cacheDir: string
  let projectDir: string
  let cache: Cache

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vzn-cache-v10-'))
    cacheDir = path.join(workspaceRoot, '.vzn', 'cache')
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

    // Filesystem layout matches v10: outputs directly under <hash>/, logs in logs/<hash>.{stdout,stderr}.
    expect(existsSync(path.join(cacheDir, 'h1', 'dist', 'index.js'))).toBe(true)
    expect(existsSync(path.join(cacheDir, 'logs', 'h1.stdout'))).toBe(true)
    expect(existsSync(path.join(cacheDir, 'logs', 'h1.stderr'))).toBe(true)
    // No v9-style meta.json.
    expect(existsSync(path.join(cacheDir, 'h1', 'meta.json'))).toBe(false)

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

    // DB row gone + on-disk dir gone.
    expect(await cache.get('h-old')).toBeNull()
    expect(existsSync(path.join(cacheDir, 'h-old'))).toBe(false)
    expect(existsSync(path.join(cacheDir, 'logs', 'h-old.stdout'))).toBe(false)
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
    // two parallel `vzn run` invocations would race on the small INSERT
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
})
