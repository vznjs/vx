// A run's hits are written on a thread of their own while the graph runs
// (history-stream.ts): what landed is the rows a bundle would have written,
// and what did not land comes back for the bundle, so no row is lost or
// written twice.
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { historyFiles, indexDb, Cache, HistoryStream, type RunRecord } from '../src/cache/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import type { Logger } from '../src/report/index.js'

const T = Date.now()

const quiet: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

const hit = (i: number): RunRecord => ({
  hash: i.toString(16).padStart(16, '0'),
  project: `p${i}`,
  task: 'build',
  status: 'cache-hit',
  exitCode: 0,
  durationMs: 2,
  startedAt: T + i,
  endedAt: T + i + 1,
  runId: 'run-1',
  wallclockStartNs: BigInt(i) * 1_000_000n,
  wallclockEndNs: BigInt(i) * 1_000_000n + 7n,
  cacheHit: true,
  cached: true,
  restored: false,
  blocks: i % 3,
})

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-history-stream-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('writes full batches on its thread and hands back the rest', async () => {
  const cache = new Cache(path.join(dir, 'cache'))
  const stream = new HistoryStream<number>(historyFiles(cache)!)
  for (let i = 0; i < 1_100; i++) stream.add(i, hit(i))
  const { landed, unlanded } = await stream.finish()
  const db = indexDb(cache)
  const rows = db
    .query(
      'SELECT project, wallclock_start_ns AS s, wallclock_end_ns AS e, blocks, restored FROM runs ORDER BY started_at',
    )
    .all() as { project: string; s: number; e: number; blocks: number; restored: number }[]
  const outcomes = (db.query('SELECT COUNT(*) AS n FROM task_outcomes').get() as { n: number }).n
  cache.close()
  expect([landed.length, unlanded.length]).toEqual([1_024, 76])
  expect(unlanded.map((u) => u.item)).toEqual(Array.from({ length: 76 }, (_, k) => 1_024 + k))
  expect(rows.length).toBe(1_024)
  expect(rows[1_000]).toEqual({
    project: 'p1000',
    s: 1_000_000_000,
    e: 1_000_000_007,
    blocks: 1,
    restored: 0,
  })
  // The flaky record's first hit of each key, as the bundle keeps it.
  expect(outcomes).toBe(1_024)
})

// A run's process has nothing else to wait on while `finish` awaits the
// thread's answers: an unreferenced thread left them unheard, and a
// restoring run ended "something it awaited can never settle", exit 1.
it('a restoring CLI run waits for its thread', async () => {
  const root = await makeWorkspace({ dir })
  const tasks = Array.from(
    { length: 600 },
    (_, i) =>
      `t${i}: { exec: { command: 'mkdir -p o${i} && echo ${i} > o${i}/f' }, inputs: { files: ['package.json'] }, cache: { outputs: { files: ['o${i}/**'] } } }`,
  )
  const proj = await addProject(root, 'p', `export default { tasks: { ${tasks.join(', ')} } }`)
  const names = Array.from({ length: 600 }, (_, i) => `t${i}`)
  expect((await run({ cwd: root, tasks: names, log: quiet })).ok).toBe(true)
  for (let i = 0; i < 600; i++) await rm(path.join(proj, `o${i}`), { recursive: true })
  const bin = path.join(import.meta.dir, '..', 'src', 'bin.ts')
  const p = Bun.spawnSync(['bun', bin, 'run', ...names, '--all'], {
    cwd: root,
    env: { ...process.env, VX_CACHE_DIR: '.vx/cache', NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = p.stdout.toString() + p.stderr.toString()
  expect([p.exitCode, out.includes('never settle')]).toEqual([0, false])
}, 60_000)

it('leaves a run with fewer hits than a batch to its bundle', async () => {
  const cache = new Cache(path.join(dir, 'cache'))
  const stream = new HistoryStream<number>(historyFiles(cache)!)
  for (let i = 0; i < 10; i++) stream.add(i, hit(i))
  const { landed, unlanded } = await stream.finish()
  cache.close()
  expect([landed.length, unlanded.length]).toEqual([0, 10])
})

it('hands back every row when its thread cannot write', async () => {
  const stream = new HistoryStream<number>({ index: path.join(dir, 'no', 'such', 'cache.db') })
  for (let i = 0; i < 1_100; i++) stream.add(i, hit(i))
  const { landed, unlanded } = await stream.finish()
  expect([landed.length, unlanded.length]).toEqual([0, 1_100])
})

it('keeps no history files for a store that writes none', () => {
  const cache = new Cache(path.join(dir, 'cache'), undefined, undefined, undefined, 'inspect')
  const files = historyFiles(cache)
  cache.close()
  expect(files).toBeUndefined()
})

it('records each task of a warm run once, the streamed hits beside the bundle', async () => {
  const root = await makeWorkspace({ dir })
  // More hits than a batch, so the run streams one and bundles the rest.
  const tasks = Array.from(
    { length: 600 },
    (_, i) =>
      `t${i}: { exec: { command: 'true' }, inputs: { files: ['package.json'] }, cache: { outputs: { files: [] } } }`,
  )
  await addProject(root, 'p', `export default { tasks: { ${tasks.join(', ')} } }`)
  const names = Array.from({ length: 600 }, (_, i) => `t${i}`)
  expect((await run({ cwd: root, tasks: names, log: quiet })).ok).toBe(true)
  const warm = await run({ cwd: root, tasks: names, log: quiet })
  expect(warm.outcomes.every((o) => o.status === 'cache-hit')).toBe(true)
  const cache = new Cache(
    path.join(root, '.vx', 'cache'),
    undefined,
    undefined,
    undefined,
    'inspect',
  )
  const db = indexDb(cache)
  const last = db
    .query('SELECT run_id, task_count, hit_count FROM invocations ORDER BY started_at DESC LIMIT 1')
    .get() as { run_id: string; task_count: number; hit_count: number }
  const rows = db
    .query('SELECT COUNT(*) AS n, COUNT(DISTINCT task) AS tasks FROM runs WHERE run_id = ?')
    .get(last.run_id)
  cache.close()
  expect([last.task_count, last.hit_count, rows]).toEqual([600, 600, { n: 600, tasks: 600 }])
}, 60_000)

// A compiled vx carries only the entry points its build names: a thread's
// file missing from one runs that binary's history on the main thread again.
it('names every thread entry in each binary build', () => {
  const pkg = path.join(import.meta.dir, '..')
  const files = [...new Bun.Glob('src/**/*.ts').scanSync({ cwd: pkg })]
  const entries = files.flatMap((file) =>
    [
      ...readFileSync(path.join(pkg, file), 'utf8').matchAll(/new Worker\(new URL\('\.\/([^']+)'/g),
    ].map((m) => path.join(path.dirname(file), m[1]!)),
  )
  const builds = [
    ...readFileSync(path.join(pkg, 'vx.config.ts'), 'utf8').matchAll(/'bun build --compile[^']*'/g),
  ].map((m) => m[0])
  const check = readFileSync(path.join(pkg, 'scripts/check-binary.ts'), 'utf8')
  expect(entries).toEqual(['src/cache/history-writer.ts'])
  expect(builds.length).toBe(4)
  for (const entry of entries) {
    expect(builds.filter((b) => !b.includes(` ${entry} `))).toEqual([])
    expect(check).toContain(`'${entry}'`)
  }
})
