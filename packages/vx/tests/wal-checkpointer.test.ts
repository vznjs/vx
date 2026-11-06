import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache, indexDb } from '../src/cache/index.js'
import { TAR_STORE } from './helpers/tar-store.js'

let root: string
let dir: string
let projectDir: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-ckpt-'))
  dir = path.join(root, 'cache')
  projectDir = path.join(root, 'pkg')
  await mkdir(path.join(projectDir, 'dist'), { recursive: true })
  await writeFile(path.join(projectDir, 'dist', 'a.js'), 'a')
})
afterEach(() => rm(root, { recursive: true, force: true }))

const open = (): Cache =>
  new Cache(dir, undefined, undefined, undefined, undefined, undefined, TAR_STORE)

const save = (cache: Cache, hash: string): Promise<unknown> =>
  cache.save({
    hash,
    projectDir,
    outputFiles: [path.join(projectDir, 'dist', 'a.js')],
    entry: { taskId: 'pkg#build', command: 'build', durationMs: 1, stdout: '' },
  })

const autocheckpoint = (cache: Cache): number =>
  (indexDb(cache).query('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number })
    .wal_autocheckpoint

const dbBytes = (): number => statSync(path.join(dir, 'cache.db')).size

it("a run's saves leave the WAL's checkpoints to a thread, from the first commit", async () => {
  const cache = open()
  cache.checkpointOffThread()
  expect(autocheckpoint(cache)).toBe(1000)
  await save(cache, 'h1')
  // This connection checkpoints nothing from here on.
  expect(autocheckpoint(cache)).toBe(0)
  const db = indexDb(cache)
  db.exec('CREATE TABLE pad (b BLOB)')
  const before = dbBytes()
  for (let i = 0; i < 8; i++) db.query('INSERT INTO pad VALUES (randomblob(1048576))').run()
  // Only a checkpoint moves those pages from the WAL into the file.
  const deadline = Date.now() + 10_000
  while (dbBytes() < before + 8 * 1048576 && Date.now() < deadline) await Bun.sleep(20)
  expect(dbBytes()).toBeGreaterThanOrEqual(before + 8 * 1048576)
  await cache.stopCheckpoints()
  cache.close()
  // The thread's connection closed first: this close was the last, and truncated the WAL.
  expect(statSync(path.join(dir, 'cache.db-wal')).size).toBe(0)
})

it('a cache not asked starts no checkpoint thread', async () => {
  const cache = open()
  await save(cache, 'h1')
  expect(autocheckpoint(cache)).toBe(1000)
  cache.close()
})
