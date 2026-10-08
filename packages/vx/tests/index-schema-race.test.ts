// The workspace index's schema gate against another vx opening the same
// `cache.db` mid-reset: two vx versions on one cache directory.
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { Cache, SCHEMA_VERSION } from '../src/cache/index.js'

const made: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'vx-index-race-'))
  made.push(d)
  return d
}

/**
 * An older vx's reset of an index it finds under another schema: drop and
 * stamp its own, its tables made later. `false` when the index's write lock
 * is held, as that open would then wait on its busy timeout.
 */
function olderReset(dbFile: string): boolean {
  const db = new Database(dbFile)
  try {
    db.exec('PRAGMA busy_timeout = 0')
    try {
      db.exec('BEGIN IMMEDIATE')
    } catch {
      return false
    }
    const found = (
      db.query("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
        value: string
      } | null
    )?.value
    if (found !== 'v0') {
      const tables = (
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'schema_meta'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name)
      for (const t of tables) if (!t.startsWith('sqlite_')) db.exec(`DROP TABLE IF EXISTS "${t}"`)
      db.query(
        "INSERT INTO schema_meta(key, value) VALUES ('version', 'v0') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run()
    }
    db.exec('COMMIT')
    return true
  } finally {
    db.close()
  }
}

/** The older vx's own table creation, after its reset. */
function olderCreate(dbFile: string): void {
  const db = new Database(dbFile)
  db.exec('CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, other TEXT)')
  db.close()
}

function indexShape(dbFile: string): { columns: string[]; version: string | undefined } {
  const db = new Database(dbFile, { readonly: true })
  try {
    const columns = (db.query('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    const version = (
      db.query("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
        value: string
      } | null
    )?.value
    return { columns, version }
  } finally {
    db.close()
  }
}

/** Runs `olderReset` the moment this vx first creates an index table. */
function olderLandsAtFirstCreate(dbFile: string): () => boolean | undefined {
  let other: boolean | undefined
  const exec = Database.prototype.exec
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database,
    ...args: Parameters<Database['exec']>
  ) {
    if (other === undefined && String(args[0]).includes('CREATE TABLE IF NOT EXISTS main.')) {
      other = olderReset(dbFile)
    }
    return exec.apply(this, args)
  })
  return () => other
}

function oldIndex(cacheDir: string): string {
  new Cache(cacheDir, undefined, undefined, undefined, 'open', null).close()
  const dbFile = path.join(cacheDir, 'cache.db')
  const db = new Database(dbFile)
  db.exec("UPDATE schema_meta SET value = 'v0' WHERE key = 'version'")
  db.exec('DROP TABLE runs; CREATE TABLE runs (id INTEGER PRIMARY KEY, other TEXT)')
  db.close()
  return dbFile
}

describe('index schema reset', () => {
  it('an older vx resetting the index mid-reset cannot leave this schema under its stamp', async () => {
    const cacheDir = path.join(await tmp(), 'cache')
    const dbFile = oldIndex(cacheDir)
    const other = olderLandsAtFirstCreate(dbFile)
    const cache = new Cache(cacheDir, undefined, undefined, undefined, 'open', null)
    cache.close()
    vi.restoreAllMocks()
    olderCreate(dbFile)

    expect(cache.schemaReset).toEqual({ from: 'v0', to: SCHEMA_VERSION })
    const shape = indexShape(dbFile)
    expect(shape.version).toBe(SCHEMA_VERSION)
    expect(shape.columns).toContain('project')
    expect(shape.columns).not.toContain('other')
    expect(other()).toBe(false)
  })

  it('an older vx opening a new index mid-open cannot leave this schema under its stamp', async () => {
    const cacheDir = path.join(await tmp(), 'cache')
    const dbFile = path.join(cacheDir, 'cache.db')
    const other = olderLandsAtFirstCreate(dbFile)
    new Cache(cacheDir, undefined, undefined, undefined, 'open', null).close()
    vi.restoreAllMocks()
    olderCreate(dbFile)

    const shape = indexShape(dbFile)
    expect(shape.version).toBe(SCHEMA_VERSION)
    expect(shape.columns).toContain('project')
    expect(shape.columns).not.toContain('other')
    expect(other()).toBe(false)
  })

  it('a reset index beside a shared store holds no entry tables of its own', async () => {
    const root = await tmp()
    const cacheDir = path.join(root, 'cache')
    const storeDir = path.join(root, 'store')
    const dbFile = oldIndex(cacheDir)
    const cache = new Cache(cacheDir, undefined, undefined, undefined, 'open', storeDir)
    cache.close()
    expect(cache.schemaReset).toEqual({ from: 'v0', to: SCHEMA_VERSION })
    const db = new Database(dbFile, { readonly: true })
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
    db.close()
    expect(tables).toContain('runs')
    expect(tables.filter((t) => t.startsWith('entr') || t === 'output_files')).toEqual([])
  })

  it('an index already at this schema is opened without waiting on its write lock', async () => {
    const cacheDir = path.join(await tmp(), 'cache')
    new Cache(cacheDir, undefined, undefined, undefined, 'open', null).close()
    const holder = new Database(path.join(cacheDir, 'cache.db'))
    holder.exec('BEGIN IMMEDIATE')
    let cache: Cache
    try {
      cache = new Cache(cacheDir, undefined, undefined, undefined, 'open', null)
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
    // The close checkpoints, so it waits on a held lock; the open does not.
    cache.close()
    expect(indexShape(path.join(cacheDir, 'cache.db')).version).toBe(SCHEMA_VERSION)
  })
})
