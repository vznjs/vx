// `ownRssHighWater` reads this process's peak through getrusage, one
// syscall, where it read `VmHWM` out of `/proc/self/status`. The swap is
// a claim: getrusage's peak is the same mark as `VmHWM` (raised only by
// the image this process exec'd from), so the floor it sets under a
// child's `ru_maxrss` is the one the kernel folded into the child.
//
// The 200 MB peak is raised in a child process: raised in the test
// runner, every vx a later file in the same shard spawned inherited it
// through fork, and `vx last`'s memory column fell under the floor's
// slack (last.test.ts, dealt beside this file).

import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const RUNNER = path.resolve(import.meta.dir, '..', 'src', 'exec', 'runner.js')

const PROBE = `
import { readFileSync } from 'node:fs'
import { ownRssHighWater, RSS_FLOOR_SLACK_BYTES } from ${JSON.stringify(RUNNER)}
const status = (field) =>
  Number(new RegExp(field + ':\\\\s+(\\\\d+) kB').exec(readFileSync('/proc/self/status', 'utf8'))[1]) * 1024
const MB = 1024 * 1024
let hold = new Uint8Array(200 * MB).fill(1)
const touched = hold[5]
hold = undefined
for (let i = 0; i < 20 && status('VmRSS') > status('VmHWM') - 100 * MB; i++) {
  Bun.gc(true)
  await Bun.sleep(25)
}
const peak = status('VmHWM')
console.log(JSON.stringify({ touched, peak, rss: status('VmRSS'), own: ownRssHighWater(), slack: RSS_FLOOR_SLACK_BYTES }))
`

describe.skipIf(process.platform !== 'linux')('ownRssHighWater on Linux', () => {
  it("is /proc's VmHWM within the floor's slack, in bytes, not the current RSS", async () => {
    // A known peak well above any runtime's baseline, then released, so a
    // wrong unit (kilobytes read as bytes) or the current RSS instead of
    // the peak cannot land inside the window.
    const proc = Bun.spawn([process.execPath, '-e', PROBE], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect({ code, err }).toEqual({ code: 0, err: '' })
    const { touched, peak, rss, own, slack } = JSON.parse(out) as Record<string, number>
    const MB = 1024 * 1024
    expect(touched).toBe(1)
    // The positive first: the peak is the allocation's and the current RSS
    // has left it, so the two readings are told apart.
    expect(peak).toBeGreaterThanOrEqual(200 * MB)
    expect(rss).toBeLessThan(peak! - 100 * MB)
    expect(Math.abs(own! - peak!)).toBeLessThan(slack!)
  })
})
