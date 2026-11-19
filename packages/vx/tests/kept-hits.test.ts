// A run keeps its cache hits as one packed row (`run_hits`, its keys in
// `hit_keys`) instead of a `runs` row each: a warm run writes none of them,
// and whoever reads the history writes them out first (`expandHits`). Held
// here: what a run stores, that the rows written out later are the rows a
// run wrote before, and that each reader sees them.
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache, indexDb } from '../src/cache/index.js'
import {
  encodeHits,
  expandHits,
  HIT,
  HitBatch,
  hitRecords,
  knownFlaky,
  listRuns,
  localHistory,
  type RunHits,
  runHistory,
  type RunRecord,
} from '../src/history/index.js'
import { pruneHistoryRows } from '../src/index-db/index.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

// Now-relative: `close()` prunes history older than 30 days (retention).
const T = Date.now()
const quiet: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-kept-hits-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const hashOf = (i: number): string => i.toString(16).padStart(16, '0')

/** `n` hits as a run packs them, a remote one with its error among them. */
function batchOf(n: number): HitBatch {
  const rows = new HitBatch(n)
  for (let i = 0; i < n; i++) {
    const at = rows.row(`p${i}`, 'build', hashOf(i), i % 2 === 0 ? `def${i}` : undefined)
    rows.nums[at + HIT.remote] = i === 1 ? 1 : 0
    rows.nums[at + HIT.exitCode] = 0
    rows.nums[at + HIT.durationMs] = 2
    rows.nums[at + HIT.startNs] = i * 1_000_000
    rows.nums[at + HIT.endNs] = i * 1_000_000 + 7
    rows.nums[at + HIT.cached] = 1
    rows.nums[at + HIT.cacheHit] = 1
    rows.nums[at + HIT.restored] = i % 3 === 0 ? 1 : 0
    rows.nums[at + HIT.blocks] = i % 3
    if (i === 1) rows.set('remoteError', 'upload refused')
  }
  return rows
}
const hitsOf = (runId: string, n: number, startedAtMs = T): RunHits => ({
  runId,
  startedAtMs,
  ...encodeHits([batchOf(n)]),
})

const failed = (i: number, runId: string): RunRecord => ({
  hash: hashOf(i),
  project: `p${i}`,
  task: 'build',
  status: 'failed',
  exitCode: 1,
  durationMs: 5,
  startedAt: T + 50,
  endedAt: T + 55,
  runId,
  wallclockStartNs: 1n,
  wallclockEndNs: 2n,
  cached: true,
})

const count = (db: Database, table: string): number =>
  (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const all = (db: Database, sql: string): unknown[] => db.query(sql).all()

it('writes out the rows, and the flaky record, a run wrote for its hits before', () => {
  const kept = new Cache(path.join(dir, 'kept'))
  const direct = new Cache(path.join(dir, 'direct'))
  runHistory(kept).recordRuns([], undefined, hitsOf('run-1', 40))
  // The same hits as records, the way a bundle wrote them before, in the
  // task order a run keeps its hits in.
  const records = hitRecords(batchOf(40), { runId: 'run-1', startedAtMs: T })
  records.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0))
  runHistory(direct).recordRuns(records)
  expect([count(indexDb(kept), 'main.runs'), count(indexDb(kept), 'main.run_hits')]).toEqual([0, 1])
  expect(expandHits(indexDb(kept))).toBe(40)
  for (const sql of [
    'SELECT * FROM main.runs ORDER BY id',
    'SELECT * FROM task_outcomes ORDER BY id',
    'SELECT * FROM task_durations ORDER BY id',
  ])
    expect(all(indexDb(kept), sql)).toEqual(all(indexDb(direct), sql))
  expect(
    all(indexDb(kept), 'SELECT status, remote_error AS e FROM main.runs WHERE id = 2'),
  ).toEqual([{ status: 'cache-hit-remote', e: 'upload refused' }])
  expect([count(indexDb(kept), 'main.run_hits'), count(indexDb(kept), 'main.hit_keys')]).toEqual([
    0, 0,
  ])
  kept.close()
  direct.close()
})

