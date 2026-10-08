// A task's own `+` line retries while its guard lives, and `kill -0`
// counts a zombie: a guard that has died but that vx has not reaped kept
// the task's shell spinning at full CPU until vx's event loop ran (2 s
// under a 2 s synchronous stretch, 2026-10-08), and for good under an
// init that never reaps an orphan. On Linux the guard's state is read
// from /proc, only where /proc is this namespace's (`procfsIsOwn()`): a
// sandboxed shard's is another's, so this row runs in the unsafe suite.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { waitForDead } from './helpers/alive.js'

const KILL_TREE = path.resolve(import.meta.dir, '..', 'src', 'exec', 'kill-tree.ts')

it.skipIf(process.platform !== 'linux')(
  'a task waiting on a full queue runs while its dead guard is unreaped',
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-zombie-'))
    try {
      const ran = path.join(dir, 'ran.txt')
      // vx's event loop is held for up to 10 s after the SIGKILL, so the
      // guard stays a zombie; the task must run inside that stretch.
      const script = `
        const { existsSync, readFileSync, writeSync } = await import('node:fs')
        const spawn = Bun.spawn
        let guard
        Bun.spawn = (cmd, opts) => {
          const child = spawn(cmd, opts)
          if (opts?.argv0 === 'vx-group-guard') guard = child
          return child
        }
        const { guardLine, spawnGuarded } = await import(${JSON.stringify(KILL_TREE)})
        const { procfsIsOwn } = await import(${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'util', 'procfs.ts'))})
        if (!procfsIsOwn()) throw new Error('/proc is not this namespace')
        await spawnGuarded((g) => spawn(['true'], { stdio: ['ignore', 'ignore', 'ignore', g] })).exited
        guard.kill('SIGSTOP')
        try {
          for (;;) writeSync(guard.stdio[3], '\\n')
        } catch {}
        spawnGuarded((g) =>
          Bun.spawn(['sh', '-c', guardLine(3) + 'echo ran > ran.txt'], {
            cwd: ${JSON.stringify(dir)},
            stdio: ['ignore', 'ignore', 'ignore', g],
            detached: true,
          }),
        )
        guard.kill('SIGKILL')
        const stat = () => {
          const s = readFileSync('/proc/' + guard.pid + '/stat', 'utf8')
          return s.slice(s.lastIndexOf(')') + 2)[0]
        }
        const deadline = Date.now() + 10_000
        while (!existsSync(${JSON.stringify(ran)}) && Date.now() < deadline) {}
        console.log(JSON.stringify([existsSync(${JSON.stringify(ran)}), stat()]))
      `
      const proc = Bun.spawn([process.execPath, '-e', script], {
        stdout: 'pipe',
        stderr: 'inherit',
      })
      const out = await new Response(proc.stdout).text()
      expect(await proc.exited).toBe(0)
      expect(JSON.parse(out)).toEqual([true, 'Z'])
      expect(readFileSync(ran, 'utf8')).toBe('ran\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  20_000,
)

it.skipIf(process.platform !== 'linux')(
  'CONTROL: a task waiting on a full queue lists itself once its live guard drains',
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-zombie-'))
    try {
      const ran = path.join(dir, 'ran.txt')
      const script = `
        const { writeSync } = await import('node:fs')
        const spawn = Bun.spawn
        let guard
        Bun.spawn = (cmd, opts) => {
          const child = spawn(cmd, opts)
          if (opts?.argv0 === 'vx-group-guard') guard = child
          return child
        }
        const { guardLine, spawnGuarded } = await import(${JSON.stringify(KILL_TREE)})
        await spawnGuarded((g) => spawn(['true'], { stdio: ['ignore', 'ignore', 'ignore', g] })).exited
        guard.kill('SIGSTOP')
        try {
          for (;;) writeSync(guard.stdio[3], '\\n')
        } catch {}
        const t = spawnGuarded((g) =>
          Bun.spawn(['sh', '-c', guardLine(3) + 'echo ran > ran.txt; exec sleep 30'], {
            cwd: ${JSON.stringify(dir)},
            stdio: ['ignore', 'ignore', 'ignore', g],
            detached: true,
          }),
        )
        await Bun.sleep(300)
        guard.kill('SIGCONT')
        while (!(await Bun.file(${JSON.stringify(ran)}).exists())) await Bun.sleep(10)
        console.log(t.pid)
        process.kill(process.pid, 'SIGKILL')
      `
      const proc = Bun.spawn([process.execPath, '-e', script], {
        stdout: 'pipe',
        stderr: 'inherit',
      })
      const pid = Number((await new Response(proc.stdout).text()).trim())
      expect(await proc.exited).toBe(137)
      expect(existsSync(ran)).toBe(true)
      // The guard heard the task's line: vx's kill -9 took the task.
      expect(await waitForDead(pid, 5_000)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  20_000,
)
