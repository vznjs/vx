// Ctrl-Z (SIGTSTP) during `vx run`: vx stops its tasks with it and
// continues them with it. A file of its own: with the rest of the signal
// tests it was 45 s, more than a whole shard's share of the suite.

import { readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { waitForDead } from './helpers/alive.js'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'

// As signal-handling.test.ts: 200 ms proves the escalation the 2 s default does.
process.env['VX_TEST_KILL_GRACE'] = '200ms'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 30_000

interface Fixture {
  root: string
}

async function makeWorkspace(): Promise<Fixture> {
  const root = await makeWorkspaceRoot({ prefix: 'vx-signal-' })
  return { root }
}

// Wait for the number, not the file: the shell truncates it before it writes it.
async function waitForPid(file: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const f = Bun.file(file)
    if (await f.exists()) {
      const pid = Number((await f.text()).trim())
      if (Number.isInteger(pid) && pid > 0) return pid
    }
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for a pid in ${file}`)
}

/** A process's state letter from /proc (`T` stopped, `S` sleeping). */
function procState(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
}

/**
 * `stopped` is `T`, or `t` under a tracer: CI's Linux sandbox runs the
 * suite under strace, and a traced process's group stop reads `t`. A
 * syscall stop reads `t` too but passes in microseconds, so a state counts
 * only once two samples in a row agree.
 */
async function untilState(pid: number, want: 'stopped' | 'S', timeoutMs: number): Promise<string> {
  const ok = (s: string): boolean => (want === 'stopped' ? s === 'T' || s === 't' : s === want)
  const deadline = Date.now() + timeoutMs
  let prev = ''
  let got = procState(pid)
  while (!(ok(got) && ok(prev)) && Date.now() < deadline) {
    await Bun.sleep(20)
    prev = got
    got = procState(pid)
  }
  return ok(got) && want === 'stopped' ? 'stopped' : got
}

// Ctrl-Z stops the terminal's foreground group, which is vx's alone: a
// task runs in its own session. vx stopped and its tasks ran on, so an
// interactive one kept reading the terminal the shell had taken back.
describe.skipIf(process.platform !== 'linux')('Ctrl-Z (SIGTSTP) during vx run', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'stops every task with vx, and continues them with it',
    async () => {
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              slow: { exec: { command: 'echo $$ > pid.txt; exec sleep 30' } },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'slow', '--all'], {
        cwd: fixture.root,
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
      try {
        proc.kill('SIGTSTP')
        expect(await untilState(proc.pid, 'stopped', 5_000)).toBe('stopped')
        expect(await untilState(pid, 'stopped', 5_000)).toBe('stopped')
        proc.kill('SIGCONT')
        expect(await untilState(pid, 'S', 5_000)).toBe('S')
        proc.kill('SIGTERM')
        expect(await proc.exited).toBe(143)
        expect(await waitForDead(pid, 3_000)).toBe(true)
      } finally {
        proc.kill('SIGKILL')
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // gone
        }
      }
    },
    TIMEOUT,
  )

  it(
    'time stopped is not run time: a task continued by fg is not timed out',
    async () => {
      // A plain timer kept counting while vx and the task were stopped,
      // and killed the task as timed out the moment vx continued. `sleep`
      // counts wall time, so the second one is the run time left after `fg`.
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              slow: { exec: { command: 'echo $$ > pid.txt; sleep 1; sleep 1', timeout: '3s' } },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'slow', '--all'], {
        cwd: fixture.root,
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await waitForPid(path.join(dir, 'pid.txt'), 10_000)
      try {
        proc.kill('SIGTSTP')
        expect(await untilState(proc.pid, 'stopped', 5_000)).toBe('stopped')
        await Bun.sleep(4_000)
        proc.kill('SIGCONT')
        const err = await new Response(proc.stderr).text()
        expect([await proc.exited, err.includes('timed out')]).toEqual([0, false])
      } finally {
        proc.kill('SIGKILL')
      }
    },
    TIMEOUT,
  )

  it(
    'a stop longer than the run time left does not lift the timeout',
    async () => {
      // The deadline passed while vx was stopped; the timer re-armed for the
      // whole stop, not the run time left, so the task outlived its 2 s.
      // The test ends the task, 6 s after `fg`: between the deadline (2 s
      // less the time ran) and the whole stop's re-arm (8 s). A chain of
      // `sleep`s ended it, and `sleep` counts the stop as slept, so the
      // task ended within ms of its deadline and a loaded vx saw it exit
      // first (CI, 2026-11-12).
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              slow: { exec: { command: 'echo $$ > pid.txt; until [ -e release ]; do sleep 0.05; done', timeout: '2s' } },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'slow', '--all'], {
        cwd: fixture.root,
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await waitForPid(path.join(dir, 'pid.txt'), 10_000)
      try {
        proc.kill('SIGTSTP')
        expect(await untilState(proc.pid, 'stopped', 5_000)).toBe('stopped')
        await Bun.sleep(8_000)
        proc.kill('SIGCONT')
        await Promise.race([proc.exited, Bun.sleep(6_000)])
        await writeFile(path.join(dir, 'release'), '')
        const out =
          (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
        expect([await proc.exited, out.includes('timed out')]).toEqual([1, true])
      } finally {
        proc.kill('SIGKILL')
      }
    },
    TIMEOUT,
  )
})
