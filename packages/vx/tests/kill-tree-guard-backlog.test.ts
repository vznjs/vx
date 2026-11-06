// The group guard's pipe when the guard is behind. Bun hands vx a
// NONBLOCKING socket for it, and the kernel queues ~280 unread writes
// whatever their size (420 against a running guard, 2026-10-08), so a
// burst of releases, or a guard the scheduler has not run, makes a write
// EAGAIN. That was read as "the guard is gone": vx stopped guarding the
// run while the guard lived on, listing every group whose release it
// never got, and SIGKILLed them at vx's CLEAN exit.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { isAlive } from './helpers/alive.js'

const KILL_TREE = path.resolve(import.meta.dir, '..', 'src', 'exec', 'kill-tree.ts')

/**
 * Run `steps` in a child that holds the guard (`guard`) and spawns guarded
 * tasks (`task()`, resolving once the task's shell has written `up`). Each
 * task backgrounds a grandchild that writes `late.txt` only once told to.
 * Resolves with the child's exit and whether a grandchild lived.
 *
 * The verdict waits on events, never a clock: the guard's exit (its kill,
 * if any, is done), then the go, then either `late.txt` (a grandchild
 * lived) or every grandchild dead. A grandchild that wrote after a fixed
 * two seconds outran a guard the Mac scheduler held that long, and the
 * CONTROL failed with the guard's work still to come (2026-11-06).
 * `afterExit` runs once the child has exited, handed the guard's pid.
 */
async function scenario(
  steps: string,
  afterExit?: (guard: number) => Promise<void>,
): Promise<[number | null, boolean]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-backlog-'))
  try {
    const up = path.join(dir, 'up.txt')
    const late = path.join(dir, 'late.txt')
    const grandchild = `sh -c 'until [ -e go ]; do sleep 0.05; done; echo late > late.txt' >/dev/null 2>&1 & echo $! >> grandchildren.txt; echo up > up.txt`
    const script = `
      const { writeFileSync } = await import('node:fs')
      const spawn = Bun.spawn
      let guard
      Bun.spawn = (cmd, opts) => {
        const child = spawn(cmd, opts)
        if (opts?.argv0 === 'vx-group-guard') {
          guard = child
          writeFileSync(${JSON.stringify(path.join(dir, 'guard.pid'))}, String(child.pid))
        }
        return child
      }
      const { guardLine, releaseGroup, spawnGuarded } = await import(${JSON.stringify(KILL_TREE)})
      const task = async () => {
        const child = spawnGuarded((g) =>
          Bun.spawn(['sh', '-c', (g === undefined ? '' : guardLine(3)) + ${JSON.stringify(grandchild)}], {
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
    const guard = Number(readFileSync(path.join(dir, 'guard.pid'), 'utf8'))
    await afterExit?.(guard)
    while (isAlive(guard)) await Bun.sleep(20)
    writeFileSync(path.join(dir, 'go'), '')
    const pids = readFileSync(path.join(dir, 'grandchildren.txt'), 'utf8')
      .trim()
      .split('\n')
      .map(Number)
    while (!existsSync(late) && pids.some(isAlive)) await Bun.sleep(20)
    return [code, existsSync(late)]
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
}, 30_000)

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
}, 30_000)

/** Stop the guard behind a queue too full for one more line, then start a task. */
const BEHIND = `
  const { writeSync } = await import('node:fs')
  await task()
  guard.kill('SIGSTOP')
  try {
    for (;;) writeSync(guard.stdio[3], '\\n')
  } catch {}
  const t = task()
  await Bun.sleep(300)
`

it("a task's own listing waits out a full queue", async () => {
  // The task's `+` line hit the full queue (EAGAIN) and was lost: the
  // kill -9 left its group.
  expect(
    await scenario(`${BEHIND}
      guard.kill('SIGCONT')
      await t
      process.kill(process.pid, 'SIGKILL')
    `),
  ).toEqual([137, false])
}, 30_000)

it('a task waiting on a full queue runs once the guard dies', async () => {
  expect(
    await scenario(`${BEHIND}
      guard.kill('SIGKILL')
      await t
    `),
  ).toEqual([0, true])
}, 30_000)

it('a group listed twice is released by one release', async () => {
  // A shell that keeps a failed printf buffered sends its line again with
  // the retry. A clean exit must leave the released task's grandchild.
  expect(
    await scenario(`
      const { writeSync } = await import('node:fs')
      const t = await task()
      writeSync(guard.stdio[3], '+' + t.pid + '\\n')
      releaseGroup(t)
    `),
  ).toEqual([0, true])
}, 30_000)

it('CONTROL: a listed group dies with a kill -9 of vx', async () => {
  expect(
    await scenario(`
      await task()
      process.kill(process.pid, 'SIGKILL')
    `),
  ).toEqual([137, false])
}, 30_000)

it('CONTROL: a guard that runs late still takes the group', async () => {
  // The scheduler holds the guard past vx's death (a stopped guard here):
  // the kill comes late, and the verdict waits for it.
  expect(
    await scenario(
      `
      await task()
      guard.kill('SIGSTOP')
      process.kill(process.pid, 'SIGKILL')
    `,
      async (guard) => {
        await Bun.sleep(2_500)
        process.kill(guard, 'SIGCONT')
      },
    ),
  ).toEqual([137, false])
}, 30_000)
