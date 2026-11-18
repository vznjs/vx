// What a warm hit is proved by, read ahead of the probe (`warmOutputs`): its
// output rows while git walks, and past `WARM_STATS_FROM` files their stats on
// a thread (payload: 14,484 output files, 53 ms of a 172 ms no-op).
//
// Stale-hit-critical: a stat taken before the graph started proves nothing
// once anything may have written. Pinned here in both directions: the stats
// taken ahead are the ones the check reads, and they answer nothing after
// `dropWarm`, which a run calls before a task or a restore writes.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { defaultLogger } from '../src/report/logger.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitInit, makeWorkspace } from './helpers/workspace.js'

/** Past the count from which the stats go to the thread. */
const MANY = 2100

describe('LocalMemo.warmOutputs', () => {
  let root: string
  let dir: string
  let cache: Cache
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-warm-'))
    dir = path.join(root, 'proj')
    await mkdir(path.join(dir, 'dist'), { recursive: true })
    gitInit(root)
    cache = new Cache(path.join(root, '.vx', 'cache'))
  })
  afterEach(async () => {
    cache.close()
    await rm(root, { recursive: true, force: true })
  })

  const file = (i: number): string => path.join(dir, 'dist', `f${i}.txt`)
  const saved = async (hash: string, count: number): Promise<void> => {
    const files: string[] = []
    for (let i = 0; i < count; i++) {
      writeFileSync(file(i), `v${i}`)
      files.push(file(i))
    }
    await cache.save({
      hash,
      projectDir: dir,
      outputFiles: files,
      entry: { taskId: 'proj#build', command: 'x', durationMs: 1, stdout: '' },
    })
    cache.memo.recordOutputStamps(hash, dir, root)
    cache.memo.folds.set('proj#build', 'probe', hash)
  }
  const warm = async (tasks: Array<[string, string]>, done = () => false): Promise<void> => {
    await cache.memo.warmOutputs(tasks, done)
    await cache.memo.warmSettled()
  }
  const rows = (hash: string) => cache.memo.loadOutputFilesBatch([hash]).get(hash) ?? []
  // Same size, so only the stat's other fields can tell.
  const rewrite = (i: number): void => {
    Bun.sleepSync(5)
    writeFileSync(file(i), `w${i}`)
  }

  it('the stats taken ahead are the ones the check reads, until dropped', async () => {
    const hash = 'aaaa1111bbbb2222'
    await saved(hash, MANY)
    await warm([['proj#build', dir]])
    const expected = rows(hash)
    expect(expected).toHaveLength(MANY)
    expect(cache.memo.isOutputsCurrent(dir, expected)).toBe(true)
    // Written after the stats were taken: the check does not stat again...
    rewrite(7)
    expect(cache.memo.isOutputsCurrent(dir, expected)).toBe(true)
    // ...until something may have written.
    cache.memo.dropWarm()
    expect(cache.memo.isOutputsCurrent(dir, expected)).toBe(false)
  })

  it('a file changed before the stats were taken is not current', async () => {
    const hash = 'aaaa1111bbbb3333'
    await saved(hash, MANY)
    rewrite(MANY - 1)
    await warm([['proj#build', dir]])
    expect(cache.memo.isOutputsCurrent(dir, rows(hash))).toBe(false)
  })

  it('a file gone before the stats were taken is not current', async () => {
    const hash = 'aaaa1111bbbb4444'
    await saved(hash, MANY)
    rmSync(file(0))
    await warm([['proj#build', dir]])
    expect(cache.memo.isOutputsCurrent(dir, rows(hash))).toBe(false)
  })

  it('stats taken under one directory answer for no other', async () => {
    const hash = 'aaaa1111bbbb5555'
    await saved(hash, MANY)
    await warm([['proj#build', dir]])
    expect(cache.memo.isOutputsCurrent(path.join(root, 'elsewhere'), rows(hash))).toBe(false)
  })

  it('a few files are stat ed by the check itself', async () => {
    const hash = 'aaaa1111bbbb6666'
    await saved(hash, 10)
    await warm([['proj#build', dir]])
    const expected = rows(hash)
    expect(cache.memo.isOutputsCurrent(dir, expected)).toBe(true)
    rewrite(3)
    expect(cache.memo.isOutputsCurrent(dir, expected)).toBe(false)
  })

  it('the rows read ahead are the rows a read gives, handed over once', async () => {
    const hash = 'aaaa1111bbbb7777'
    await saved(hash, 10)
    const fresh = rows(hash)
    await warm([['proj#build', dir]])
    const ahead = rows(hash)
    expect(ahead).toEqual(fresh)
    expect(rows(hash)).not.toBe(ahead)
    expect(rows(hash)).toEqual(fresh)
  })

  it('nothing is read once the wait is over', async () => {
    const hash = 'aaaa1111bbbb8888'
    await saved(hash, MANY)
    await warm([['proj#build', dir]], () => true)
    const expected = rows(hash)
    rewrite(7)
    expect(cache.memo.isOutputsCurrent(dir, expected)).toBe(false)
  })

  it('a task with no remembered key, or a key with no entry, reads nothing', async () => {
    cache.memo.folds.set('proj#gone', 'probe', 'ffff0000ffff0000')
    await warm([
      ['proj#never', dir],
      ['proj#gone', dir],
    ])
    expect(rows('ffff0000ffff0000')).toEqual([])
  })

  // A store that lost its inventory takes an entry back between the read
  // ahead and the probe: with "no rows" remembered, the hit had no file to
  // prove and stood as up to date over a deleted output.
  it('rows written after a read ahead that found none are read', async () => {
    const hash = 'aaaa1111bbbb9999'
    cache.memo.folds.set('proj#build', 'probe', hash)
    await warm([['proj#build', dir]])
    const other = new Cache(path.join(root, '.vx', 'cache'))
    try {
      writeFileSync(file(0), 'v0')
      await other.save({
        hash,
        projectDir: dir,
        outputFiles: [file(0)],
        entry: { taskId: 'proj#build', command: 'x', durationMs: 1, stdout: '' },
      })
    } finally {
      other.close()
    }
    expect(rows(hash)).toHaveLength(1)
  })
})

