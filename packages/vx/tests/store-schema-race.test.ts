// The shared store's schema reset against another vx opening the same store
// mid-reset. Every workspace of a repository opens one store, so two vx
// versions meeting there is two checkouts on different branches.
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
  const d = await mkdtemp(path.join(os.tmpdir(), 'vx-store-race-'))
  made.push(d)
  return d
}

/**
 * What an older vx's open does to a store it finds without `entries`: makes
 * its own tables and stamps its own schema. `false` when the store's write
 * lock is held, as that open would then wait on its busy timeout.
 */
function olderOpen(storeFile: string): boolean {
  const db = new Database(storeFile)
  try {
    db.exec('PRAGMA busy_timeout = 0')
    try {
      db.exec('BEGIN IMMEDIATE')
    } catch {
      return false
    }
    const has = db.query("SELECT 1 FROM sqlite_master WHERE name = 'entries'").get() != null
    if (!has) {
      db.exec(`
        CREATE TABLE entries (hash TEXT PRIMARY KEY, other TEXT);
        CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO store_meta(key, value) VALUES ('schema', 'v0')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      `)
    }
    db.exec('COMMIT')
    return true
  } finally {
    db.close()
  }
}

function storeShape(storeFile: string): { columns: string[]; schema: string | undefined } {
  const db = new Database(storeFile, { readonly: true })
  try {
    const columns = (db.query('PRAGMA table_info(entries)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    const schema = (
      db.query("SELECT value FROM store_meta WHERE key = 'schema'").get() as {
        value: string
      } | null
    )?.value
    return { columns, schema }
  } finally {
    db.close()
  }
}

describe('store schema reset', () => {
  it('an older vx opening the store mid-reset cannot leave its tables under this schema', async () => {
    const root = await tmp()
    const storeDir = path.join(root, 'store')
    const storeFile = path.join(storeDir, 'store.db')
    new Cache(path.join(root, 'a'), undefined, undefined, undefined, 'open', storeDir).close()
    // The store as an older vx left it.
    const old = new Database(storeFile)
    old.exec("UPDATE store_meta SET value = 'v0' WHERE key = 'schema'")
    old.exec('DROP TABLE entry_inputs; DROP TABLE output_files; DROP TABLE entry_stdout')
    old.exec('DROP TABLE entries; CREATE TABLE entries (hash TEXT PRIMARY KEY, other TEXT)')
    old.close()

    // The other open lands the moment this one first creates a store table:
    // past its DROP, before its tables exist.
    let other: boolean | undefined
    const exec = Database.prototype.exec
    vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database,
      ...args: Parameters<Database['exec']>
    ) {
      if (other === undefined && String(args[0]).includes('CREATE TABLE IF NOT EXISTS store.')) {
        other = olderOpen(storeFile)
      }
      return exec.apply(this, args)
    })
    new Cache(path.join(root, 'b'), undefined, undefined, undefined, 'open', storeDir).close()
    vi.restoreAllMocks()

    const shape = storeShape(storeFile)
    expect(shape.schema).toBe(SCHEMA_VERSION)
    expect(shape.columns).toContain('project')
    expect(shape.columns).not.toContain('other')
    expect(other).toBe(false)
  })

  it('a store already at this schema is opened without waiting on its write lock', async () => {
    const root = await tmp()
    const storeDir = path.join(root, 'store')
    const storeFile = path.join(storeDir, 'store.db')
    new Cache(path.join(root, 'a'), undefined, undefined, undefined, 'open', storeDir).close()
    const holder = new Database(storeFile)
    holder.exec('BEGIN IMMEDIATE')
    try {
      new Cache(path.join(root, 'b'), undefined, undefined, undefined, 'open', storeDir).close()
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
    expect(storeShape(storeFile).schema).toBe(SCHEMA_VERSION)
  })
})
