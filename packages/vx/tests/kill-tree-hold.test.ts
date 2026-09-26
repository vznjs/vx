// `holdGroups` driven directly: a child process spawns a guarded task,
// holds and releases its group by hand, then SIGKILLs itself; the group
// guard's EOF kill (kill-tree.ts) says whether the group was still listed.
// The task's grandchild writes `late.txt` a second after it starts, so
// the file answers "was the group killed" without reading liveness. The
// two rows item 866 left unheld: a deferred release that is never
// written, and a hold count that lets go at the first of two holds.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'

const KILL_TREE = path.resolve(import.meta.dir, '..', 'src', 'exec', 'kill-tree.ts')

/** Run the scenario in a child; resolve with whether the grandchild outlived the child. */
async function outlivesHolder(steps: string): Promise<boolean> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-hold-'))
  try {
    const script = `
      import { holdGroups, releaseGroup, spawnGuarded } from ${JSON.stringify(KILL_TREE)}
      const child = spawnGuarded(() =>
        Bun.spawn(['sh', '-c', '(sleep 1; echo late > late.txt) >/dev/null 2>&1 & echo up > up.txt; wait'], {
          cwd: ${JSON.stringify(dir)},
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
        }),
      )
      while (!(await Bun.file(${JSON.stringify(path.join(dir, 'up.txt'))}).exists())) await Bun.sleep(10)
      ${steps}
      process.kill(process.pid, 'SIGKILL')
    `
    const proc = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'pipe' })
    expect(await proc.exited).toBe(137)
    expect(existsSync(path.join(dir, 'up.txt'))).toBe(true)
    await Bun.sleep(2_000)
    return existsSync(path.join(dir, 'late.txt'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

it('a release deferred by a hold is written when the hold ends', async () => {
  // Released for good once the hold lets go: the guard's EOF leaves it.
  expect(
    await outlivesHolder(`
      const letGo = holdGroups([child])
      releaseGroup(child)
      letGo()
    `),
  ).toBe(true)
}, 20_000)

it('a group two teardowns hold stays listed until both let go', async () => {
  // The first hold's end must not write the deferred release: the second
  // teardown is still in its grace, and a kill -9 there is the guard's.
  expect(
    await outlivesHolder(`
      const first = holdGroups([child])
      holdGroups([child])
      releaseGroup(child)
      first()
    `),
  ).toBe(false)
}, 20_000)

it('CONTROL: a held group whose release never came is the guard’s', async () => {
  expect(
    await outlivesHolder(`
      holdGroups([child])
      releaseGroup(child)
    `),
  ).toBe(false)
}, 20_000)
