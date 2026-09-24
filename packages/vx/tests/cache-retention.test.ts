// Item 658: the workspace's `cacheRetention` evicts from the local cache at
// the end of a run, by the policy `vx cache prune` takes as flags. Three
// claims are held here: `evictIfDue` evicts exactly what `prune` would and
// nothing when nothing is due; an entry the run itself just used is not
// due for its stale timestamp (the deferred `accessed_at` bump lands first,
// so no prune runs for it); and a workspace that declares no retention
// evicts nothing.

import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import type { WorkspaceConfig } from '../src/config.js'
import { run, type Logger } from '../src/index.js'
import { validateWorkspace } from '../src/workspace/config-schema.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const DAY = 86_400_000

describe('Cache.evictIfDue', () => {
  let root: string
  let cacheDir: string
  let projectDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-retention-'))
    cacheDir = path.join(root, 'cache')
    projectDir = path.join(root, 'proj')
    await mkdir(path.join(projectDir, 'dist'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function seed(cache: Cache, hashes: readonly string[]): Promise<void> {
    for (const hash of hashes) {
      const out = path.join(projectDir, 'dist', `${hash}.txt`)
      await writeFile(out, hash.repeat(64))
      await cache.save({
        hash,
        projectDir,
        outputFiles: [out],
        entry: { taskId: `p#${hash}`, command: `echo ${hash}`, durationMs: 1, stdout: '' },
      })
    }
  }

  /** Set an entry's `accessed_at` behind the handle's back (a fresh connection). */
  function age(hash: string, accessedAt: number): void {
    const db = new Database(path.join(cacheDir, 'cache.db'))
    db.query('UPDATE entries SET accessed_at = ? WHERE hash = ?').run(accessedAt, hash)
    db.close()
  }

  function hashes(cache: Cache): string[] {
    return (
      cache.dbHandle().query('SELECT hash FROM entries ORDER BY hash').all() as Array<{
        hash: string
      }>
    ).map((r) => r.hash)
  }

  it('evicts an entry unused for longer than maxAge, and only that one', async () => {
    const cache = new Cache(cacheDir)
    try {
      await seed(cache, ['aa', 'bb'])
      const now = Date.now()
      age('aa', now - 40 * DAY)
      const result = await cache.evictIfDue({ maxAgeMs: 30 * DAY }, now)
      expect(result?.evicted).toBe(1)
      expect(hashes(cache)).toEqual(['bb'])
      expect(existsSync(path.join(cacheDir, 'aa.tar.zst'))).toBe(false)
      expect(existsSync(path.join(cacheDir, 'bb.tar.zst'))).toBe(true)
    } finally {
      cache.close()
    }
  })

  /** Plant a row-less artifact of `bytes`, last written `agoMs` ago. */
  async function orphan(name: string, bytes: number, agoMs: number): Promise<string> {
    const file = path.join(cacheDir, `${name}.tar.zst`)
    await writeFile(file, new Uint8Array(bytes))
    const when = new Date(Date.now() - agoMs)
    await utimes(file, when, when)
    return file
  }

  it('does nothing — not even the orphan sweep — when nothing is due', async () => {
    const cache = new Cache(cacheDir)
    try {
      await seed(cache, ['aa', 'bb'])
      // A new cache has never been swept: the first call sweeps (below).
      await cache.evictIfDue({ maxAgeMs: 30 * DAY })
      const prune = spyOn(cache, 'prune')
      const scan = spyOn(cache as unknown as { scanOrphans: () => unknown }, 'scanOrphans')
      expect(await cache.evictIfDue({ maxAgeMs: 30 * DAY, maxBytes: 1024 ** 3 })).toBeNull()
      expect(prune).not.toHaveBeenCalled()
      expect(scan).not.toHaveBeenCalled()
      expect(hashes(cache)).toEqual(['aa', 'bb'])
      // CONTROL: the same handle, a policy that is due, reaches prune.
      expect(await cache.evictIfDue({ maxBytes: 1 })).not.toBeNull()
      expect(prune).toHaveBeenCalledTimes(1)
    } finally {
      cache.close()
    }
  })

  it('an entry this handle just used is not due, so nothing is pruned', async () => {
    // The run restored `aa` a moment ago; its `accessed_at` bump is still
    // deferred, so the index says 40 days. `prune` flushes before it picks
    // victims, so the entry would survive either way; what the flush in
    // `evictIfDue` decides is whether a prune (and its orphan sweep's
    // readdir) runs at all on a cache with nothing due.
    const cache = new Cache(cacheDir)
    try {
      await seed(cache, ['aa', 'bb'])
      await cache.evictIfDue({ maxAgeMs: 1000 * DAY })
      const now = Date.now()
      age('aa', now - 40 * DAY)
      expect(await cache.get('aa')).not.toBeNull()
      const prune = spyOn(cache, 'prune')
      expect(await cache.evictIfDue({ maxAgeMs: 30 * DAY }, now)).toBeNull()
      expect(prune).not.toHaveBeenCalled()
      expect(hashes(cache)).toEqual(['aa', 'bb'])
      // CONTROL: the same age on an entry nobody used is due, and evicted.
      age('bb', now - 40 * DAY)
      expect((await cache.evictIfDue({ maxAgeMs: 30 * DAY }, now))?.evicted).toBe(1)
      expect(hashes(cache)).toEqual(['aa'])
    } finally {
      cache.close()
    }
  })

  it('evicts least-recently-used entries until the cache is under maxSize', async () => {
    const cache = new Cache(cacheDir)
    try {
      await seed(cache, ['aa', 'bb', 'cc'])
      const now = Date.now()
      age('aa', now - 3000)
      age('bb', now - 2000)
      age('cc', now - 1000)
      const sizes = cache.dbHandle().query('SELECT size_bytes AS s FROM entries').all() as Array<{
        s: number
      }>
      const one = Math.max(...sizes.map((r) => r.s))
      // Room for two entries at most: the oldest goes, the two newest stay.
      const result = await cache.evictIfDue({ maxBytes: 2 * one }, now)
      expect(result?.evicted).toBe(1)
      expect(hashes(cache)).toEqual(['bb', 'cc'])
    } finally {
      cache.close()
    }
  })

  it('reaps row-less artifacts on its own hourly clock, whatever the index says', async () => {
    // What a SCHEMA_VERSION reset, a deleted cache.db or a crashed save
    // leaves: bytes no entry row counts. `maxSize` summed the rows only, so
    // 9 MiB of these sat under a 1 MB limit through every run (upstream
    // survey, nx#35483).
    const MiB = 1024 * 1024
    const cache = new Cache(cacheDir)
    try {
      await seed(cache, ['aa'])
      const first = await orphan('00000000000000a1', 3 * MiB, 3 * 3_600_000)
      // Younger than the in-flight grace: a save may still be landing it.
      const young = await orphan('00000000000000a2', 3 * MiB, 60_000)
      expect(await cache.evictIfDue({ maxBytes: MiB })).toEqual({
        evicted: 0,
        bytesFreed: 0,
        orphans: 1,
        orphanBytes: 3 * MiB,
      })
      expect(existsSync(first)).toBe(false)
      expect(existsSync(young)).toBe(true)
      expect(hashes(cache)).toEqual(['aa'])

      // Swept within the hour: not due, and nothing lists the directory.
      const later = await orphan('00000000000000a3', 3 * MiB, 3 * 3_600_000)
      const now = Date.now()
      expect(await cache.evictIfDue({ maxBytes: MiB }, now + 3_590_000)).toBeNull()
      expect(existsSync(later)).toBe(true)
      // An hour on, it is due again: from a fresh handle, so the clock is
      // the index's, not this process's.
      const reopened = new Cache(cacheDir)
      try {
        expect((await reopened.evictIfDue({ maxBytes: MiB }, now + 3_700_000))?.orphans).toBe(1)
      } finally {
        reopened.close()
      }
      expect(existsSync(later)).toBe(false)
      // CONTROL: the entry row was never over the limit, so nothing was evicted.
      expect(hashes(cache)).toEqual(['aa'])
    } finally {
      cache.close()
    }
  })

  it('a handle that does not write evicts nothing', async () => {
    const writer = new Cache(cacheDir)
    await seed(writer, ['aa'])
    writer.close()
    age('aa', 1)
    const reader = new Cache(cacheDir, { read: true, write: false })
    try {
      expect(await reader.evictIfDue({ maxAgeMs: DAY })).toBeNull()
      expect(hashes(reader)).toEqual(['aa'])
    } finally {
      reader.close()
    }
  })
})

describe('the cacheRetention field', () => {
  const WS = '/ws/vx.workspace.ts'
  function refusal(cacheRetention: unknown): string | null {
    try {
      validateWorkspace({ cacheRetention } as WorkspaceConfig, WS)
      return null
    } catch (err) {
      return (err as Error).message
    }
  }

  it('accepts either policy or both, in the spellings the prune flags take', () => {
    expect(refusal({ olderThan: '30d' })).toBeNull()
    expect(refusal({ maxSize: '10G' })).toBeNull()
    expect(refusal({ olderThan: '12H', maxSize: '500MB' })).toBeNull()
  })

  it('refuses each malformed shape by name', () => {
    expect([
      refusal('30d'),
      refusal([]),
      refusal({}),
      refusal({ olderThan: '30 days' }),
      refusal({ olderThan: 30 }),
      refusal({ maxSize: '1.5G' }),
    ]).toEqual([
      `${WS}: \`cacheRetention\` must be { olderThan?: '30d', maxSize?: '10G' }`,
      `${WS}: \`cacheRetention\` must be { olderThan?: '30d', maxSize?: '10G' }`,
      `${WS}: \`cacheRetention\` names neither \`olderThan\` nor \`maxSize\``,
      `${WS}: \`cacheRetention\`.olderThan must be a duration like '30d', '12h', '90m' or '45s'`,
      `${WS}: \`cacheRetention\`.olderThan must be a duration like '30d', '12h', '90m' or '45s'`,
      `${WS}: \`cacheRetention\`.maxSize must be a size like '10G', '500MB' or '1048576'`,
    ])
    expect(refusal({ maxAge: '30d' })).toContain('unknown field')
  })
})

describe('a run applies the workspace retention at its end', () => {
  let root: string

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function logger(): Logger & { lines: string[] } {
    const lines: string[] = []
    return {
      lines,
      status: (line: string) => lines.push(line),
      taskStart() {},
      taskStdout() {},
      taskStderr() {},
      taskComplete() {},
      runStatus() {},
    } as never
  }

  const task = (name: string) =>
    `export default { tasks: { build: { exec: { command: 'cat src/a.txt > out.txt' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } } } } }\n`.replace(
      'src/a.txt',
      `src/${name}.txt`,
    )

  async function setup(retention: string): Promise<string> {
    root = await makeWorkspace({ prefix: 'vx-retention-run-' })
    await writeFile(path.join(root, 'vx.workspace.mjs'), `export default { ${retention} }\n`)
    await addProject(root, 'a', { config: task('a'), files: { 'src/a.txt': 'a' } })
    await addProject(root, 'b', { config: task('b'), files: { 'src/b.txt': 'b' } })
    const cacheDir = path.join(root, '.vx', 'cache')
    // Run both once, then make a#build's entry ancient.
    const first = await run({ cwd: root, tasks: ['build'], log: logger(), handleSignals: false })
    expect(first.ok).toBe(true)
    const db = new Database(path.join(cacheDir, 'cache.db'))
    db.query("UPDATE entries SET accessed_at = 1 WHERE task = 'build' AND project = 'a'").run()
    db.close()
    return cacheDir
  }

  function projects(cacheDir: string): string[] {
    const db = new Database(path.join(cacheDir, 'cache.db'))
    const rows = db.query('SELECT project FROM entries ORDER BY project').all() as Array<{
      project: string
    }>
    db.close()
    return rows.map((r) => r.project)
  }

  it("evicts what is due and says so; a run that did not touch it can't keep it", async () => {
    const cacheDir = await setup("cacheRetention: { olderThan: '1d' }")
    const log = logger()
    const summary = await run({
      cwd: root,
      tasks: ['build'],
      projects: ['b'],
      log,
      handleSignals: false,
    })
    expect(summary.ok).toBe(true)
    expect(projects(cacheDir)).toEqual(['b'])
    expect(log.lines.filter((l) => l.includes('cache retention'))).toEqual([
      expect.stringMatching(/^vx: cache retention evicted 1 entry \(\d/),
    ])
  })

  it('reaps row-less artifacts a deleted index left, and says so', async () => {
    const cacheDir = await setup("cacheRetention: { maxSize: '1MB' }")
    // The index goes (deleted by hand, or dropped by a schema reset); its
    // artifacts stay behind, and they are old.
    await rm(path.join(cacheDir, 'cache.db'))
    await rm(path.join(cacheDir, 'cache.db-wal'), { force: true })
    await rm(path.join(cacheDir, 'cache.db-shm'), { force: true })
    const MiB = 1024 * 1024
    const left: string[] = []
    for (const name of ['00000000000000a1', '00000000000000a2', '00000000000000a3']) {
      const file = path.join(cacheDir, `${name}.tar.zst`)
      await writeFile(file, new Uint8Array(3 * MiB))
      const when = new Date(Date.now() - 3 * 3_600_000)
      await utimes(file, when, when)
      left.push(file)
    }
    const log = logger()
    const summary = await run({ cwd: root, tasks: ['build'], log, handleSignals: false })
    expect(summary.ok).toBe(true)
    expect(left.filter((f) => existsSync(f))).toEqual([])
    expect(log.lines.filter((l) => l.includes('cache retention'))).toEqual([
      'vx: cache retention reaped 3 orphaned artifacts (9.0 MB)',
    ])
  })

  // nx#35329: a cache moved outside the workspace was never evicted.
  it('evicts from a cache directory outside the workspace, set by cacheDir or --cache-dir', async () => {
    const evicted: Record<string, unknown> = {}
    for (const via of ['cacheDir', '--cache-dir'] as const) {
      root = await makeWorkspace({ prefix: 'vx-retention-outside-' })
      const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-retention-shared-'))
      try {
        const where =
          via === 'cacheDir' ? `, cacheDir: ${JSON.stringify(path.relative(root, outside))}` : ''
        await writeFile(
          path.join(root, 'vx.workspace.mjs'),
          `export default { cacheRetention: { olderThan: '1d' }${where} }\n`,
        )
        await addProject(root, 'a', { config: task('a'), files: { 'src/a.txt': 'a' } })
        await addProject(root, 'b', { config: task('b'), files: { 'src/b.txt': 'b' } })
        const flag = via === '--cache-dir' ? { cacheDir: outside } : {}
        const first = await run({
          cwd: root,
          tasks: ['build'],
          log: logger(),
          handleSignals: false,
          ...flag,
        })
        expect(first.ok).toBe(true)
        expect(projects(outside)).toEqual(['a', 'b'])
        const db = new Database(path.join(outside, 'cache.db'))
        db.query("UPDATE entries SET accessed_at = 1 WHERE task = 'build' AND project = 'a'").run()
        db.close()

        const log = logger()
        await run({
          cwd: root,
          tasks: ['build'],
          projects: ['b'],
          log,
          handleSignals: false,
          ...flag,
        })
        evicted[via] = {
          left: projects(outside),
          said: log.lines.filter((l) => l.includes('cache retention')).length,
        }
      } finally {
        await rm(outside, { recursive: true, force: true })
        await rm(root, { recursive: true, force: true })
      }
    }
    expect(evicted).toEqual({
      cacheDir: { left: ['b'], said: 1 },
      '--cache-dir': { left: ['b'], said: 1 },
    })
  })

  it('a workspace that declares no retention evicts nothing', async () => {
    const cacheDir = await setup('plugins: []')
    const log = logger()
    await run({ cwd: root, tasks: ['build'], projects: ['b'], log, handleSignals: false })
    expect(projects(cacheDir)).toEqual(['a', 'b'])
    expect(log.lines.filter((l) => l.includes('cache retention'))).toEqual([])
  })
})
