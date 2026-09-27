// A cache index SQLite cannot read reached every verb as a raw
// `SQLiteError` and a stack — `vx run`, `vx why`, `vx last` and the doctor
// alike — and the user had to find the file themselves (item 1005). Both
// opens now name the file and the remedy.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'

let dir: string
let db: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vx-unreadable-'))
  db = path.join(dir, 'cache.db')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const refusal = (reason: string) =>
  `the cache index ${db} is not a database SQLite can read (${reason}) — ` +
  `it holds nothing a run cannot rebuild: remove it with its -wal and -shm files and ` +
  `re-run, and \`vx cache prune\` reclaims the artifacts it indexed`

const open = (inspect: boolean): string | null => {
  try {
    ;(inspect ? Cache.inspect(dir) : new Cache(dir)).close()
    return null
  } catch (err) {
    expect((err as Error).name).toBe('UserError')
    return (err as Error).message
  }
}

/** SQLite's own answer for the file, which is what reached the user raw. */
const raw = (): string => {
  try {
    const d = new Database(db)
    d.exec('PRAGMA journal_mode = WAL')
    d.prepare('SELECT name FROM sqlite_master').all()
    d.close()
    return 'readable'
  } catch (err) {
    return (err as { code: string }).code
  }
}

describe('an unreadable cache index is refused by name, not with a stack', () => {
  it('a file that is not a database, for a run and for a reading verb', () => {
    writeFileSync(db, 'x'.repeat(8192))
    expect(raw()).toBe('SQLITE_NOTADB')
    expect(open(false)).toBe(refusal('file is not a database'))
    expect(open(true)).toBe(refusal('file is not a database'))
  })

  it('a database whose schema page is garbage', () => {
    const d = new Database(db)
    d.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1)')
    d.close()
    const bytes = readFileSync(db)
    bytes.fill(0xab, 100)
    writeFileSync(db, bytes)
    expect(raw()).toBe('SQLITE_CORRUPT')
    expect(open(false)).toBe(refusal('database disk image is malformed'))
    expect(open(true)).toBe(refusal('database disk image is malformed'))
  })

  it('CONTROL: a sound index opens both ways', () => {
    expect(open(false)).toBeNull()
    expect(open(true)).toBeNull()
  })
})
