// `vx show <task>` claims every field the run reads, yet its block left
// out `exec.interactive` (the task holds the terminal) and
// `exec.env.secret` (names masked whatever they are called) (X-47), and
// later `exec.platforms`, `cache.outputs.clean` and `cache.inputStability`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { gradientRule } from '../src/util/index.js'

// `vx lock`, then `vx show`: show reads the lock.
const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
let root: string | undefined
let root2: string | undefined

afterAll(async () => {
  for (const r of [root, root2]) if (r !== undefined) await rm(r, { recursive: true, force: true })
})

describe('vx show prints every field the run reads', () => {
  it('the pretty block carries each, in the order the run reads them', async () => {
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
    tsc: {
      exec: { command: 'tsc -b', platforms: ['linux-x64', 'darwin-arm64'] },
      inputs: { files: ['src/**'] },
      cache: {
        outputs: { files: ['dist/**'], clean: false },
        inputStability: { strategy: 'mutable', severity: 'error' },
      },
    },
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
    expect([show('a#repl'), show('a#quiet'), show('a#tsc')]).toEqual([
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
      [
        '',
        gradientRule({ enabled: false }, 'a#tsc'),
        '  dir                      packages/a',
        '  command                  tsc -b',
        '  platforms                linux-x64, darwin-arm64',
        '  inputs.files             src/**',
        '  outputs.files            dist/**',
        '  outputs.clean            no',
        '  inputStability.strategy  mutable',
        '  inputStability.severity  error',
        '',
      ].join('\n'),
    ])
  })
})

// `exec.platforms` skips the task on any other machine, `outputs.clean`
// keeps what a miss would remove, and `inputStability` can fail the task:
// each changes what a run does, and the block printed none of them.
describe('vx show prints exec.platforms, outputs.clean and inputStability', () => {
  it('the pretty block carries all three', async () => {
    const ws = (root2 = await mkdtemp(path.join(os.tmpdir(), 'vx-show-exec-')))
    await writeFile(
      path.join(ws, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    await Bun.write(path.join(ws, '.vx/workspace.mjs'), localWorkspaceSource())
    const dir = path.join(ws, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `
export default {
  tasks: {
    tsc: {
      exec: { command: 'tsc -b', platforms: ['darwin-arm64', 'linux-x64'] },
      inputs: { files: ['src/**'] },
      cache: {
        outputs: { files: ['dist/**'], clean: false },
        inputStability: { strategy: 'mutable', severity: 'error' },
      },
    },
  },
}
`,
    )
    const out = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'show', 'a#tsc'],
      cwd: ws,
      env: { ...process.env },
      stdout: 'pipe',
    }).stdout.toString()
    expect(out).toBe(
      [
        '',
        gradientRule({ enabled: false }, 'a#tsc'),
        '  dir                      packages/a',
        '  command                  tsc -b',
        '  platforms                darwin-arm64, linux-x64',
        '  inputs.files             src/**',
        '  outputs.files            dist/**',
        '  outputs.clean            no',
        '  inputStability.strategy  mutable',
        '  inputStability.severity  error',
        '',
      ].join('\n'),
    )
  })
})
