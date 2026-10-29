// The blob sizes and the flaky record live in the shared store (owner,
// 2026-10-14 20:59), so every worktree of a repo reads what another
// learned: a blob size is fixed for its OID, and a cache key that passed in
// one worktree and failed in another is flaky in both.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { indexDb, Cache, type RunRecord } from '../src/cache/index.js'
import { detectFlaky, flakyTasks } from '../src/history/index.js'

let dir: string
let store: string
const open: Cache[] = []
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vx-store-memos-'))
  mkdirSync(path.join(dir, 'home'))
  store = path.join(dir, 'home', '.vx', 'id', 'cache')
})
afterEach(() => {
  for (const c of open.splice(0)) c.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A worktree's index beside the one store. */
function worktree(name: string): Cache {
  const c = new Cache(path.join(dir, name), undefined, undefined, undefined, 'open', store)
  open.push(c)
  return c
}

let seq = 0
function outcome(
  status: RunRecord['status'],
  hash = 'K',
  extra: Partial<RunRecord> = {},
): RunRecord {
  const at = Date.now() + ++seq
  return {
    hash,
    project: 'p',
    task: 't',
    status,
    exitCode: status === 'failed' ? 1 : 0,
    durationMs: 1,
    startedAt: at,
    endedAt: at + 1,
    runId: `r${seq}`,
    wallclockStartNs: 0n,
    wallclockEndNs: 1n,
    cacheHit: status === 'cache-hit' || status === 'cache-hit-remote',
    cached: true,
    ...extra,
  }
}

function storeRows(sql: string): unknown[] {
  const db = new Database(path.join(store, 'store.db'), { readonly: true })
  try {
    return db.query(sql).all()
  } finally {
    db.close()
  }
}

it('a blob size one worktree learned is known to another', () => {
  worktree('a').rememberBlobSizes(new Map([['oid1', 5]]))
  expect(worktree('b').knownBlobSizes(['oid1', 'oid2'])).toEqual(new Map([['oid1', 5]]))
})

it('a key that passed in one worktree and fails in another is flaky there', () => {
  const a = worktree('a')
  const b = worktree('b')
  a.recordRuns([outcome('success')])
  const cand = { project: 'p', task: 't', hash: 'K', status: 'failed' as const, attempts: 1 }
  expect(detectFlaky(indexDb(b), [cand])).toEqual([
    { ...cand, taskId: 'p#t', passes: 1, failures: 1 },
  ])
  b.recordRuns([outcome('failed')])
  expect(flakyTasks(indexDb(a))).toEqual([
    { taskId: 'p#t', project: 'p', task: 't', keys: 1, passes: 1, failures: 1 },
  ])
})

it("a hit is kept only as its key's first pass: a warm run on passed keys writes no row", () => {
  const a = worktree('a')
  const b = worktree('b')
  // An entry with no executed row (adopted from its artifact, or older than
  // the record): its first hit is the pass a later failure relapses from.
  a.recordRuns([outcome('cache-hit')])
  b.recordRuns([outcome('cache-hit'), outcome('cache-hit-remote')])
  a.recordRuns([outcome('success', 'J'), outcome('cache-hit-remote', 'J')])
  // A blocked or uncached outcome, or a keyless one, says nothing of a key.
  a.recordRuns([
    outcome('failed', 'L', { blockedBy: 'p#x' }),
    outcome('failed', 'M', { cached: false }),
    outcome('skipped', ''),
  ])
  expect(storeRows('SELECT status, hash FROM task_outcomes ORDER BY id')).toEqual([
    { status: 'cache-hit', hash: 'K' },
    { status: 'success', hash: 'J' },
  ])
  b.recordRuns([outcome('failed')])
  expect(flakyTasks(indexDb(a))).toEqual([
    { taskId: 'p#t', project: 'p', task: 't', keys: 1, passes: 1, failures: 1 },
  ])
})

it('worktrees recording in parallel on one store lose no outcome or blob size and never fail busy', async () => {
  const WORKERS = 6
  const RUNS = 25
  const script = path.join(dir, 'writer.ts')
  await Bun.write(
    script,
    `import { Cache } from ${JSON.stringify(path.join(import.meta.dir, '../src/cache/index.js'))}
const [cacheDir, store, w, runs] = process.argv.slice(2)
const cache = new Cache(cacheDir, undefined, undefined, undefined, 'open', store)
const at = Date.now()
for (let i = 0; i < Number(runs); i++) {
  const id = 'w' + w + '-' + i
  cache.recordRuns([{ hash: id, project: 'p', task: 't', status: i % 2 ? 'failed' : 'success', exitCode: 0, durationMs: 1, startedAt: at + i, endedAt: at + i + 1, runId: id, wallclockStartNs: 0n, wallclockEndNs: 1n, cached: true }])
  cache.rememberBlobSizes(new Map([[id, i]]))
}
cache.close()
`,
  )
  for (let w = 0; w < WORKERS; w++) worktree(`wt${w}`).close()
  open.splice(0)
  const procs = Array.from({ length: WORKERS }, (_, w) =>
    Bun.spawn(['bun', script, path.join(dir, `wt${w}`), store, String(w), String(RUNS)], {
      stderr: 'pipe',
    }),
  )
  const codes = await Promise.all(procs.map((p) => p.exited))
  const errors = await Promise.all(procs.map((p) => new Response(p.stderr).text()))
  expect(errors.filter((e) => e.length > 0)).toEqual([])
  expect(codes).toEqual(Array(WORKERS).fill(0))
  expect(storeRows('SELECT COUNT(*) AS n FROM task_outcomes')).toEqual([{ n: WORKERS * RUNS }])
  expect(storeRows('SELECT COUNT(*) AS n FROM blob_sizes')).toEqual([{ n: WORKERS * RUNS }])
}, 60_000)
