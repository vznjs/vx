// Groups released in one turn are struck from the guard's list in one
// write (2026-11-03): a write per task, and a wake of the guard's shell
// per line, held a cold run's main thread. strace counts the writes, so
// this runs in the unsafe suite (ptrace does not nest in the sandbox).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'

const KILL_TREE = path.resolve(import.meta.dir, '..', 'src', 'exec', 'kill-tree.ts')
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
