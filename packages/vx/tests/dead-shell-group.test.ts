// A task's shell that dies on its own (SIGKILL, a crash) takes its process
// group with it at once. Before, a `kill -9`ed dev server's children held its
// port under init while `vx watch` idled, until the next change restarted it,
// and a one-shot shell's children outlived the run. A stop vx sends itself
// keeps its grace: the shell dying on vx's SIGTERM is no reason to SIGKILL
// what is still cleaning up.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { killTree, untilGroupsGone } from '../src/exec/kill-tree.js'
import { runCommand, runPersistent } from '../src/exec/runner.js'
import { killIfAlive, waitForDead } from './helpers/alive.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-dead-shell-group-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const env = { PATH: process.env.PATH ?? '' }
let n = 0

async function pidIn(file: string): Promise<number> {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (existsSync(file)) {
      const pid = Number.parseInt(readFileSync(file, 'utf8'), 10)
      if (pid > 0) return pid
    }
    if (Date.now() > deadline) throw new Error('the child never wrote its pid')
    await Bun.sleep(10)
  }
}

describe.skipIf(process.platform === 'win32')('a task shell that dies on its own', () => {
  it('takes a one-shot task’s backgrounded child with it', async () => {
    const pidFile = path.join(dir, `gc-${++n}`)
    let pid: number | undefined
    try {
      const result = await runCommand({
        command: `sleep 300 & echo $! > ${pidFile}; kill -9 $$`,
        cwd: dir,
        env,
      })
      expect(result.exitCode).toBe(137)
      pid = await pidIn(pidFile)
      expect(await waitForDead(pid, 2_000)).toBe(true)
    } finally {
      if (pid !== undefined) killIfAlive(pid)
    }
  }, 30_000)

  it('takes a persistent server’s children with it', async () => {
    const pidFile = path.join(dir, `gc-${++n}`)
    const spawn = runPersistent({
      command: `sleep 300 & echo $! > ${pidFile}; echo ready; wait`,
      cwd: dir,
      env,
      readyWhen: 'ready',
    })
    const child = spawn.child!
    let pid: number | undefined
    try {
      await spawn.ready
      pid = await pidIn(pidFile)
      process.kill(child.pid, 'SIGKILL')
      await child.exited
      expect(await waitForDead(pid, 2_000)).toBe(true)
    } finally {
      killTree(child, 'SIGKILL')
      if (pid !== undefined) killIfAlive(pid)
    }
  }, 30_000)

  it('keeps the grace of a stop vx sent', async () => {
    const pidFile = path.join(dir, `gc-${++n}`)
    const done = path.join(dir, `done-${n}`)
    const spawn = runPersistent({
      command: `sh -c 'trap "sleep 0.3; echo done > ${done}; exit 0" TERM; echo $$ > ${pidFile}; while :; do sleep 0.05; done' & echo ready; wait`,
      cwd: dir,
      env,
      readyWhen: 'ready',
    })
    const child = spawn.child!
    let pid: number | undefined
    try {
      await spawn.ready
      pid = await pidIn(pidFile)
      killTree(child, 'SIGTERM')
      await child.exited
      for (const c of await untilGroupsGone([child], 5_000)) killTree(c, 'SIGKILL')
      expect(existsSync(done)).toBe(true)
    } finally {
      killTree(child, 'SIGKILL')
      if (pid !== undefined) killIfAlive(pid)
    }
  }, 30_000)
})
