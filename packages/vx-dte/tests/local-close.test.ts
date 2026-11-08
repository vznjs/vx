// `local()`'s close against core's teardown deadline (local-close-fixture.ts).

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'

const FIXTURE = path.join(import.meta.dir, 'local-close-fixture.ts')

// A worker slow to leave held close past core's 3 s, after which core
// stops waiting on a teardown: vx exited before close spawned the shell
// that removes the worktrees, and they stayed after a green run.
it('a worker that never leaves is killed and its worktree removed, though vx exits first', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-close-'))
  let pid = 0
  try {
    const root = path.join(tmp, 'ws')
    await Bun.write(path.join(root, 'a.txt'), 'a\n')
    for (const args of [
      ['init', '-q'],
      ['add', '.'],
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a'],
    ])
      expect(Bun.spawnSync(['git', ...args], { cwd: root }).exitCode).toBe(0)
    const pidfile = path.join(tmp, 'worker.pid')
    const host = Bun.spawn([process.execPath, FIXTURE, root, pidfile], {
      env: { ...process.env, TMPDIR: tmp },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    expect(await host.exited).toBe(0)
    pid = Number(await readFile(pidfile, 'utf8'))
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const left = async () => (await readdir(tmp)).filter((d) => d.startsWith('vx-dte-'))
    for (let i = 0; i < 200 && (alive() || (await left()).length > 0); i++) await Bun.sleep(50)
    expect(alive()).toBe(false)
    expect(await left()).toEqual([])
    const list = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: root })
    expect(list.stdout.toString().match(/^worktree /gm)?.length).toBe(1)
  } finally {
    try {
      if (pid > 0) process.kill(pid, 'SIGKILL')
    } catch {
      // quiet: already gone
    }
    await rm(tmp, { recursive: true, force: true })
  }
}, 30_000)
