// An entry's stdout is stored compressed (v52): as text, the logs were
// more of a store's bytes than every inline artifact together (a 100-project
// workspace after six runs: entry_stdout 1.23 MB, artifacts 0.82 MB). What a
// hit replays must still be the log exactly, a leading U+FEFF included.

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Cache } from '../src/cache/index.js'

const LOG = Array.from(
  { length: 1000 },
  (_, i) => ` ok src/feature-${i % 9}.test.ts > suite ${i % 7} > case ${i} (${i % 13}ms)\n`,
).join('')

describe('entry_stdout', () => {
  let root: string
  let cacheDir: string
  let projectDir: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-stdout-bytes-'))
    cacheDir = path.join(root, 'cache')
    projectDir = path.join(root, 'proj')
    await mkdir(projectDir, { recursive: true })
    await writeFile(path.join(projectDir, 'out.txt'), 'x')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const save = (cache: Cache, hash: string, stdout: string) =>
    cache.save({
      hash,
      projectDir,
      outputFiles: [path.join(projectDir, 'out.txt')],
      entry: { taskId: `p#${hash}`, command: 'c', durationMs: 1, stdout },
    })

  const storedBytes = (): Record<string, number> => {
    const db = new Database(path.join(cacheDir, 'cache.db'), { readonly: true })
    try {
      const rows = db
        .query<{ hash: string; n: number }, []>(
          'SELECT hash, length(CAST(stdout AS BLOB)) AS n FROM entry_stdout',
        )
        .all()
      return Object.fromEntries(rows.map((r) => [r.hash, r.n]))
    } finally {
      db.close()
    }
  }

  it('holds a log in a tenth of its bytes and replays it exactly', async () => {
    const cache = new Cache(cacheDir)
    try {
      await save(cache, 'aa', LOG)
      await save(cache, 'bb', `﻿${LOG}`)
      await save(cache, 'cc', '')
      const stored = storedBytes()
      expect(Object.keys(stored).sort()).toEqual(['aa', 'bb'])
      expect(stored['aa']!).toBeLessThan(Buffer.byteLength(LOG) / 10)
      expect((await cache.get('aa'))?.stdout).toBe(LOG)
      expect((await cache.get('bb'))?.stdout).toBe(`﻿${LOG}`)
      expect((await cache.get('cc'))?.stdout).toBe('')
      const many = await cache.getMany(['aa', 'bb', 'cc'])
      expect(['aa', 'bb', 'cc'].map((h) => many.get(h)?.stdout)).toEqual([LOG, `﻿${LOG}`, ''])
    } finally {
      cache.close()
    }
  })
})
