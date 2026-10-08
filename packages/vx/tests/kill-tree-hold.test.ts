// `holdGroups` driven directly: a child process spawns a guarded task,
// holds and releases its group by hand, then SIGKILLs itself; the group
// guard's EOF kill (kill-tree.ts) says whether the group was still listed.
// The task's grandchild writes `late.txt` a second after it starts, so
// the file answers "was the group killed" without reading liveness. The
// two rows item 866 left unheld: a deferred release that is never
// written, and a hold count that lets go at the first of two holds.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { guardLine } from '../src/exec/kill-tree.js'
import { isAlive, waitForDead } from './helpers/alive.js'

const KILL_TREE = path.resolve(import.meta.dir, '..', 'src', 'exec', 'kill-tree.ts')

/** Run the scenario in a child; resolve with whether the grandchild outlived the child. */
async function outlivesHolder(steps: string): Promise<boolean> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-hold-'))
  try {
    const script = `
      import { guardLine, holdGroups, releaseGroup, spawnGuarded } from ${JSON.stringify(KILL_TREE)}
      const child = spawnGuarded((guard) =>
        Bun.spawn(['sh', '-c', guardLine(3) + '(sleep 1; echo late > late.txt) >/dev/null 2>&1 & echo up > up.txt; wait'], {
          cwd: ${JSON.stringify(dir)},
          stdio: ['ignore', 'ignore', 'ignore', guard],
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

// Sweep of kill-tree.ts (B-10): a hold's end wrote the release whether or
// not the runner had released, and the suite stayed green. A group the
// runner still runs must stay listed when a teardown lets it go.
it('a hold that ends before the runner releases leaves the group listed', async () => {
  expect(
    await outlivesHolder(`
      const letGo = holdGroups([child])
      letGo()
    `),
  ).toBe(false)
}, 20_000)

// B-10: a guard that has died (killed, OOM) is handed to no later spawn.
// Handed, its broken pipe made bash (macOS's sh) flush the failed guard line
// into the task's stdout: `+14248` before `ran` on the macOS job. The script
// holds the guard's own subprocess by wrapping Bun.spawn, so no pid lookup
// is involved (a sandbox's pid namespace hides the one ps shows).
it('a task spawned after the guard died still runs, and is handed no guard', async () => {
  const script = `
    const spawn = Bun.spawn
    let guard
    Bun.spawn = (cmd, opts) => {
      const child = spawn(cmd, opts)
      if (opts?.argv0 === 'vx-group-guard') guard = child
      return child
    }
    const { guardLine, spawnGuarded } = await import(${JSON.stringify(KILL_TREE)})
    const run = (cmd) =>
      spawnGuarded((g) =>
        Bun.spawn(['sh', '-c', (g === undefined ? '' : guardLine(3)) + cmd], {
          stdio: ['ignore', 'pipe', 'ignore', ...(g === undefined ? [] : [g])],
          detached: true,
        }),
      )
    await run('true').exited
    guard.kill('SIGKILL')
    await guard.exited
    let handed = false
    const task = spawnGuarded((g) => {
      handed = g !== undefined
      return Bun.spawn(['sh', '-c', (g === undefined ? '' : guardLine(3)) + 'echo ran'], {
        stdio: ['ignore', 'pipe', 'ignore', ...(g === undefined ? [] : [g])],
        detached: true,
      })
    })
    console.log(JSON.stringify([handed, await task.exited, await new Response(task.stdout).text()]))
  `
  const proc = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = [
    await new Response(proc.stdout).text(),
    await new Response(proc.stderr).text(),
  ]
  expect([await proc.exited, err]).toEqual([0, ''])
  expect(JSON.parse(out)).toEqual([false, 0, 'ran\n'])
}, 20_000)

// Sweep of kill-tree.ts (B-10): the guard line's `trap '' PIPE`. A guard
// that dies between the hand-over and the child's write leaves a broken
// pipe, and without the trap the task's shell died of SIGPIPE before
// running anything. The output is not compared: bash (macOS's sh) may
// still flush the failed line into stdout in that window.
it('the guard line runs its task when the guard’s pipe is broken', async () => {
  const reader = Bun.spawn(['true'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
  await reader.exited
  const task = Bun.spawn(['sh', '-c', `${guardLine(3)}echo ran`], {
    stdio: ['ignore', 'pipe', 'ignore', reader.stdio[3] as number],
  })
  const out = await new Response(task.stdout).text()
  expect([await task.exited, out.endsWith('ran\n')]).toEqual([0, true])
})

// `guardSession` (the sandbox runtime's session, kill-tree.md): a listed
// pid dies alone, never its group, and a listed path is removed, when the
// lister is SIGKILLed; a struck one is left. The lister runs detached, so
// the group is its own, and a group kill would take the unlisted sibling.
async function afterSessionLister(strike: boolean): Promise<Record<string, boolean>> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-session-'))
  try {
    const listedDir = path.join(dir, 'srt-obs-x')
    const listedFile = path.join(dir, 'claude-http-0.sock')
    const kept = path.join(dir, 'kept')
    const script = `
      import { mkdirSync, writeFileSync } from 'node:fs'
      import { guardSession } from ${JSON.stringify(KILL_TREE)}
      mkdirSync(${JSON.stringify(listedDir)})
      writeFileSync(${JSON.stringify(path.join(listedDir, 's.sock'))}, '')
      writeFileSync(${JSON.stringify(listedFile)}, '')
      writeFileSync(${JSON.stringify(kept)}, '')
      const listed = Bun.spawn(['sleep', '30'], { stdio: ['ignore', 'ignore', 'ignore'] })
      const sibling = Bun.spawn(['sleep', '30'], { stdio: ['ignore', 'ignore', 'ignore'] })
      writeFileSync(${JSON.stringify(path.join(dir, 'pids'))}, listed.pid + ' ' + sibling.pid)
      const strike = guardSession([listed.pid], [${JSON.stringify(listedDir)}, ${JSON.stringify(listedFile)}])
      ${strike ? 'strike()' : ''}
      process.kill(process.pid, 'SIGKILL')
    `
    const proc = Bun.spawn([process.execPath, '-e', script], {
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true,
    })
    expect(await proc.exited).toBe(137)
    const [listed, sibling] = readFileSync(path.join(dir, 'pids'), 'utf8').split(' ').map(Number)
    await waitForDead(listed!, 2_000)
    const until = Date.now() + 2_000
    // The guard removes the listed paths one `rm` at a time: wait on the last.
    while ((existsSync(listedDir) || existsSync(listedFile)) && Date.now() < until)
      await Bun.sleep(20)
    const state = {
      listedAlive: isAlive(listed!),
      siblingAlive: isAlive(sibling!),
      listedDir: existsSync(listedDir),
      listedFile: existsSync(listedFile),
      kept: existsSync(kept),
    }
    for (const pid of [listed!, sibling!]) if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    return state
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const RUNNER = path.resolve(import.meta.dir, '..', 'src', 'exec', 'runner.ts')

/** A ready server's shell exits, leaving `late.txt`'s writer in its group; `steps` run, then a `kill -9`. */
async function serverOutlivesHolder(steps: string): Promise<boolean> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-hold-'))
  try {
    const script = `
      import { holdGroups } from ${JSON.stringify(KILL_TREE)}
      import { runPersistent } from ${JSON.stringify(RUNNER)}
      const { child, ready } = runPersistent({
        command: '(sleep 1; echo late > late.txt) >/dev/null 2>&1 & echo up > up.txt',
        cwd: ${JSON.stringify(dir)},
        env: process.env,
      })
      await ready
      await child.exited
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

it('a listed session’s pid dies alone, and its paths go, with the lister', async () => {
  expect(await afterSessionLister(false)).toEqual({
    listedAlive: false,
    siblingAlive: true,
    listedDir: false,
    listedFile: false,
    kept: true,
  })
}, 20_000)

it('a struck session is left to itself', async () => {
  expect(await afterSessionLister(true)).toEqual({
    listedAlive: true,
    siblingAlive: true,
    listedDir: true,
    listedFile: true,
    kept: true,
  })
}, 20_000)

// The registry still owns a ready server after its shell exits and stops
// its group at the end of the run; the runner struck the group at the
// shell's exit, so a `kill -9` of vx left the backgrounded server to nobody.
it('a server group that outlives its shell stays listed', async () => {
  expect(await serverOutlivesHolder('')).toBe(false)
}, 20_000)

it('CONTROL: a teardown that lets the server group go strikes it', async () => {
  expect(await serverOutlivesHolder('holdGroups([child])()')).toBe(true)
}, 20_000)
