// A temp directory that is missing or not writable names its knob (item
// 243). The run lock lives there: the line said the path and "may race"
// and left TMPDIR for the reader to guess.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

function vx(
  cwd: string,
  env: Record<string, string>,
  args: string[],
): { code: number; text: string } {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', CI: '', ...env },
  })
  return {
    code: p.exitCode ?? 1,
    text: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  }
}

describe('a temp directory that is not there', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-tmpdir-' })
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
  })

  it('the run goes on without its lock, and the line names TMPDIR', () => {
    const missing = path.join(root, 'no-such-tmp')
    const r = vx(root, { TMPDIR: missing }, ['run', 'build', '--all'])
    expect(`${r.code}\n${r.text}`).toStartWith('0\n')
    expect(r.text).toMatch(
      /\[vx\] no run lock for this workspace \(ENOENT: .*no-such-tmp.*; point TMPDIR at a writable directory\) — another vx run on it at the same time may race this one/,
    )
  })

  // CONTROL: a temp directory that is there gives the lock and no line.
  it('a temp directory that is there gives the lock and no line', () => {
    const r = vx(root, {}, ['run', 'build', '--all'])
    expect(`${r.code}\n${r.text}`).toStartWith('0\n')
    expect(r.text).not.toContain('no run lock')
  })
})
