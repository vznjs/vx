// `vx show <task>` claims every field the run reads, yet its block left
// out `exec.interactive` (the task holds the terminal) and
// `exec.env.secret` (names masked whatever they are called) (X-47).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { gradientRule } from '../src/util/index.js'

// `vx lock`, then `vx show`: show reads the lock.
const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('vx show prints exec.interactive and exec.env.secret', () => {
  it('the pretty block carries both, in the order the run reads them', async () => {
    const ws = (root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-exec-')))
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `
export default {
  tasks: {
    repl: {
      exec: {
        command: 'node',
        interactive: true,
        env: { passThrough: ['GH_PAT'], secret: ['GH_PAT'] },
      },
    },
    quiet: { exec: { command: 'true', interactive: false } },
  },
}
`,
    )
    const show = (target: string): string =>
      Bun.spawnSync({
        cmd: [process.execPath, BIN, 'show', target],
        cwd: ws,
        env: { ...process.env },
        stdout: 'pipe',
      }).stdout.toString()
    expect([show('a#repl'), show('a#quiet')]).toEqual([
      [
        '',
        gradientRule({ enabled: false }, 'a#repl'),
        '  dir              packages/a',
        '  command          node',
        '  env.passThrough  GH_PAT',
        '  env.secret       GH_PAT',
        '  interactive      yes',
        '',
      ].join('\n'),
      [
        '',
        gradientRule({ enabled: false }, 'a#quiet'),
        '  dir          packages/a',
        '  command      true',
        '  interactive  no',
        '',
      ].join('\n'),
    ])
  })
})