it("keeps a run's hits below the rows it wrote beside them, whenever they are written out", () => {
  const cache = new Cache(path.join(dir, 'cache'))
  const db = indexDb(cache)
  runHistory(cache).recordRuns(
    [{ ...failed(900, 'run-1'), status: 'success', exitCode: 0 }],
    undefined,
    hitsOf('run-1', 3),
  )
  runHistory(cache).recordRuns([{ ...failed(901, 'run-2'), status: 'success', exitCode: 0 }])
  expect(all(db, 'SELECT id FROM main.runs ORDER BY id')).toEqual([{ id: 4 }, { id: 5 }])
  expandHits(db)
  expect(all(db, 'SELECT id, project FROM main.runs ORDER BY id')).toEqual([
    { id: 1, project: 'p0' },
    { id: 2, project: 'p1' },
    { id: 3, project: 'p2' },
    { id: 4, project: 'p900' },
    { id: 5, project: 'p901' },
  ])
  cache.close()
})

it('stores the keys of runs that hit the same tasks once', () => {
  const cache = new Cache(path.join(dir, 'cache'))
  const db = indexDb(cache)
  for (const id of ['run-1', 'run-2', 'run-3'])
    runHistory(cache).recordRuns([], undefined, hitsOf(id, 30))
  runHistory(cache).recordRuns([], undefined, hitsOf('run-4', 31))
  expect([count(db, 'main.run_hits'), count(db, 'main.hit_keys')]).toEqual([4, 2])
  expect(expandHits(db)).toBe(121)
  expect(all(db, 'SELECT run_id, COUNT(*) AS n FROM runs GROUP BY run_id ORDER BY run_id')).toEqual(
    [
      { run_id: 'run-1', n: 30 },
      { run_id: 'run-2', n: 30 },
      { run_id: 'run-3', n: 30 },
      { run_id: 'run-4', n: 31 },
    ],
  )
  cache.close()
})

// The flaky record orders a key's outcomes by when they were written: a
// kept pass written out after a later failure read as a recovery.
it('writes kept hits out before a failure of a key is recorded', () => {
  const cache = new Cache(path.join(dir, 'cache'))
  const db = indexDb(cache)
  runHistory(cache).recordRuns([], undefined, hitsOf('run-1', 4))
  runHistory(cache).recordRuns([failed(2, 'run-2')])
  expect(count(db, 'main.run_hits')).toBe(0)
  expect(
    all(db, `SELECT status FROM task_outcomes WHERE hash = '${hashOf(2)}' ORDER BY id`),
  ).toEqual([{ status: 'cache-hit' }, { status: 'failed' }])
  cache.close()
})

it('reads a kept hit as a pass of its key', () => {
  const cache = new Cache(path.join(dir, 'cache'))
  runHistory(cache).recordRuns([], undefined, hitsOf('run-1', 4))
  expect(knownFlaky(indexDb(cache), 'p3', 'build', hashOf(3))).toBe(true)
  cache.close()
})

it('marks a kept hit whose upload failed after the run', () => {
  const cache = new Cache(path.join(dir, 'cache'))
  runHistory(cache).recordRuns([], undefined, hitsOf('run-1', 4))
  runHistory(cache).recordRemoteErrors('run-1', [[hashOf(3), 'no space']])
  expect(
    all(indexDb(cache), `SELECT remote_error AS e FROM main.runs WHERE hash = '${hashOf(3)}'`),
  ).toEqual([{ e: 'no space' }])
  cache.close()
})

