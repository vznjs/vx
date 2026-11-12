// Saves that reach their index write in one turn commit in one transaction
// (2026-11-03): a cold run's main thread spent half its index time on a
// BEGIN and a COMMIT per save. Each save keeps its own savepoint, so one
// refused write undoes only its own rows and artifact.

import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { indexDb, Cache } from '../src/cache/index.js'
import { storeIndexOf } from '../src/cache/cache.js'
import { indexInBatch } from '../src/cache/save.js'

let root: string
let cacheDir: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-save-batch-'))
  cacheDir = path.join(root, 'cache')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Save project `n`'s `dist/out.js` under `h<n>`; `big` makes the artifact a file. */
async function save(cache: Cache, n: number, big = false): Promise<void> {
  const proj = path.join(root, `p${n}`)
  await mkdir(path.join(proj, 'dist'), { recursive: true })
  await writeFile(
    path.join(proj, 'dist', 'out.js'),
    big
      ? Buffer.concat([Buffer.from(`p${n}`), crypto.getRandomValues(new Uint8Array(48 * 1024))])
      : `p${n}`,
  )
  await cache.save({
    hash: `h${n}`,
    projectDir: proj,
    outputFiles: [path.join(proj, 'dist', 'out.js')],
    entry: { taskId: `p${n}#build`, command: 'build', durationMs: 1, stdout: `p${n}` },
  })
}

/** Count the write transactions `cache` begins: `immediate()` is the save's. */
function countImmediate(cache: Cache): { n: number } {
  const db = indexDb(cache)
  const count = { n: 0 }
  const transaction = db.transaction.bind(db)
  db.transaction = ((fn: (...a: unknown[]) => unknown) => {
    const t = transaction(fn)
    return Object.assign((...a: unknown[]) => t(...a), {
      deferred: t.deferred,
      exclusive: t.exclusive,
      immediate: (...a: unknown[]) => {
        count.n++
        return t.immediate(...a)
      },
    })
  }) as typeof db.transaction
  return count
}

describe('saves in one turn', () => {
  it('commit in one transaction, every entry readable', async () => {
    const cache = new Cache(cacheDir)
    try {
      const begun = countImmediate(cache)
      const saves = Array.from({ length: 10 }, (_, i) => i + 1)
      await Promise.all(saves.map((n) => save(cache, n, n % 2 === 0)))
      // Each save's pack ends in a turn of its own choosing: fewer
      // transactions than saves, not one. One per save before.
      expect(begun.n).toBeLessThan(saves.length)
      for (const n of saves) expect((await cache.get(`h${n}`))?.stdout).toBe(`p${n}`)
    } finally {
      cache.close()
    }
  })

  it('writes queued in one turn begin one transaction', async () => {
    const cache = new Cache(cacheDir)
    try {
      const begun = countImmediate(cache)
      const db = indexDb(cache)
      db.exec('CREATE TABLE t (n INTEGER)')
      const queue = (n: number) =>
        indexInBatch(storeIndexOf(cache), () => db.run('INSERT INTO t VALUES (?)', [n]))
      await Promise.all([queue(1), queue(2), queue(3)])
      expect([begun.n, db.query('SELECT n FROM t ORDER BY n').values()]).toEqual([
        1,
        [[1], [2], [3]],
      ])
    } finally {
      cache.close()
    }
  })

  it('one refused write undoes only its own entry and artifact', async () => {
    const cache = new Cache(cacheDir)
    try {
      indexDb(cache).exec(
        "CREATE TRIGGER refuse BEFORE INSERT ON entries WHEN NEW.hash = 'h2' BEGIN SELECT RAISE(ABORT, 'refused'); END",
      )
      const settled = await Promise.allSettled([1, 2, 3].map((n) => save(cache, n, true)))
      expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
      expect(String((settled[1] as PromiseRejectedResult).reason)).toContain('refused')
      expect([
        (await cache.get('h1'))?.stdout,
        await cache.get('h2'),
        (await cache.get('h3'))?.stdout,
      ]).toEqual(['p1', null, 'p3'])
      expect(existsSync(cache.outputsPath('h2'))).toBe(false)
      expect(readdirSync(cacheDir).filter((n) => n.includes('.tmp-'))).toEqual([])
    } finally {
      cache.close()
    }
  })
})
