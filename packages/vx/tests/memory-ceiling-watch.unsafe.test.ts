// `vx watch` gives back what each cycle took (harness:
// tests/helpers/memory-ceiling.ts). The heap after a full collection,
// read through the probe's SIGUSR2, is exact where RSS is the allocator's
// high-water: over 240 cycles each printing 2 MB it read 22 MiB at cycle
// 20 and 29-32 MiB from cycle 40 to 240. A cycle that kept its output
// would add 200 MiB here.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { SETTLE_MS, until } from './helpers/watch-loop.js'
import {
  floor,
  linux,
  peakMib,
  removeScratch,
  spawnVx,
  TIMEOUT,
  workspace,
} from './helpers/memory-ceiling.js'

// 5,000 projects' files take minutes to remove on a loaded disk.
afterEach(removeScratch, TIMEOUT * 3)

const CYCLES = 80
const WARM = 20

let base = 0
beforeAll(async () => {
  if (linux) base = await floor()
}, TIMEOUT)

describe.skipIf(!linux)('vx watch memory over time', () => {
  it(
    `${CYCLES} cycles hold the heap flat and the peak bounded`,
    async () => {
      const root = await workspace({
        a: `export default { tasks: { out: { exec: { command: 'cat src/a.txt > dist/o.txt; head -c 2000000 /dev/zero | tr "\\\\0" x' }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true } } }\n`,
      })
      const w = spawnVx(root, ['watch', 'a#out'])
      try {
        await until(() => w.out().includes('watching'), 'watching', 30_000)
        await Bun.sleep(SETTLE_MS)
        const heapFile = `${w.probe}.heap`
        const heapMib = async (): Promise<number> => {
          const lines = async () =>
            (await Bun.file(heapFile).exists())
              ? (await readFile(heapFile, 'utf8')).trim().split('\n')
              : []
          const before = (await lines()).length
          w.proc.kill('SIGUSR2')
          await until(async () => (await lines()).length > before, 'a heap reading')
          return Number((await lines()).at(-1)) / 1024 / 1024
        }
        let warm = 0
        for (let i = 1; i <= CYCLES; i++) {
          await writeFile(path.join(root, 'packages', 'a', 'src', 'a.txt'), `edit ${i}\n`)
          await until(
            () => w.closed() > i,
            `cycle ${i}\n${w.out().slice(-2000)}\n${w.err().slice(-2000)}`,
            30_000,
          )
          if (i === WARM) warm = await heapMib()
        }
        const grown = (await heapMib()) - warm
        w.proc.kill('SIGINT')
        const peak = await peakMib(w)
        expect(grown).toBeLessThan(16)
        // Measured +85 MiB.
        expect(peak - base).toBeLessThan(256)
      } finally {
        w.proc.kill('SIGKILL')
      }
    },
    TIMEOUT,
  )
})
