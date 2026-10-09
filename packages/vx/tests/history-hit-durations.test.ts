// A task this machine has only restored has a p50 all the same: its hits'
// entries carry the producing execution's duration (a fresh CI runner behind
// a remote cache). An executed success here wins; an entry with no recorded
// duration (adopted) gives none. `loadFor` and `p50sFor` agree.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache, type InvocationRecord, type RunRecord } from '../src/cache/index.js'
import { LocalHistoryProvider } from '../src/orchestrator/index.js'

let dir: string
let cache: Cache
let n = 0

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vx-hit-durations-'))
  cache = new Cache(path.join(dir, 'cache'))
})
afterEach(async () => {
  cache.close()
  await rm(dir, { recursive: true, force: true })
})

async function saveEntry(hash: string, durationMs: number): Promise<void> {
  const proj = path.join(dir, 'p')
  await mkdir(proj, { recursive: true })
  const out = path.join(proj, 'out.txt')
  await writeFile(out, hash)
  await cache.save({
    hash,
    projectDir: proj,
    outputFiles: [out],
    entry: { taskId: 'p#t', command: 'build', durationMs, stdout: '' },
  })
}

function record(task: string, hash: string, durationMs: number, cacheHit: boolean): void {
  const runId = `inv-${++n}`
  const run: RunRecord = {
    hash,
    project: 'p',
    task,
    status: cacheHit ? 'cache-hit' : 'success',
    exitCode: 0,
    durationMs,
    startedAt: n,
    endedAt: n + 1,
    runId,
    wallclockStartNs: 0n,
    wallclockEndNs: 1n,
    cacheHit,
  }
  const invocation = {
    runId,
    command: 'vx run',
    requestedTasks: '[]',
    cachePolicy: 'lR,lW',
    concurrency: 1,
    flow: null,
    startedAt: n,
    endedAt: n + 1,
    totalDurationMs: 1,
    taskCount: 1,
    failedCount: 0,
    hitCount: cacheHit ? 1 : 0,
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
    host: null,
    os: null,
    arch: null,
    vxVersion: '0.0.0',
    tags: '{}',
  } satisfies InvocationRecord
  cache.recordRunBundle({ runs: [run], invocation })
}

it('a restored-only task takes its producing duration; an executed one its own', async () => {
  await saveEntry('a'.repeat(16), 500)
  await saveEntry('b'.repeat(16), 700)
  await saveEntry('c'.repeat(16), 0)
  // only-hits: restored twice, in 3 ms each, from a 500 ms build.
  record('restored', 'a'.repeat(16), 3, true)
  record('restored', 'a'.repeat(16), 4, true)
  // ran-here: one restore of a 700 ms build, one 40 ms execution here.
  record('ran', 'b'.repeat(16), 2, true)
  record('ran', 'b'.repeat(16), 40, false)
  // adopted: the entry recorded no duration.
  record('adopted', 'c'.repeat(16), 5, true)

  const ids = ['p#restored', 'p#ran', 'p#adopted', 'p#never']
  const history = new LocalHistoryProvider(cache.dbHandle())
  const table = await history.loadFor(ids)
  const expected = [500, 40, undefined, undefined]
  expect(ids.map((id) => table.get(id)?.p50DurationMs)).toEqual(expected)
  const fromP50s = await history.p50sFor(ids)
  expect(ids.map((id) => fromP50s.get(id))).toEqual(expected)
})
