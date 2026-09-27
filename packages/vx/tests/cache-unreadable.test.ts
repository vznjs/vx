// A cache index SQLite cannot read reached every verb as a raw
// `SQLiteError` and a stack — `vx run`, `vx why`, `vx last` and the doctor
// alike — and the user had to find the file themselves (item 1005). Both
// opens now name the file and the remedy. The open reads the header and
// `schema_meta` alone, so a file corrupt deeper answered the first lookup
// that reached the bad page: every task of a run failed as an "internal
// error" and `vx cache prune` printed a stack (A-8). Every entry point that
// reads or writes the index now gives the open's refusal.
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
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

describe('an index corrupt past the pages the open reads', () => {
  /** Index entries, then garble the `entries` table's root page behind the handle's back. */
  async function corruptEntries(): Promise<void> {
    const proj = path.join(dir, 'proj')
    mkdirSync(path.join(proj, 'dist'), { recursive: true })
    writeFileSync(path.join(proj, 'dist', 'x'), 'x')
    const cache = new Cache(dir)
    for (let i = 0; i < 50; i++) {
      await cache.save({
        hash: `h${i}`,
        projectDir: proj,
        outputFiles: [path.join(proj, 'dist', 'x')],
        entry: {
          taskId: 'p#build',
          command: 'c'.repeat(500),
          durationMs: 1,
          stdout: 's'.repeat(2000),
        },
      })
    }
    cache.close()
    const d = new Database(db)
    // Into the main file, so no WAL copy of the page shadows the garbling.
    d.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const { page_size } = d.prepare('PRAGMA page_size').get() as { page_size: number }
    const { rootpage } = d
      .prepare("SELECT rootpage FROM sqlite_master WHERE name = 'entries'")
      .get() as {
      rootpage: number
    }
    d.close()
    const fd = openSync(db, 'r+')
    writeSync(fd, Buffer.alloc(page_size, 0xab), 0, page_size, (rootpage - 1) * page_size)
    closeSync(fd)
  }

  /** What an operation answers: null, or the name and message of what it threw. */
  async function answer(op: () => unknown): Promise<[string, string] | null> {
    try {
      await op()
      return null
    } catch (err) {
      return [(err as Error).name, (err as Error).message]
    }
  }

  it('refuses every lookup, save and prune by name, after an open that passed', async () => {
    await corruptEntries()
    const cache = new Cache(dir)
    const proj = path.join(dir, 'proj')
    const expected: [string, string] = ['UserError', refusal('database disk image is malformed')]
    try {
      const ops: Array<[string, () => unknown]> = [
        ['get', () => cache.get('h7')],
        ['getIngested', () => cache.getIngested('h7')],
        ['getMany', () => cache.getMany(['h7', 'h8'])],
        ['has', () => cache.has('h7')],
        ['stats', () => cache.stats()],
        ['prune', () => cache.prune({ maxBytes: 1 })],
        ['evictIfDue', () => cache.evictIfDue({ maxBytes: 1 })],
        [
          'save',
          () =>
            cache.save({
              hash: 'h7',
              projectDir: proj,
              outputFiles: [path.join(proj, 'dist', 'x')],
              entry: { taskId: 'p#build', command: 'c', durationMs: 1, stdout: '' },
            }),
        ],
      ]
      for (const [name, op] of ops) expect([name, await answer(op)]).toEqual([name, expected])
    } finally {
      cache.close()
    }
  })

  it('CONTROL: the same index, whole, answers each of them', async () => {
    const proj = path.join(dir, 'proj')
    mkdirSync(path.join(proj, 'dist'), { recursive: true })
    writeFileSync(path.join(proj, 'dist', 'x'), 'x')
    const cache = new Cache(dir)
    try {
      await cache.save({
        hash: 'h7',
        projectDir: proj,
        outputFiles: [path.join(proj, 'dist', 'x')],
        entry: { taskId: 'p#build', command: 'c', durationMs: 1, stdout: '' },
      })
      expect((await cache.get('h7'))?.hash).toBe('h7')
      expect(await answer(() => cache.stats())).toBeNull()
      expect(await answer(() => cache.prune({ maxBytes: 1 }))).toBeNull()
    } finally {
      cache.close()
    }
  })
})
