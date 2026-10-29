import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runCommand } from '../src/exec/runner.js'
import { spawnOff } from '../src/exec/spawn-off.js'

const linux = process.platform === 'linux'

describe('a task spawns off the scheduler thread', () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-spawn-off-'))
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  // Bun's spawn holds its thread until the child exec'd: on the scheduler's
  // that was ~0.6 ms of every cold task's turn.
  it.skipIf(!linux)(
    'runCommand calls no Bun.spawn on this thread, and reads all it did',
    async () => {
      const real = Bun.spawn
      let here = 0
      ;(Bun as { spawn: typeof Bun.spawn }).spawn = ((...a: Parameters<typeof Bun.spawn>) => {
        // The task's own, not the kill guard's one shell per process.
        if (JSON.stringify(a[0]).includes('echo out')) here++
        return real(...a)
      }) as typeof Bun.spawn
      try {
        const res = await runCommand({
          command: 'echo out; echo err >&2; exit 3',
          cwd,
          env: { PATH: process.env.PATH ?? '' },
        })
        expect(here).toBe(0)
        expect(res.exitCode).toBe(3)
        expect(res.stdout).toBe('out\n')
        expect(res.stderr).toBe('err\n')
        expect(res.cpuMs).toBeGreaterThanOrEqual(0)
      } finally {
        ;(Bun as { spawn: typeof Bun.spawn }).spawn = real
      }
    },
  )

  it.skipIf(!linux)('a spawn that throws keeps its code, as one here did', async () => {
    const res = await runCommand({
      command: 'true',
      cwd: path.join(cwd, 'gone'),
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(res.spawnFailed).toBe(true)
    expect(res.exitCode).toBe(127)
  })

  it('reports the signal that ended the child, and kills it on request', async () => {
    const child = await spawnOff({ cmd: ['sleep', '30'], stdio: ['ignore', 'ignore', 'ignore'] })
    expect(child.pid).toBeGreaterThan(0)
    child.kill('SIGTERM')
    await child.exited
    expect(child.signalCode).toBe('SIGTERM')
    expect(child.resourceUsage()?.cpuTime.total).toBeGreaterThanOrEqual(0n)
  })

  it('rejects with the errno code when the spawn throws', async () => {
    const err = await spawnOff({
      cmd: ['/nonexistent/vx-spawn-off'],
      stdio: ['ignore', 'ignore', 'ignore'],
    }).catch((e: NodeJS.ErrnoException) => e)
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
  })
})
