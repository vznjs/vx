// The group guard's pipe when the guard is behind. Bun hands vx a
// NONBLOCKING socket for it, and the kernel queues ~280 unread writes
// whatever their size (420 against a running guard, 2026-10-08), so a
// burst of releases, or a guard the scheduler has not run, makes a write
// EAGAIN. That was read as "the guard is gone": vx stopped guarding the
// run while the guard lived on, listing every group whose release it
// never got, and SIGKILLed them at vx's CLEAN exit.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'

const KILL_TREE = path.resolve(import.meta.dir, '..', 'src', 'exec', 'kill-tree.ts')

/**
 * Run `steps` in a child that holds the guard (`guard`) and spawns guarded
 * tasks (`task()`, resolving once the task's shell has written `up`). The
 * task backgrounds a grandchild that writes `late.txt` two seconds later, past the
 * guard's longest stall.
 * Resolves with the child's exit and whether the grandchild lived.
 */
async function scenario(steps: string): Promise<[number | null, boolean]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-backlog-'))
  try {
    const up = path.join(dir, 'up.txt')
    const script = `
      const spawn = Bun.spawn
      let guard
      Bun.spawn = (cmd, opts) => {
        const child = spawn(cmd, opts)
        if (opts?.argv0 === 'vx-group-guard') guard = child
        return child
      }
      const { guardLine, releaseGroup, spawnGuarded } = await import(${JSON.stringify(KILL_TREE)})
      const task = async () => {
        const child = spawnGuarded((g) =>
          Bun.spawn(['sh', '-c', (g === undefined ? '' : guardLine(3)) + '(sleep 2; echo late > late.txt) >/dev/null 2>&1 & echo up > up.txt'], {
            cwd: ${JSON.stringify(dir)},
            stdio: ['ignore', 'ignore', 'ignore', ...(g === undefined ? [] : [g])],
            detached: true,
          }),
        )
        while ((await Bun.file(${JSON.stringify(up)}).text().catch(() => '')) !== 'up\\n') await Bun.sleep(10)
        await child.exited
        return child
      }
      const flood = () => {
        for (let i = 0; i < 2000; i++) releaseGroup({ pid: 4_000_000 + i })
      }
      ${steps}
    `
    const proc = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'pipe' })
    const code = await proc.exited
    expect(existsSync(up)).toBe(true)
    await Bun.sleep(3_000)
    return [code, existsSync(path.join(dir, 'late.txt'))]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

it('a burst of releases leaves the run guarded', async () => {
  // Spawned after the burst, the task must still be listed: the kill -9
  // takes its grandchild.
  expect(
    await scenario(`
      await task()
      flood()
      await task()
      process.kill(process.pid, 'SIGKILL')
    `),
  ).toEqual([137, false])
}, 20_000)

it('a guard that never drains kills no released group at a clean exit', async () => {
  // The guard stopped while the burst queues; the task's release cannot
  // reach it. A clean exit must leave the released task's grandchild, as
  // it does with a guard that heard the release.
  expect(
    await scenario(`
      const t = await task()
      guard.kill('SIGSTOP')
      flood()
      releaseGroup(t)
      guard.kill('SIGCONT')
    `),
  ).toEqual([0, true])
}, 20_000)

it('CONTROL: a listed group dies with a kill -9 of vx', async () => {
  expect(
    await scenario(`
      await task()
      process.kill(process.pid, 'SIGKILL')
    `),
  ).toEqual([137, false])
}, 20_000)
