// The guard's lines go one write per turn (2026-11-03): a write per task,
// and a wake of the guard's shell per line, held a cold run's main thread.
// Groups released in one turn are struck in one write, and vx lists a
// spare shell's group itself, beside the turn's other lines, before the
// spare runs a line of its task. strace counts the writes, so this runs
// in the unsafe suite (ptrace does not nest in the sandbox).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'

const KILL_TREE = path.resolve(import.meta.dir, '..', 'src', 'exec', 'kill-tree.ts')
const RUNNER = path.resolve(import.meta.dir, '..', 'src', 'exec', 'runner.ts')
const strace = Bun.which('strace')

it.skipIf(process.platform !== 'linux' || strace === null)(
  'fifty releases in one turn are one write to the guard',
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-strikes-'))
    try {
      const log = path.join(dir, 'strace.log')
      const script = `
        const { releaseGroup, spawnGuarded } = await import(${JSON.stringify(KILL_TREE)})
        await spawnGuarded((g) => Bun.spawn(['true'], { stdio: ['ignore', 'ignore', 'ignore', g] })).exited
        for (let i = 0; i < 50; i++) releaseGroup({ pid: 4_000_000 + i })
        await new Promise((r) => setImmediate(r))
      `
      const proc = Bun.spawn(
        [strace!, '-f', '-e', 'trace=write', '-s', '64', '-o', log, process.execPath, '-e', script],
        { stdout: 'ignore', stderr: 'pipe' },
      )
      expect(await proc.exited).toBe(0)
      const writes = readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => /write\(\d+, "-40000\d\d/.test(l))
      expect(writes.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  20_000,
)

it.skipIf(process.platform !== 'linux' || strace === null)(
  "vx lists a spare shell's group: the shell writes no line of its own",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-listing-'))
    try {
      const log = path.join(dir, 'strace.log')
      const script = `
        const { runCommand } = await import(${JSON.stringify(RUNNER)})
        const env = { PATH: process.env.PATH ?? '' }
        for (let i = 0; i < 4; i++) {
          const r = await runCommand({ command: 'echo ran', cwd: ${JSON.stringify(dir)}, env })
          if (r.stdout !== 'ran\\n') throw new Error('task output: ' + r.stdout)
        }
      `
      const proc = Bun.spawn(
        [strace!, '-f', '-e', 'trace=write', '-s', '64', '-o', log, process.execPath, '-e', script],
        { stdout: 'ignore', stderr: 'pipe' },
      )
      expect(await proc.exited).toBe(0)
      const lines = readFileSync(log, 'utf8').split('\n')
      const listings = lines.flatMap((l) => {
        const m = /^(\d+) write\(\d+, "\+(\d+)/.exec(l)
        return m === null ? [] : [{ writer: m[1], listed: m[2] }]
      })
      // The first task spawns fresh and lists itself; the spares after it
      // are listed by vx.
      const self = listings.filter((l) => l.writer === l.listed)
      expect([listings.length >= 4, self.length]).toEqual([true, 1])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  20_000,
)
