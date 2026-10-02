// `ownRssHighWater` reads this process's peak through getrusage, one
// syscall, where it read `VmHWM` out of `/proc/self/status`. The swap is
// a claim: getrusage's peak is the same mark as `VmHWM` (raised only by
// the image this process exec'd from), so the floor it sets under a
// child's `ru_maxrss` is the one the kernel folded into the child.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import { ownRssHighWater, RSS_FLOOR_SLACK_BYTES } from '../src/exec/runner.js'

const status = (field: string): number =>
  Number(new RegExp(`${field}:\\s+(\\d+) kB`).exec(readFileSync('/proc/self/status', 'utf8'))![1]) *
  1024

describe.skipIf(process.platform !== 'linux')('ownRssHighWater on Linux', () => {
  it("is /proc's VmHWM within the floor's slack, in bytes, not the current RSS", async () => {
    // A known peak well above any runtime's baseline, then released, so a
    // wrong unit (kilobytes read as bytes) or the current RSS instead of
    // the peak cannot land inside the window.
    const MB = 1024 * 1024
    let hold: Uint8Array | undefined = new Uint8Array(200 * MB).fill(1)
    expect(hold[5]).toBe(1)
    hold = undefined
    for (let i = 0; i < 20 && status('VmRSS') > status('VmHWM') - 100 * MB; i++) {
      Bun.gc(true)
      await Bun.sleep(25)
    }
    const peak = status('VmHWM')
    // The positive first: the peak is the allocation's and the current RSS
    // has left it, so the two readings are told apart.
    expect(peak).toBeGreaterThanOrEqual(200 * MB)
    expect(status('VmRSS')).toBeLessThan(peak - 100 * MB)
    expect(Math.abs(ownRssHighWater() - peak)).toBeLessThan(RSS_FLOOR_SLACK_BYTES)
  })
})
