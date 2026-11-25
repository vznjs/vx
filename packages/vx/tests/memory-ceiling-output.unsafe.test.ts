// Peak memory of a vx run whose task prints a lot (harness:
// tests/helpers/memory-ceiling.ts). Before #5468 the reader thread took a
// task's output as fast as it came: 1 GiB streamed peaked near 1.9 GB here
// and a cached 1 GiB log 1.1 GB.
//
// `.unsafe`: a traced task's exit is strace's, and strace failed under
// output floods before (output-memory.unsafe.test.ts, item 925).

import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import {
  floor,
  linux,
  MIB,
  peakMib,
  removeScratch,
  run,
  spawnVx,
  task,
  text,
  TIMEOUT,
  workspace,
} from './helpers/memory-ceiling.js'

// 5,000 projects' files take minutes to remove on a loaded disk.
afterEach(removeScratch, TIMEOUT * 3)

// vx's stdout read from 2 s in, 1 MiB per 20 ms at most. Braced: unbraced,
// vx was piped into `sleep 2` alone, and the loop read nothing of it.
const SLOW =
  '{ sleep 2; while c=$(dd bs=64k count=16 iflag=fullblock status=none | wc -c); [ "$c" -gt 0 ]; do sleep 0.02; done; }'

let base = 0
beforeAll(async () => {
  if (linux) base = await floor()
}, TIMEOUT)

describe.skipIf(!linux)('vx peak memory under task output', () => {
  it(
    'a task printing 1 GiB streams live in bounded memory',
    async () => {
      // Measured +23 MiB; +1,830 before #5468.
      const root = await workspace({ a: task(text(1024 * MIB)) })
      const { peak, out } = await run(root, ['a#out', '--no-cache'])
      expect(out).toContain('success')
      expect(peak - base).toBeLessThan(128)
    },
    TIMEOUT,
  )

  it(
    'a reader slower than the task holds vx back, not its memory',
    async () => {
      // Bun queues what a full pipe refuses: 128 MiB measured +260 MiB
      // before out-pace.ts.
      const root = await workspace({ a: task(text(128 * MIB)) })
      const s = spawnVx(root, ['run', 'a#out', '--no-cache'], SLOW)
      expect((await peakMib(s)) - base).toBeLessThan(96)
    },
    TIMEOUT,
  )

  it(
    'a cached task printing 512 MiB saves and replays in bounded memory',
    async () => {
      // The log keeps a head and a tail (CAPTURE_*_CHARS, 8 Mi each). 1 GiB
      // measured +148 MiB saving and +83 replaying; +1,019 saving before #5468.
      const root = await workspace({
        a: task(text(512 * MIB), ', outputs: { files: [] }, cache: true'),
      })
      const miss = await run(root, ['a#out'])
      const hit = await run(root, ['a#out'])
      expect(hit.out).toContain('local 1✓')
      expect(miss.peak - base).toBeLessThan(256)
      expect(hit.peak - base).toBeLessThan(256)
    },
    TIMEOUT,
  )

  it(
    'a run of several tasks keeps what it prints in a file, not memory',
    async () => {
      // Several requested tasks each print as one block when they end, read
      // back from the file their output waited in. Held in memory, 256 MiB
      // measured +582 MiB, 2.3 bytes per byte. Read by a slow reader: a
      // frame written without waiting for it sat in Bun's queue whole.
      const root = await workspace({ a: task(text(256 * MIB)), b: task('true') })
      const s = spawnVx(root, ['run', 'out', '--all', '--no-cache'], SLOW)
      expect((await peakMib(s)) - base).toBeLessThan(128)
    },
    TIMEOUT,
  )

  it(
    "errors-only keeps a failed task's output in a file until the run's end",
    async () => {
      // 300 MiB of a failed task's output: the logger held it, and its frame
      // until the summary; then, read back from its file, written whole into
      // Bun's queue for a slow reader (+299 MiB on CI).
      const root = await workspace({ a: task(`${text(300 * MIB)}; exit 1`) })
      const s = spawnVx(root, ['run', 'a#out', '--no-cache', '--output-logs=errors-only'], SLOW)
      expect((await peakMib(s, 1)) - base).toBeLessThan(128)
    },
    TIMEOUT,
  )
})
