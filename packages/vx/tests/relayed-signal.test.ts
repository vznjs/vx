// A stop sent to a whole process group (`kill -TERM -<pgid>`, a closed
// terminal's SIGHUP to a background job) reaches vx from the kernel and
// again through the parent that relays stops to it: npm-launcher.cjs where
// Node cannot execve, or a global vx handing the call to the workspace's
// own. Outside a terminal's foreground the parent cannot tell a group stop
// from one sent to it alone, so it passes it on, and vx read the copy as a
// second stop, "now": every task was SIGKILLed mid-cleanup
// (vercel/turborepo#14972, reproduced on vx 2026-11-11).

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
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

/** A task whose cleanup takes 0.5 s of the 2 s grace, and says when it ran. */
async function workspace(): Promise<string> {
  root = await makeWorkspace({ prefix: 'vx-relayed-signal-' })
  await addProject(
    root,
    'app',
    `export default { tasks: { t: { exec: { command: "trap 'sleep 0.5; echo cleaned > cleaned.txt; exit 0' TERM; touch started; while :; do sleep 0.05; done" } } } }`,
  )
  await lock(root)
  return path.join(root, 'packages', 'app')
}

/** Starts `cmd` as its own process group, outside any terminal, and stops the group once the task is up. */
async function stopGroup(cmd: string[], dir: string, signal: 'SIGTERM' | 'SIGHUP'): Promise<void> {
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
    await p.exited
  } finally {
    try {
      process.kill(-p.pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
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
})
