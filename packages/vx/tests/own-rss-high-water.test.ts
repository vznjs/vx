// `ownRssHighWater` is the floor under a child's `ru_maxrss`: this
// process's own `VmHWM`, the mark the kernel folds into the child at exec.
// getrusage's own peak is not it: that one also holds the peak of the
// image this process exec'd from, which under vfork is the PARENT's memory,
// so vx spawned from a 300 MB runner read a 300 MB floor and a task holding
// 150 MB reported no peak (I-40, reverted).

import { readFileSync } from 'node:fs'
import path from 'node:path'
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

  it('is not raised by the parent it was spawned from', async () => {
    // The parent holds 300 MB while it spawns; the child allocates nothing.
    const MB = 1024 * 1024
    const hold = new Uint8Array(300 * MB).fill(1)
    expect(status('VmHWM')).toBeGreaterThanOrEqual(300 * MB)
    const runner = JSON.stringify(path.resolve(import.meta.dir, '../src/exec/runner.ts'))
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `const { ownRssHighWater } = await import(${runner}); console.log(ownRssHighWater())`,
      ],
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env },
    })
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(hold[5]).toBe(1)
    expect(code).toBe(0)
    const floor = Number(out.trim())
    // The positive first: a floor was read at all.
    expect(floor).toBeGreaterThan(0)
    expect(floor).toBeLessThan(200 * MB)
  })
})
