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
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import type { Logger } from '../src/report/index.js'

const T = Date.now()
// Tasks in a run test: enough confirmed hits that the run starts a thread.
const N = 2_100

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
  const stream = new HistoryStream<number>(historyFiles(cache)!, 2_048)
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
// The entries are seeded by an executor that writes each output in this
// process: 2,100 shells, traced on a packed CI worker, took the whole
// 60 s before the CLI run started (2026-11-11).
it('a restoring CLI run waits for its thread', async () => {
  const root = await makeWorkspace({ dir })
  const ws = path.join(root, '.vx/workspace.mjs')
  const plain = readFileSync(ws, 'utf8')
  const seed = pluginSource(
    'org/seed',
    `{ executor() { return { name: 'seed', execute(req) {
      const i = req.taskId.slice(req.taskId.lastIndexOf('#t') + 2)
      mkdirSync(req.cwd + '/o' + i, { recursive: true })
      writeFileSync(req.cwd + '/o' + i + '/f', 'seeded')
      return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
    } } } }`,
  )
  await Bun.write(
    ws,
    localWorkspaceSource([seed], "import { mkdirSync, writeFileSync } from 'node:fs'\n"),
  )
  const tasks = Array.from(
    { length: N },
    (_, i) =>
      `t${i}: { exec: { command: 'mkdir -p o${i} && echo ${i} > o${i}/f' }, inputs: { files: ['package.json'] }, outputs: { files: ['o${i}/**'] }, cache: true }`,
  )
  const proj = await addProject(root, 'p', `export default { tasks: { ${tasks.join(', ')} } }`)
  const names = Array.from({ length: N }, (_, i) => `t${i}`)
  expect((await run({ cwd: root, tasks: names, log: quiet })).ok).toBe(true)
  await Bun.write(ws, plain)
  for (let i = 0; i < N; i++) await rm(path.join(proj, `o${i}`), { recursive: true })
  const bin = path.join(import.meta.dir, '..', 'src', 'bin.ts')
  const p = Bun.spawnSync(['bun', bin, 'run', ...names, '--all'], {
    cwd: root,
    env: { ...process.env, VX_CACHE_DIR: '.vx/cache', NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = p.stdout.toString() + p.stderr.toString()
  expect([p.exitCode, out.includes('never settle')]).toEqual([0, false])
  expect(readFileSync(path.join(proj, 'o2099/f'), 'utf8')).toBe('seeded')
}, 60_000)

// A thread's start cost more than it saved below ~2,000 hits: 1,000
// warm projects, median 170 ms with it, 150 without (2026-11-07).
it('leaves a run expecting fewer hits than a thread is worth to its bundle', async () => {
  const cache = new Cache(path.join(dir, 'cache'))
  const stream = new HistoryStream<number>(historyFiles(cache)!, 2_047)
  for (let i = 0; i < 1_100; i++) stream.add(i, hit(i))
  const { landed, unlanded } = await stream.finish()
  const rows = (indexDb(cache).query('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n
  cache.close()
  expect([landed.length, unlanded.length, rows]).toEqual([0, 1_100, 0])
})

// Hits the run did not expect (a remote's) count too, once they reach it.
it('starts its thread at the hit that reaches the threshold', async () => {
  const cache = new Cache(path.join(dir, 'cache'))
  const stream = new HistoryStream<number>(historyFiles(cache)!, 0)
  for (let i = 0; i < 2_100; i++) stream.add(i, hit(i))
  const { landed, unlanded } = await stream.finish()
  cache.close()
  expect([landed.length, unlanded.length]).toEqual([2_048, 52])
})

it('hands back every row when its thread cannot write', async () => {
  const stream = new HistoryStream<number>(
    { index: path.join(dir, 'no', 'such', 'cache.db') },
    2_048,
  )
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
  // Enough hits for a thread: it streams whole batches, the bundle the rest.
  const tasks = Array.from(
    { length: N },
    (_, i) =>
      `t${i}: { exec: { command: 'true' }, inputs: { files: ['package.json'] }, outputs: { files: [] }, cache: true }`,
  )
  await addProject(root, 'p', `export default { tasks: { ${tasks.join(', ')} } }`)
  const names = Array.from({ length: N }, (_, i) => `t${i}`)
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
  expect([last.task_count, last.hit_count, rows]).toEqual([N, N, { n: N, tasks: N }])
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
