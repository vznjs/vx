// The hit-path directory snapshot was not held to the entry's rows (the
// run-end one is, item 1087): a stray written after the walk listed its
// directory, more than a racy window before the snapshot, was recorded, and
// every later hit skipped the restore and kept the stray.

import { existsSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { gitInit } from './helpers/workspace.js'
import { Cache, OUTPUT_DIRS_RACY_MS, type CacheEntry } from '../src/cache/index.js'
import { localExecutor } from '../src/exec/local-executor.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import type { Logger } from '../src/report/index.js'
import { restoreHit } from '../src/orchestrator/execute-task.js'

interface Bench {
  root: string
  dir: string
  cache: Cache
}
let b: Bench
beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-hunt-c-'))
  const dir = path.join(root, 'proj')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'proj' }))
  gitInit(root)
  b = { root, dir, cache: new Cache(path.join(root, '.vx', 'cache')) }
})
afterEach(async () => {
  b.cache.close()
  await rm(b.root, { recursive: true, force: true })
})

const quiet = new Proxy({}, { get: () => () => undefined }) as Logger
const DIST_TASK = {
  exec: { command: 'echo should-not-run' },
  inputs: { files: [] },
  cache: { outputs: { files: ['dist/**'] } },
}
const node = (): TaskNode => ({
  id: 'proj#build',
  projectName: 'proj',
  projectDir: b.dir,
  taskName: 'build',
  config: DIST_TASK,
  deps: [],
  requested: true,
})
const restore = (hash: string, hit: CacheEntry) =>
  restoreHit({
    args: {
      node: node(),
      upstream: [] as TaskOutcome[],
      workspaceRoot: b.root,
      cache: b.cache,
      log: quiet,
      executor: localExecutor(),
      nestedProjectDirs: [] as string[],
      runStartHrTimeNs: process.hrtime.bigint(),
      keyedProjects: () => new Set<string>(),
    },
    hash,
    hit,
    cacheOpStart: performance.now(),
    taskStartNs: 0n,
  })

it('a stray written while a hit walks its outputs is not snapshotted as the entry', async () => {
  const hash = 'eeee4444ffff5555'
  const out = path.join(b.dir, 'dist', 'o.txt')
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, 'v1')
  await b.cache.save({
    hash,
    projectDir: b.dir,
    outputFiles: [out],
    entry: { taskId: 'proj#build', command: 'x', durationMs: 1, stdout: '' },
  })
  b.cache.recordOutputStamps(hash, b.dir, b.root)
  const old = new Date(Math.floor(Date.now() / 2000) * 2000 - 4000)
  utimesSync(path.join(b.dir, 'dist'), old, old)
  // The first hit has no snapshot: it walks, finds the set, stats the file.
  // Another process writes a stray into dist after the walk listed it, and
  // the rest of the walk (a big tree) takes longer than the racy window.
  const real = b.cache.isOutputsCurrent.bind(b.cache)
  const stat = spyOn(b.cache, 'isOutputsCurrent').mockImplementation((dir, rows) => {
    const ok = real(dir, rows)
    if (dir === b.dir && !existsSync(path.join(b.dir, 'dist', 'stray.txt'))) {
      writeFileSync(path.join(b.dir, 'dist', 'stray.txt'), 'stray')
      Bun.sleepSync(OUTPUT_DIRS_RACY_MS * 3)
    }
    return ok
  })
  expect((await restore(hash, (await b.cache.get(hash))!)).restored).toBe(false)
  stat.mockRestore()
  // The next hit: the stray is not the entry's, so it must restore and clean it.
  await restore(hash, (await b.cache.get(hash))!)
  expect(existsSync(path.join(b.dir, 'dist', 'stray.txt'))).toBe(false)
})
