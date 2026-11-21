import { closeSync, fstatSync, writeSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { heldPipe } from '../src/exec/pipes.js'
import { readOff } from '../src/exec/read-off.js'
import { runCommand } from '../src/exec/runner.js'

const linux = process.platform === 'linux'

describe("a task's output is read off the scheduler thread", () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-read-off-'))
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  // Bun's pipe reader takes ~256 KiB a stream: on the scheduler's thread a
  // cold run's 19,000 streams drove full GCs that paused it.
  it.skipIf(!linux)(
    'runCommand opens no pipe reader on this thread, and streams live',
    async () => {
      const real = Bun.file
      let here = 0
      ;(Bun as { file: typeof Bun.file }).file = ((...a: Parameters<typeof Bun.file>) => {
        if (typeof a[0] === 'number') here++
        return real(...a)
      }) as typeof Bun.file
      const seen: string[] = []
      let firstAt = 0
      try {
        const r = await runCommand({
          command: 'echo one; sleep 0.4; echo two >&2',
          cwd,
          env: { PATH: process.env['PATH'] ?? '' },
          onStdout: (c) => {
            firstAt ||= performance.now()
            seen.push(c)
          },
        })
        const end = performance.now()
        expect([r.exitCode, r.stdout, r.stderr, here]).toEqual([0, 'one\n', 'two\n', 0])
        // Live: the first line arrived while the command slept.
        expect(end - firstAt).toBeGreaterThan(200)
      } finally {
        ;(Bun as { file: typeof Bun.file }).file = real
      }
      expect(seen.join('')).toBe('one\n')
    },
  )

  // A read end closed before the thread's first pull is reused by the next
  // pipe and read as this one: a cancel settles only once the thread let go.
  it.skipIf(!linux)('a cancel settles once the thread closed the descriptor', async () => {
    const [r, w] = heldPipe()!
    const reader = readOff(r!).getReader()
    await reader.cancel()
    expect(() => fstatSync(r!)).toThrow(/EBADF|bad file/i)
    fstatSync(w!)
    // An ended stream closes its descriptor too.
    const [r2, w2] = heldPipe()!
    const s = readOff(r2!)
    writeSync(w2!, 'x')
    closeSync(w2!)
    expect(await new Response(s).text()).toBe('x')
    expect(() => fstatSync(r2!)).toThrow(/EBADF|bad file/i)
    closeSync(w!)
  })

  // Unpaced, the thread drained a pipe as fast as the task wrote it and held
  // every chunk the logger had not taken yet: 1.5 GB for a 3 GB stdout.
  it.skipIf(!linux)('a stream nobody reads stalls the writer', async () => {
    const [r, w] = heldPipe()!
    const mib = 64
    const child = Bun.spawn(['head', '-c', String(mib * 1024 * 1024), '/dev/zero'], {
      stdout: w!,
      stderr: 'ignore',
    })
    closeSync(w!)
    const s = readOff(r!)
    await Bun.sleep(1500)
    // Before: the thread had taken all 64 MiB and the writer was gone.
    expect(child.exitCode).toBeNull()
    let n = 0
    for await (const c of s) n += c.byteLength
    expect([n, await child.exited]).toEqual([mib * 1024 * 1024, 0])
  })
})