describe('a run over many output files', () => {
  let root: string
  let dir: string
  const log = defaultLogger({ enabled: false })
  const GEN = `mkdir -p dist && i=0; while [ $i -lt ${MANY} ]; do echo $i > dist/f$i.txt; i=$((i+1)); done`
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-warm-run-' })
    dir = await addProject(root, 'a', {
      config: `export default { tasks: {
        build: { exec: { command: '${GEN}' }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true },
      } }\n`,
      files: { 'src/index.js': 'export const a = 1\n' },
    })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const build = async (task = 'build') => {
    const result = await run({ cwd: root, tasks: [task], log, handleSignals: false })
    expect(result.ok).toBe(true)
    return result.outcomes.find((o) => o.node.id === 'a#build')!
  }
  const out = (i: number): string => path.join(dir, 'dist', `f${i}.txt`)

  it('a hit whose files stand is up to date; one changed or gone is restored', async () => {
    expect((await build()).status).toBe('success')
    // The first hit walks and snapshots the tree; the next ones are proved by stats alone.
    await build()
    const noop = await build()
    expect(noop.status).toBe('cache-hit')
    expect(noop.cache?.restored).toBe(false)

    writeFileSync(out(7), 'x')
    const changed = await build()
    expect(changed.status).toBe('cache-hit')
    expect(changed.cache?.restored).toBe(true)
    expect(readFileSync(out(7), 'utf8')).toBe('7\n')

    rmSync(out(MANY - 1))
    expect((await build()).cache?.restored).toBe(true)
    expect(existsSync(out(MANY - 1))).toBe(true)
  })

  // The hit is probed after `pre` ran (its runtime probe waits for an
  // uncached upstream), so its files' stats, taken before the graph started,
  // are older than `pre`'s write.
  it('a task that wrote into a hit s outputs before the hit was checked is seen', async () => {
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: {
        pre: { exec: { command: 'if [ -f dist/f7.txt ]; then echo x > dist/f7.txt; fi' }, inputs: { files: ['src/**'] } },
        build: { dependsOn: ['pre'], exec: { command: '${GEN}' }, inputs: { files: ['src/**'], runtime: ['echo fixed'] }, outputs: { files: ['dist/**'] }, cache: true },
      } }\n`,
    )
    expect((await build()).status).toBe('success')
    const again = await build()
    expect(again.status).toBe('cache-hit')
    expect(again.cache?.restored).toBe(true)
    expect(readFileSync(out(7), 'utf8')).toBe('7\n')
  })
})
