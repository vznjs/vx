// A task whose `sh` cannot be spawned says why (item 242). The runner
// returned the reason on the result alone, and the orchestrator retains
// no stderr, so a box without `sh` showed "failed (exit 127)" under a
// bare `$ <command>` and nothing else (2026-09-16).
import { realpathSync } from 'node:fs'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

/** A PATH with bun and git alone: the runner cannot find sh. */
async function pathWithoutSh(withSh: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-no-sh-bin-'))
  await symlink(process.execPath, path.join(dir, 'bun'))
  await symlink(Bun.which('git') ?? '/usr/bin/git', path.join(dir, 'git'))
  if (withSh) await symlink('/bin/sh', path.join(dir, 'sh'))
  return dir
}

function vx(cwd: string, bin: string, args: string[]): { code: number; text: string } {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PATH: bin, NO_COLOR: '1', CI: '' },
  })
  return {
    code: p.exitCode ?? 1,
    text: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  }
}

describe('sh absent from PATH', () => {
  let root: string
  const bins: string[] = []
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-no-sh-' })
    await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'echo built' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
            },
          },
        }
      `,
      files: { 'src/a.txt': 'a1\n' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    for (const bin of bins.splice(0)) await rm(bin, { recursive: true, force: true })
  })

  it('the task fails with the line naming the install, in its own frame', async () => {
    const bin = await pathWithoutSh(false)
    bins.push(bin)
    const r = vx(root, bin, ['run', 'build', '--all'])
    expect(r.code).toBe(1)
    expect(r.text).toContain('app#build > failed (exit 127)')
    // The resolved path: vx works from the workspace's real path, and on
    // macOS a workspace under /tmp is /private/tmp (the darwin job, #408).
    const dir = realpathSync(path.join(root, 'packages', 'app'))
    expect(r.text).toContain(
      `[vx] vx runs each task with sh -c: failed to spawn 'sh' (working dir: ${dir}). Install a POSIX sh and re-run.`,
    )
    expect(r.text).not.toContain('Executable not found')
    expect(r.text).not.toContain('internal error')
  })

  // CONTROL: the same PATH with sh runs the task; the line is the shell's absence, not the PATH's shape.
  it('the same PATH with sh runs the task', async () => {
    const bin = await pathWithoutSh(true)
    bins.push(bin)
    const r = vx(root, bin, ['run', 'build', '--all'])
    expect(`${r.code}\n${r.text}`).toStartWith('0\n')
    expect(r.text).not.toContain('failed to spawn')
  })
})
