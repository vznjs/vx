// A git that is not on PATH is one refusal, never a stack (item 241). A
// minimal image without git met `Error: Executable not found in $PATH:
// "git" … at defaultAffectedBase` where the input enumeration already
// said "vx requires git … Install git and re-run"; every git call site
// says that line now, and the watch judge judges on without it.
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { gitIgnored } from '../src/cli/watch-filter.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { vxSync } from './helpers/vx.js'

/** A PATH with bun and sh alone: the child cannot find git. */
async function pathWithoutGit(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-no-git-bin-'))
  await symlink(process.execPath, path.join(dir, 'bun'))
  await symlink('/bin/sh', path.join(dir, 'sh'))
  return dir
}

const vx = (cwd: string, bin: string, args: string[]) => vxSync(cwd, args, { env: { PATH: bin } })

describe('git absent from PATH', () => {
  let root: string
  let bin: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-no-git-' })
    await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'cat src/a.txt > out.txt' },
              inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
            },
          },
        }
      `,
      files: { 'src/a.txt': 'a1\n' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    bin = await pathWithoutGit()
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(bin, { recursive: true, force: true })
  })

  // One row per invocation, each title a literal: the upstream ledger
  // (docs/upstream-ledger.md) cites them by their exact text.
  const oneLine = (args: string[]) => () => {
    const r = vx(root, bin, args)
    expect(r.code).toBe(1)
    expect(r.text).toContain("vx requires git: failed to spawn 'git'")
    expect(r.text).toContain('Install git and re-run')
    // The stack Bun's ENOENT carried, and the "not a work tree" guess.
    expect(r.text).not.toContain('Executable not found')
    expect(r.text).not.toContain('at spawnSync')
    expect(r.text).not.toContain('git init')
  }
  it(
    '`vx run build --affected` is one line naming the install',
    oneLine(['run', 'build', '--affected']),
  )
  it(
    '`vx run build --affected=HEAD` is one line naming the install',
    oneLine(['run', 'build', '--affected=HEAD']),
  )
  it('`vx run build --all` is one line naming the install', oneLine(['run', 'build', '--all']))

  // No workspace edit installs git, so watching on after this refusal
  // idled forever under a "watching" line.
  it('`vx watch build --all` exits on the one line naming the install', async () => {
    // Locked with git, as the run that reaches the watch's git refusal is.
    expect(vxSync(root, ['lock']).code).toBe(0)
    const p = Bun.spawn({
      cmd: [
        process.execPath,
        path.join(import.meta.dir, '../src/bin.ts'),
        'watch',
        'build',
        '--all',
      ],
      cwd: root,
      env: { ...process.env, PATH: bin, NO_COLOR: '1', CI: '', GITHUB_ACTIONS: '' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    })
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    expect(p.signalCode).toBeNull()
    expect(code).toBe(1)
    expect(out + err).toContain("vx requires git: failed to spawn 'git'")
    expect(out + err).not.toContain('watching')
  }, 20_000)

  it('the watch judge ignores nothing and keeps going', async () => {
    const saved = process.env['PATH']
    process.env['PATH'] = bin
    try {
      expect(gitIgnored(root, [path.join(root, 'packages', 'app', 'out.txt')]).size).toBe(0)
    } finally {
      process.env['PATH'] = saved
    }
  })
})
