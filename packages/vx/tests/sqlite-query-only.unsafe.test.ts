// bun:sqlite defers a plain `close()` while a `db.prepare()` statement
// lives, so a row that prepared one and closed its database left the file
// open (O-13). A
// `db.query()` statement is finalized with its database. Unsafe: it reads
// this process's /proc/self/fd, which a sandboxed shard's /proc is not.
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'

const TESTS = import.meta.dir
const PREPARE = /\.prepare\(/

describe('a test reads SQLite through query(), never prepare()', () => {
  it.skipIf(process.platform !== 'linux')(
    'prepare() holds the file past close(); query() does not',
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-sqlite-close-'))
      try {
        const file = path.join(dir, 'x.db')
        const setup = new Database(file, { create: true })
        setup.run('CREATE TABLE t (a)')
        setup.close(true)
        const held = (): number =>
          readdirSync('/proc/self/fd').filter((fd) => {
            try {
              return readlinkSync(`/proc/self/fd/${fd}`).startsWith(dir + path.sep)
            } catch {
              return false
            }
          }).length
        const read = (how: 'query' | 'prepare'): number => {
          const db = new Database(file, { readonly: true })
          db[how]('SELECT COUNT(*) FROM t').get()
          db.close()
          return held()
        }
        expect(read('query')).toBe(0)
        expect(read('prepare')).toBeGreaterThan(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('no test calls prepare()', () => {
    expect(PREPARE.test('db.prepare(sql)')).toBe(true)
    expect(PREPARE.test('db.query(sql)')).toBe(false)
    const found: string[] = []
    let scanned = 0
    for (const rel of new Bun.Glob('**/*.ts').scanSync({ cwd: TESTS })) {
      scanned++
      if (rel.endsWith('sqlite-query-only.unsafe.test.ts')) continue
      if (PREPARE.test(readFileSync(path.join(TESTS, rel), 'utf8'))) {
        found.push(rel.split(path.sep).join('/'))
      }
    }
    expect(scanned).toBeGreaterThan(300)
    expect(found).toEqual([])
  })
})
