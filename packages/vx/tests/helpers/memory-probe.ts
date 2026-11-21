// Preloaded into a vx process (`bun --preload`) by the memory-ceiling
// suite. At exit it writes the process's own peak RSS, `/proc`'s VmHWM: the
// peak of this image only. A child's `ru_maxrss` is not it, since under
// vfork the spawning test runner's memory is folded into that figure
// (tests/own-rss-high-water.test.ts). On SIGUSR2 it collects and appends
// the live heap, for a reading taken mid-run (watch).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { heapStats } from 'bun:jsc'

const out = process.env['VX_TEST_MEMORY_PROBE']
if (out !== undefined) {
  const kib = (field: string): number =>
    Number(new RegExp(`${field}:\\s+(\\d+) kB`).exec(readFileSync('/proc/self/status', 'utf8'))![1])
  process.on('exit', () => writeFileSync(out, `peak_kib=${kib('VmHWM')}\n`))
  process.on('SIGUSR2', () => {
    Bun.gc(true)
    const { heapSize, extraMemorySize } = heapStats()
    appendFileSync(`${out}.heap`, `${heapSize + extraMemorySize}\n`)
  })
}