it('prunes kept hits with the window, and keeps the run id of those inside it', () => {
  const cache = new Cache(path.join(dir, 'cache'))
  const db = indexDb(cache)
  runHistory(cache).recordRuns([], undefined, hitsOf('old', 5, T - 10_000))
  runHistory(cache).recordRuns([], undefined, hitsOf('kept', 6, T - 1_000))
  runHistory(cache).recordRuns([{ ...failed(900, 'new'), status: 'success', exitCode: 0 }])
  pruneHistoryRows(db, T - 5_000)
  expect(all(db, 'SELECT run_id FROM run_ids ORDER BY id')).toEqual([
    { run_id: 'kept' },
    { run_id: 'new' },
  ])
  expect([count(db, 'main.run_hits'), count(db, 'main.hit_keys')]).toEqual([1, 1])
  expandHits(db)
  expect(all(db, 'SELECT run_id, COUNT(*) AS n FROM runs GROUP BY run_id ORDER BY run_id')).toEqual(
    [
      { run_id: 'kept', n: 6 },
      { run_id: 'new', n: 1 },
    ],
  )
  cache.close()
})

/** A workspace of three cached tasks, run cold then warm twice. */
async function warmWorkspace(): Promise<{ root: string; db: () => Database; ids: string[] }> {
  const root = await makeWorkspace({ dir })
  const task = (name: string) =>
    `${name}: { exec: { command: 'sleep 0.05 && mkdir -p ${name} && echo hi > ${name}/f' }, inputs: { files: ['package.json'] }, outputs: { files: ['${name}/**'] }, cache: true }`
  await addProject(
    root,
    'p',
    `export default { tasks: { ${['a', 'b', 'c'].map(task).join(', ')} } }`,
  )
  const tasks = ['a', 'b', 'c']
  expect((await run({ cwd: root, tasks, log: quiet })).ok).toBe(true)
  for (let i = 0; i < 2; i++) {
    const warm = await run({ cwd: root, tasks, log: quiet })
    expect(warm.outcomes.map((o) => o.status)).toEqual(['cache-hit', 'cache-hit', 'cache-hit'])
  }
  return {
    root,
    db: () => new Database(path.join(root, '.vx', 'cache', 'cache.db')),
    ids: tasks.map((t) => `p#${t}`),
  }
}

it('a warm run writes one row for all its hits, and its header counts them', async () => {
  const { db: open } = await warmWorkspace()
  const db = open()
  expect(all(db, 'SELECT status, COUNT(*) AS n FROM main.runs GROUP BY status')).toEqual([
    { status: 'success', n: 3 },
  ])
  expect([count(db, 'main.run_hits'), count(db, 'main.hit_keys')]).toEqual([2, 1])
  expect(
    all(db, 'SELECT task_count AS tasks, hit_count AS hits FROM invocations ORDER BY rowid'),
  ).toEqual([
    { tasks: 3, hits: 0 },
    { tasks: 3, hits: 3 },
    { tasks: 3, hits: 3 },
  ])
  db.close()
})

