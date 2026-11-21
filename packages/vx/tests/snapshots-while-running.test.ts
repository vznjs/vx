// A long run takes its output-directory snapshots while it goes, once each
// is two ticks old, so its end walks only the last seconds' trees: the run-
// end walks of 8,002 tasks held a cold run's exit ~40 ms. A snapshot whose
// save has not landed waits for a later tick; one a dependant's glob adds to
// waits for the end.

import { expect, it } from 'bun:test'
import type { CacheLayer } from '../src/cache/index.js'
import { type OutputDirSnapshot, snapshotWhileRunning } from '../src/orchestrator/miss-save.js'

function fakeCache(saved: Set<string>) {
  const walked: string[] = []
  const cache = {
    memo: {
      loadOutputFilesBatch: (hashes: readonly string[]) =>
        new Map(hashes.filter((h) => saved.has(h)).map((h) => [h, [{ path: 'dist/a.js' }]])),
      recordOutputDirs: async (hash: string) => {
        walked.push(hash)
      },
    },
  } as unknown as CacheLayer
  return { cache, walked }
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

it('walks a snapshot once it is two ticks old, holding back the added-to and retrying the unsaved', async () => {
  const saved = new Set(['a', 'b'])
  const { cache, walked } = fakeCache(saved)
  const list: OutputDirSnapshot[] = []
  const stop = snapshotWhileRunning(cache, list, TICK)
  const pushed = Date.now()
  list.push(snap('a'), snap('b', true), snap('c'))
  await until(() => walked.length > 0)
  // Two whole ticks at least (a timer may fire a millisecond early).
  expect(Date.now() - pushed).toBeGreaterThanOrEqual(2 * TICK - 5)
  // `b` waits for the end; `c`'s save has not landed.
  expect(walked).toEqual(['a'])
  // Its save lands with nothing new pushed: a later tick takes it.
  saved.add('c')
  await until(() => walked.length > 1)
  expect(walked).toEqual(['a', 'c'])
  list.push(snap('e'))
  const left = await stop()
  expect(left.map((s) => s.hash)).toEqual(['b', 'e'])
  // Stopped: nothing more is walked.
  list.push(snap('f'))
  await Bun.sleep(5 * TICK)
  expect(walked).toEqual(['a', 'c'])
})

it('hands back the unsaved for the run-end pass', async () => {
  const saved = new Set<string>()
  const { cache, walked } = fakeCache(saved)
  let asked = 0
  const memo = cache.memo as unknown as { loadOutputFilesBatch: (h: readonly string[]) => unknown }
  const load = memo.loadOutputFilesBatch
  memo.loadOutputFilesBatch = (h) => {
    asked++
    return load(h)
  }
  const list: OutputDirSnapshot[] = [snap('x')]
  const stop = snapshotWhileRunning(cache, list, TICK)
  await until(() => asked > 0)
  expect(walked).toEqual([])
  expect((await stop()).map((s) => s.hash)).toEqual(['x'])
})
