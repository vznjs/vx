// A stop sent to a whole process group (`kill -TERM -<pgid>`, a closed
// terminal's SIGHUP to a background job) reaches vx from the kernel and
// again through the parent that relays stops to it: npm-launcher.cjs where
// Node cannot execve, or a global vx handing the call to the workspace's
// own. Outside a terminal's foreground the parent cannot tell a group stop
// from one sent to it alone, so it passes it on, and vx read the copy as a
// second stop, "now": every task was SIGKILLed mid-cleanup
// (vercel/turborepo#14972, reproduced on vx 2026-11-11).

import { existsSync } from 'node:fs'
import { mkdir, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { lock } from './helpers/orchestrator.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const LAUNCHER = path.resolve(import.meta.dir, '..', 'npm-launcher.cjs')
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const HANDOFF = path.resolve(import.meta.dir, '..', 'src', 'handoff.ts')
const NODE = Bun.which('node')
const TIMEOUT = 30_000

let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A task whose cleanup takes 0.5 s of the grace, and says when it ran. */
async function workspace(): Promise<string> {
  root = await makeWorkspace({ prefix: 'vx-relayed-signal-' })
  await addProject(
    root,
    'app',
    `export default { tasks: { t: { exec: { command: "trap 'sleep 0.5; echo cleaned > cleaned.txt; exit 0' INT TERM; touch started; while :; do sleep 0.05; done" } } } }`,
  )
  await lock(root)
  return path.join(root, 'packages', 'app')
}

/** Starts `cmd` as its own process group, outside any terminal, and stops the group once the task is up. */
async function stopGroup(
  cmd: string[],
  dir: string,
  signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP',
): Promise<number | null> {
  const p = Bun.spawn({
    cmd,
    cwd: path.dirname(path.dirname(dir)),
    env: { ...process.env, VX_TEST_KILL_GRACE: '5000ms' },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  })
  try {
    const deadline = Date.now() + 15_000
    while (!existsSync(path.join(dir, 'started'))) {
      if (Date.now() > deadline) throw new Error('the task never started')
      await Bun.sleep(20)
    }
    process.kill(-p.pid, signal)
    return await p.exited
  } finally {
    try {
      process.kill(-p.pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
}

/**
 * A launcher as Bun's package-bin runner is one: it runs vx for its own
 * arguments, stays its parent, relays each SIGINT and sets no mark.
 */
async function launcher(): Promise<string[]> {
  const file = path.join(root!, 'launch.mjs')
  await Bun.write(
    file,
    `const c = Bun.spawn([process.execPath, ${JSON.stringify(BIN)}, ...process.argv.slice(2)], { stdio: ['ignore', 'ignore', 'ignore'] })
process.on('SIGINT', () => c.kill('SIGINT'))
process.exit(await c.exited)
`,
  )
  return [process.execPath, file, 'run', 'app#t']
}

describe('a stop sent to the whole group through a relaying parent', () => {
  it.skipIf(NODE === null)(
    'the Node launcher: the task gets its grace for a group SIGTERM',
    async () => {
      const dir = await workspace()
      await stopGroup([NODE!, LAUNCHER, 'run', 'app#t'], dir, 'SIGTERM')
      expect(existsSync(path.join(dir, 'cleaned.txt'))).toBe(true)
    },
    TIMEOUT,
  )

  it.skipIf(NODE === null)(
    'the Node launcher: the task gets its grace for a group SIGHUP',
    async () => {
      const dir = await workspace()
      await stopGroup([NODE!, LAUNCHER, 'run', 'app#t'], dir, 'SIGHUP')
      expect(existsSync(path.join(dir, 'cleaned.txt'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a global vx handing off: the task gets its grace for a group SIGTERM',
    async () => {
      const dir = await workspace()
      await stopGroup(
        [
          process.execPath,
          '-e',
          `const { handOff } = await import(${JSON.stringify(HANDOFF)}); await handOff(${JSON.stringify(BIN)}, ['run', 'app#t'])`,
        ],
        dir,
        'SIGTERM',
      )
      expect(existsSync(path.join(dir, 'cleaned.txt'))).toBe(true)
    },
    TIMEOUT,
  )

  // Bun's package-bin runner (`bun vx run …`, the form every doc uses)
  // relays every SIGINT to the vx it spawned, in a terminal's foreground
  // too, and sets no mark: a Ctrl-C reached vx from the terminal and again
  // from bun 0.2 ms later, and vx SIGKILLed every task and exited with no
  // summary (2026-11-12).
  it(
    'a launcher that relays SIGINT and sets no mark: the task gets its grace',
    async () => {
      const dir = await workspace()
      const code = await stopGroup(await launcher(), dir, 'SIGINT')
      expect({ code, cleaned: existsSync(path.join(dir, 'cleaned.txt')) }).toEqual({
        code: 130,
        cleaned: true,
      })
    },
    TIMEOUT,
  )

  it(
    'a launcher that relays SIGINT: a second Ctrl-C later still ends the grace at once',
    async () => {
      root = await makeWorkspace({ prefix: 'vx-relayed-signal-' })
      await addProject(
        root,
        'app',
        `export default { tasks: { t: { exec: { command: "trap 'echo heard > heard.txt' INT; touch started; while :; do sleep 0.05; done" } } } }`,
      )
      await lock(root)
      const dir = path.join(root, 'packages', 'app')
      const p = Bun.spawn({
        cmd: await launcher(),
        cwd: root,
        // A grace no test outlasts: only the second press can end the run.
        env: { ...process.env, VX_TEST_KILL_GRACE: '600000ms' },
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      })
      try {
        const deadline = Date.now() + 15_000
        while (!existsSync(path.join(dir, 'started'))) {
          if (Date.now() > deadline) throw new Error('the task never started')
          await Bun.sleep(20)
        }
        process.kill(-p.pid, 'SIGINT')
        while (!existsSync(path.join(dir, 'heard.txt'))) {
          if (Date.now() > deadline) throw new Error('the task never heard the first')
          await Bun.sleep(20)
        }
        // A person's second press: well past the relayed copy's window.
        await Bun.sleep(200)
        process.kill(-p.pid, 'SIGINT')
        expect(await p.exited).toBe(130)
      } finally {
        try {
          process.kill(-p.pid, 'SIGKILL')
        } catch {
          // gone
        }
      }
    },
    TIMEOUT,
  )

  it(
    '`bun vx`: the task gets its grace for a group SIGINT',
    async () => {
      const dir = await workspace()
      const ws = path.dirname(path.dirname(dir))
      await mkdir(path.join(ws, 'node_modules', '.bin'), { recursive: true })
      await symlink(BIN, path.join(ws, 'node_modules', '.bin', 'vx'))
      const code = await stopGroup([process.execPath, 'vx', 'run', 'app#t'], dir, 'SIGINT')
      expect({ code, cleaned: existsSync(path.join(dir, 'cleaned.txt')) }).toEqual({
        code: 130,
        cleaned: true,
      })
    },
    TIMEOUT,
  )
})
