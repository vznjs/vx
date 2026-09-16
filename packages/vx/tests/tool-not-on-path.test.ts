// A task whose tool is not on the PATH vx built (item 257): the shell says
// `exec: tsc: not found`, and vx names its PATH rule — the project's bin,
// then the root's, never a sibling's — so a tool that moved reads as what
// it is.
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

/** A PATH of bun, sh and git alone: no `tsc` from the box. */
async function bareBin(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-tool-bin-'))
  await symlink(process.execPath, path.join(dir, 'bun'))
  await symlink('/bin/sh', path.join(dir, 'sh'))
  const git = Bun.which('git')
  if (git !== null) await symlink(git, path.join(dir, 'git'))
  return dir
}

async function fakeTool(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tool = path.join(dir, 'tsc')
  await writeFile(tool, '#!/bin/sh\necho tsc 0.0.0\n')
  await chmod(tool, 0o755)
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

describe('a tool that is not on the PATH vx built', () => {
  let root: string
  let bin: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-tool-' })
    await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'tsc --version' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
            },
          },
        }
      `,
      files: { 'src/a.txt': 'a1\n' },
    })
    await addProject(root, 'tools', { config: 'export default { tasks: {} }', files: {} })
    // The tool lives in a SIBLING's bin: exactly the directory vx never puts on PATH.
    await fakeTool(path.join(root, 'packages', 'tools', 'node_modules', '.bin'))
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    bin = await bareBin()
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(bin, { recursive: true, force: true })
  })

  it('exit 127 names the word, the two bin directories and the rule, in the frame', () => {
    const r = vx(root, bin, ['run', 'build', '--all'])
    expect(r.code).toBe(1)
    expect(r.text).toContain('exec: tsc: not found')
    const app = path.join(root, 'packages', 'app', 'node_modules', '.bin')
    const rootBin = path.join(root, 'node_modules', '.bin')
    expect(r.text).toContain(
      `[vx] exit 127 is the shell's "command not found": tsc is not on this task's PATH — vx puts ${app} and ${rootBin} first and never a sibling project's bin; install it in this package or at the workspace root`,
    )
  })

  // CONTROL: the same tool at the root's bin runs, and no line is printed.
  it('the same tool at the root bin runs green with no line', async () => {
    await fakeTool(path.join(root, 'node_modules', '.bin'))
    const r = vx(root, bin, ['run', 'build', '--all'])
    expect(`${r.code}\n${r.text}`).toStartWith('0\n')
    expect(r.text).not.toContain('exit 127')
  })
})
