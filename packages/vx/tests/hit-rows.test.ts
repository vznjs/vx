// A run keeps a hit packed (hit-rows.ts), not as the record
// `runRecordOf` builds: the two are held to each other here, field for
// field, so a column added to one and not the other fails.

import { expect, it } from 'bun:test'
import { encodeHits, HitBatch, hitRecords } from '../src/history/index.js'
import { decodeHits } from '../src/history/hit-rows.js'
import { packHit, type RecordedOutcome, runRecordOf } from '../src/orchestrator/run-records.js'
import type { TaskNode } from '../src/graph/index.js'

const node = (cache: boolean): TaskNode =>
  ({
    id: 'pkg#build',
    projectName: 'pkg',
    taskName: 'build',
    projectDir: '/ws/pkg',
    requested: true,
    config: { exec: { command: 'true' }, cache, inputs: { files: ['src/**'] } },
  }) as unknown as TaskNode

const bare = (): RecordedOutcome =>
  ({
    node: node(true),
    status: 'cache-hit',
    exitCode: 0,
    durationMs: 3,
    hash: '00000000deadbeef',
    timing: { startNs: 1_234_567_890n, endNs: 1_237_999_999n },
  }) as unknown as RecordedOutcome

const full = (): RecordedOutcome =>
  ({
    node: node(false),
    status: 'cache-hit-remote',
    exitCode: 0,
    durationMs: 41,
    hash: 'feedfacefeedface',
    timing: { startNs: 5_000_000n, endNs: 46_400_000n, queuedMs: 7 },
    usage: { cpuMs: 120, peakRssBytes: 9_000_000, peakCores: 1.5, avgRssBytes: 4_000_000 },
    placement: { where: 'small#1', cores: 4, memoryBytes: 16e9, cpuShare: 0.5 },
    cache: { restored: true, outputBytes: 4096, keylessBy: 'pkg#gen' },
    attempts: { count: 2, flaky: { passes: 3, failures: 1 } },
    taintedBy: 'pkg#lint',
    timedOut: true,
    sandbox: { violations: 2 },
    notReady: 'exited',
  }) as unknown as RecordedOutcome

const ctx = {
  runId: 'run-9',
  startedAtMs: 1_700_000_000_000,
  endedAtMs: 1_700_000_000_000,
  blocks: new Map([['pkg#build', 5]]),
  remoteTraffic: new Map([['feedfacefeedface', { failures: ['download: boom', 'upload: no'] }]]),
}

/** The record as the thread binds it: its spans as numbers. */
const bound = (o: RecordedOutcome) => {
  const r = runRecordOf(o, ctx)
  return {
    ...r,
    wallclockStartNs: Number(r.wallclockStartNs),
    wallclockEndNs: Number(r.wallclockEndNs),
  }
}

it('a packed hit reads back as the record runRecordOf builds', () => {
  const failed = { ...bare(), restoreFailed: true } as RecordedOutcome
  const hits = [bare(), full(), failed, bare()]
  const rows = new HitBatch(8)
  for (const o of hits) packHit(o, ctx, rows)
  const read = hitRecords(rows, ctx) as unknown[]
  expect(read).toEqual(hits.map(bound))
  // CONTROL: the full hit sets every optional field a row has.
  expect(Object.keys(bound(full())).length).toBeGreaterThan(30)
  expect(bound(failed)).not.toHaveProperty('cacheHit')
})

// Hits settle in any order under concurrent lookups. Packed in that
// order, two no-op runs of the same hits stored the key list twice
// (kept-hits' one-row check failed on CI, job 135542336055).
it('the same hits settled in another order pack the same keys', () => {
  const hit = (task: string, where?: string): RecordedOutcome => {
    const o = bare()
    return {
      ...o,
      node: { ...o.node, id: `pkg#${task}`, taskName: task },
      ...(where === undefined ? {} : { placement: { where } }),
    } as RecordedOutcome
  }
  const pack = (tasks: [string, string?][]) => {
    const rows = new HitBatch(8)
    for (const [t, w] of tasks) packHit(hit(t, w), ctx, rows)
    return encodeHits([rows])
  }
  const a = pack([['a'], ['b', 'small#1'], ['c']])
  const b = pack([['c'], ['a'], ['b', 'small#1']])
  expect(b.keys).toBe(a.keys)
  expect(hitRecords(decodeHits(b), ctx).map((r) => [r.task, r.placement])).toEqual([
    ['a', undefined],
    ['b', 'small#1'],
    ['c', undefined],
  ])
})
