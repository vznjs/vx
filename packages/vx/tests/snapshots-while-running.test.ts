// A long run takes its output-directory snapshots while it goes, once each
// is two ticks old, so its end walks only the last seconds' trees: the run-
// end walks of 8,002 tasks held a cold run's exit ~40 ms. Only snapshots
// whose rows the process stamped are taken then, with no statement, so a
// run's statements do not depend on how long it took; the rest, and a tree
// a dependant's glob adds to, wait for the end.

import { expect, it } from 'bun:test'
import type { CacheLayer } from '../src/cache/index.js'
import {
  type OutputDirSnapshot,
  recordOutputDirSnapshots,
  snapshotWhileRunning,
} from '../src/orchestrator/miss-save.js'

function fakeCache(stamped: Set<string>) {
  const walked: string[] = []
  const reads: string[][] = []
  const cache = {
    memo: {
      stampedRowsOf: (h: string) => (stamped.has(h) ? [{ path: 'dist/a.js' }] : undefined),
      loadOutputFilesBatch: (hashes: readonly string[]) => {
        reads.push([...hashes])
        return new Map(hashes.map((h) => [h, [{ path: 'dist/a.js' }]]))
      },
      recordOutputDirs: async (hash: string) => {
        walked.push(hash)
      },
    },
  } as unknown as CacheLayer
  return { cache, walked, reads }
}

const snap = (hash: string, atEnd = false): OutputDirSnapshot => ({
  hash,
  projectDir: '/p',
  prefixes: ['dist'],
  holds: () => true,
  ...(atEnd ? { atEnd } : {}),
})

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(5)
  }
}

const TICK = 20

it('walks a stamped snapshot once it is two ticks old, leaving the rest for the end', async () => {
  const { cache, walked, reads } = fakeCache(new Set(['a', 'b', 'e']))
  const list: OutputDirSnapshot[] = []
  const stop = snapshotWhileRunning(cache, list, TICK)
  const pushed = Date.now()
  list.push(snap('a'), snap('b', true), snap('c'))
  await until(() => walked.length > 0)
  // Two whole ticks at least (a timer may fire a millisecond early).
  expect(Date.now() - pushed).toBeGreaterThanOrEqual(2 * TICK - 5)
  await Bun.sleep(3 * TICK)
  // `b` waits for the end; `c` holds no stamped rows, and is not read.
  expect([walked, reads]).toEqual([['a'], []])
  list.push(snap('e'))
  const left = await stop()
  expect(left.map((s) => s.hash)).toEqual(['b', 'c', 'e'])
  // Stopped: nothing more is walked.
  list.push(snap('f'))
  await Bun.sleep(5 * TICK)
  expect(walked).toEqual(['a'])
  // The run-end pass reads only the unstamped.
  await recordOutputDirSnapshots(cache, left)
  expect([walked.toSorted(), reads]).toEqual([['a', 'b', 'c', 'e'], [['c']]])
})
