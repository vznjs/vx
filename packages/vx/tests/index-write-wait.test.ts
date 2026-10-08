// A write to the index that another process holds the lock on waits for it
// (the busy timeout), whatever its transaction reads first. A deferred
// transaction that read before it wrote could not wait: SQLite answers
// such an upgrade `database is locked` at once, and 13 of 48 runs on one
// shared cache dir lost their history that way.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache, type InvocationRecord, type RunRecord } from '../src/cache/index.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-index-wait-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

let holds = 0

/**
 * Run `write` while another process holds `cache.db`'s write lock, released
 * 200 ms in by a third: `write` is synchronous, and this thread cannot run
 * a timer while SQLite waits.
 */
async function whileHeld(write: () => void): Promise<void> {
  const n = ++holds
  const locked = path.join(dir, `locked-${n}`)
  const release = path.join(dir, `release-${n}`)
  const holder = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { Database } = require('bun:sqlite')
const { existsSync, writeFileSync } = require('node:fs')
const db = new Database(${JSON.stringify(path.join(dir, 'cache', 'cache.db'))})
db.exec('BEGIN IMMEDIATE')
writeFileSync(${JSON.stringify(locked)}, '')
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5)
db.exec('COMMIT')`,
    ],
    { stderr: 'inherit' },
  )
  while (!existsSync(locked)) await Bun.sleep(5)
  const releaser = Bun.spawn([
    process.execPath,
    '-e',
    `await Bun.sleep(200); require('node:fs').writeFileSync(${JSON.stringify(release)}, '')`,
  ])
  try {
    write()
  } finally {
    expect(await releaser.exited).toBe(0)
    expect(await holder.exited).toBe(0)
  }
}

const run = (hash: string): RunRecord => ({
  hash,
  project: 'p',
  task: 'build',
  status: 'success',
  exitCode: 0,
  durationMs: 1,
  startedAt: Date.now(),
  endedAt: Date.now(),
  runId: 'run-1',
  // What every CLI run passes: a digest under the salt, read first.
  forwardArgs: [],
})

const invocation: InvocationRecord = {
  runId: 'run-1',
  command: 'vx run build --all',
  requestedTasks: JSON.stringify(['build']),
  cachePolicy: 'lR,lW',
  concurrency: 1,
  flow: 'broad',
  startedAt: Date.now(),
  endedAt: Date.now(),
  totalDurationMs: 1,
  taskCount: 2,
  failedCount: 0,
  hitCount: 0,
  hitLocalCount: 0,
  hitRemoteCount: 0,
  upToDateCount: 0,
  restoredLocalCount: 0,
  restoredRemoteCount: 0,
  exitOk: true,
  commitSha: null,
  branch: null,
  dirty: null,
  ci: false,
  ciProvider: null,
  host: 'h',
  os: 'linux',
  arch: 'x64',
  vxVersion: '0.0.0',
  tags: '{}',
}

it("a run's history waits for another process's write lock", async () => {
  // A handle of its own for each: the salt is read once per handle.
  const first = new Cache(path.join(dir, 'cache'))
  try {
    await whileHeld(() => first.recordRunBundle({ runs: [run('a'), run('b')], invocation }))
  } finally {
    first.close()
  }
  const second = new Cache(path.join(dir, 'cache'))
  try {
    await whileHeld(() => second.recordRuns([run('c'), run('d')]))
    const rows = second.dbHandle().query('SELECT hash FROM runs ORDER BY hash').all()
    expect(rows).toEqual([{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }, { hash: 'd' }])
  } finally {
    second.close()
  }
})

it("a hit's output stamps wait for another process's write lock", async () => {
  const cache = new Cache(path.join(dir, 'cache'))
  const projectDir = path.join(dir, 'proj')
  await mkdir(path.join(projectDir, 'dist'), { recursive: true })
  await writeFile(path.join(projectDir, 'dist', 'out.txt'), 'x')
  try {
    await cache.save({
      hash: 'k',
      projectDir,
      outputFiles: [path.join(projectDir, 'dist', 'out.txt')],
      entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: '' },
    })
    cache.recordOutputStamps('k', projectDir, dir)
    // The read that lands pending stamps (`loadOutputDirsBatch` flushes them).
    await whileHeld(() => cache.loadOutputDirsBatch(['k']))
    const st = await stat(path.join(projectDir, 'dist', 'out.txt'))
    expect(cache.dbHandle().query('SELECT path, ino FROM output_stamps').all()).toEqual([
      { path: 'dist/out.txt', ino: st.ino },
    ])
  } finally {
    cache.close()
  }
})
