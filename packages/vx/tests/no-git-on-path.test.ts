// A git that is not on PATH is one refusal, never a stack (item 241). A
// minimal image without git met `Error: Executable not found in $PATH:
// "git" … at defaultAffectedBase` where the input enumeration already
// said "vx requires git … Install git and re-run"; every git call site
// says that line now, and the watch judge judges on without it.
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { gitIgnored } from '../src/cli/watch.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

/** A PATH with bun and sh alone: the child cannot find git. */
async function pathWithoutGit(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-no-git-bin-'))
  await symlink(process.execPath, path.join(dir, 'bun'))
  await symlink('/bin/sh', path.join(dir, 'sh'))
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
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
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

  for (const args of [
    ['run', 'build', '--affected'],
    ['run', 'build', '--affected=HEAD'],
    ['run', 'build', '--all'],
  ]) {
    it(`\`vx ${args.join(' ')}\` is one line naming the install`, () => {
      const r = vx(root, bin, args)
      expect(r.code).toBe(1)
      expect(r.text).toContain("vx requires git: failed to spawn 'git'")
      expect(r.text).toContain('Install git and re-run')
      // The stack Bun's ENOENT carried, and the "not a work tree" guess.
      expect(r.text).not.toContain('Executable not found')
      expect(r.text).not.toContain('at spawnSync')
      expect(r.text).not.toContain('git init')
    })
  }

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
