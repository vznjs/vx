// A deadline that falls due while vx's thread is busy fires in the same loop
// turn as a child exit Bun has not yet reaped. The child is a zombie by then:
// it ended inside its timeout. Unsafe: telling a zombie from a live child
// reads /proc (helpers/alive.ts), and a sandboxed shard's /proc is another
// namespace's, where a zombie reads as alive and the stall below never ends.

import { describe, expect, it } from 'bun:test'
import os from 'node:os'
import { PersistentReadyError, runCommand, runPersistent } from '../src/exec/runner.js'
import { procfsIsOwn } from '../src/util/procfs.js'
import { isAlive } from './helpers/alive.js'

const TIMEOUT_MS = 30
// The first spawn of a test is reaped before the timer runs (Bun 1.4.2);
// every later one is not. Each row repeats its case so all but one hit it.
const TRIES = 4

/**
 * Hold the thread until `pid` has exited and the deadline has passed. The
 * thread is held from before the deadline, so the timer cannot run before
 * the exit, however long the child took: when the exit came on the clock
 * does not matter, only that vx sees both in one turn. The deadline runs
 * from `armedAt`, read in `onSpawn`, which runs in the turn the timer is
 * armed: a clock read before the spawn counted the spawn thread's latency
 * (37 ms of a 30 ms deadline on a loaded host).
 */
function stallPastDeadline(pid: number, armedAt: number): void {
  const bound = Date.now() + 5_000
  while (isAlive(pid)) if (Date.now() > bound) throw new Error(`${pid} never exited`)
  while (Date.now() < armedAt + TIMEOUT_MS + 50) {}
}

describe.skipIf(process.platform !== 'linux')('a deadline seen after the child exited', () => {
  it('a one-shot task that exited 0 before vx saw its deadline is not timed out', async () => {
    expect(procfsIsOwn()).toBe(true)
    const seen: unknown[] = []
    for (let i = 0; i < TRIES; i++) {
      let pid = 0
      // The child spawns on the spawn thread: its pid comes a turn later.
      let spawned!: (pid: number) => void
      const started = new Promise<number>((r) => (spawned = r))
      let armedAt = 0
      const running = runCommand({
        command: 'true',
        cwd: os.tmpdir(),
        env: process.env,
        timeoutMs: TIMEOUT_MS,
        onSpawn: (p) => {
          armedAt = Date.now()
          spawned((pid = p))
        },
      })
      await started
      stallPastDeadline(pid, armedAt)
      const res = await running
      seen.push({ exitCode: res.exitCode, timedOut: res.timedOut })
    }
    expect(seen).toEqual(Array(TRIES).fill({ exitCode: 0, timedOut: undefined }))
  })

  it('control: a task still running at the same stall is timed out', async () => {
    const seen: unknown[] = []
    for (let i = 0; i < TRIES; i++) {
      let pid = 0
      // The child spawns on the spawn thread: its pid comes a turn later.
      let spawned!: (pid: number) => void
      const started = new Promise<number>((r) => (spawned = r))
      let armedAt = 0
      const running = runCommand({
        command: 'sleep 30',
        cwd: os.tmpdir(),
        env: process.env,
        timeoutMs: TIMEOUT_MS,
        onSpawn: (p) => {
          armedAt = Date.now()
          spawned((pid = p))
        },
      })
      await started
      expect(isAlive(pid)).toBe(true)
      while (Date.now() < armedAt + TIMEOUT_MS + 50) {}
      seen.push((await running).timedOut)
    }
    expect(seen).toEqual(Array(TRIES).fill(true))
  })

  it('a server that exited before ready reads as exited, not as a readiness timeout', async () => {
    const seen: unknown[] = []
    for (let i = 0; i < TRIES; i++) {
      let pid = 0
      // The child spawns on the spawn thread: its pid comes a turn later.
      let spawned!: (pid: number) => void
      const started = new Promise<number>((r) => (spawned = r))
      let armedAt = 0
      const spawn = runPersistent({
        command: 'exit 3',
        cwd: os.tmpdir(),
        env: process.env,
        readyWhen: 'never-printed',
        timeoutMs: TIMEOUT_MS,
        onSpawn: (p) => {
          armedAt = Date.now()
          spawned((pid = p))
        },
      })
      await started
      stallPastDeadline(pid, armedAt)
      const err = await spawn.ready.then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(PersistentReadyError)
      const ready = err as PersistentReadyError
      seen.push({ reason: ready.reason, exitCode: ready.exitCode })
      await spawn.child!.exited
    }
    expect(seen).toEqual(Array(TRIES).fill({ reason: 'exited', exitCode: 3 }))
  })
})