it('`vx last` and its --sql read the hits a warm run kept', async () => {
  const { root, db: open } = await warmWorkspace()
  const bin = path.join(import.meta.dir, '..', 'src', 'bin.ts')
  const vx = (...args: string[]) => {
    const p = Bun.spawnSync(['bun', bin, ...args], {
      cwd: root,
      env: { ...process.env, VX_CACHE_DIR: '.vx/cache', NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  const sql = vx(
    'last',
    '--sql',
    'SELECT status, COUNT(*) AS n FROM runs GROUP BY status ORDER BY status',
    '--format',
    'json',
  )
  expect([sql.code, sql.err]).toEqual([0, ''])
  expect(JSON.parse(sql.out)).toEqual({
    rows: [
      { status: 'cache-hit', n: 6 },
      { status: 'success', n: 3 },
    ],
  })
  const db = open()
  expect(count(db, 'main.run_hits')).toBe(0)
  db.close()
  const last = vx('last', '--format', 'json')
  expect(last.code).toBe(0)
  const tasks = (JSON.parse(last.out) as { tasks: { task: string; status: string }[] }).tasks
  expect(tasks.map((t) => `${t.task} ${t.status}`).sort()).toEqual([
    'a cache-hit',
    'b cache-hit',
    'c cache-hit',
  ])
})

it("lists a run's kept hits in the order it packed them", async () => {
  const { root } = await warmWorkspace()
  const cache = Cache.inspect(path.join(root, '.vx', 'cache'))
  const rows = listRuns(indexDb(cache), { limit: 100 })
  cache.close()
  expect(rows.map((r) => r.status)).toEqual([
    ...Array<string>(6).fill('cache-hit'),
    ...Array<string>(3).fill('success'),
  ])
})

// A fresh runner behind a cache has only ever restored: its plan times a
// task by the entry's producer, read from the hits. vx-history asks before
// every run that executes, so this read leaves the hits packed.
it('a plan reads the producers of kept hits and writes none of them out', async () => {
  const { root, ids } = await warmWorkspace()
  const cache = new Cache(path.join(root, '.vx', 'cache'))
  const db = indexDb(cache)
  // As a store that never executed them.
  db.exec('DELETE FROM main.runs; DELETE FROM task_durations')
  const provider = localHistory(cache)
  const table = await provider.resourcesFor(ids)
  const durations = await provider.durationsFor(ids)
  expect(count(db, 'main.run_hits')).toBe(2)
  expect(ids.map((id) => (table.get(id)?.p50DurationMs ?? 0) >= 50)).toEqual([true, true, true])
  expect(ids.map((id) => (durations.get(id) ?? 0) >= 50)).toEqual([true, true, true])
  cache.close()
})

// A function that reads `runs` or the flaky record without writing kept
// hits out first reads a history with every recent hit missing, silently.
it('every file that reads the rows of hits writes kept ones out first', () => {
  const src = path.join(import.meta.dir, '..', 'src')
  const reads = /\b(?:FROM|JOIN)\s+(?:main\.)?(?:runs|task_outcomes)\b|\$\{OUTCOMES\}/
  const exempt: Record<string, string> = {
    // Its one read, the stats of `vx info`: doctor.ts writes them out before asking.
    'cache/prune.ts': 'expandHits',
    // The retention sweep prunes `run_hits` by the same window.
    'index-db/schema.ts': 'main.run_hits',
  }
  const unguarded = [...new Bun.Glob('**/*.ts').scanSync({ cwd: src })]
    .filter((file) => reads.test(readFileSync(path.join(src, file), 'utf8')))
    .filter((file) => !readFileSync(path.join(src, file), 'utf8').includes('expandHits('))
    .sort()
  expect(unguarded).toEqual(Object.keys(exempt).sort())
  expect(readFileSync(path.join(src, 'orchestrator/doctor.ts'), 'utf8')).toContain(
    'expandHits(indexDb(cache))\n      stats = cache.stats()',
  )
  expect(readFileSync(path.join(src, 'index-db/schema.ts'), 'utf8')).toContain(
    'DELETE FROM main.run_hits WHERE started_at < ?',
  )
})

// A compiled vx carries only the entry points its build names: a thread
// started from a file of its own must be named in each binary build.
it('starts no thread from a file the binary builds do not name', () => {
  const pkg = path.join(import.meta.dir, '..')
  const entries = [...new Bun.Glob('src/**/*.ts').scanSync({ cwd: pkg })].flatMap((file) =>
    [
      ...readFileSync(path.join(pkg, file), 'utf8').matchAll(/new Worker\(new URL\('\.\/([^']+)'/g),
    ].map((m) => path.join(path.dirname(file), m[1]!)),
  )
  const builds = [
    ...readFileSync(path.join(pkg, 'vx.config.ts'), 'utf8').matchAll(/'bun build --compile[^']*'/g),
  ].map((m) => m[0])
  expect(builds.length).toBe(4)
  for (const entry of entries) expect(builds.filter((b) => !b.includes(` ${entry} `))).toEqual([])
})
