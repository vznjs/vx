// Where `vx run` writes the file a flag names, end to end: the output path
// makes its directory (item 993). And where a task itself runs.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 20_000
let root: string

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-output-paths-' })
  await addProject(root, 'a', {
    config: `export default { tasks: { build: { exec: { command: 'echo a' } } } }`,
  })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function vx(...args: string[]): { code: number; err: string } {
  return vxIn(root, ...args)
}

function vxIn(cwd: string, ...args: string[]): { code: number; err: string } {
  const r = Bun.spawnSync([process.execPath, BIN, 'run', 'build', '--all', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, err: r.stderr.toString() }
}

describe('output paths (item 993)', () => {
  it(
    '--profile makes its directory',
    () => {
      expect(vx('--profile=np/p.json').code).toBe(0)
      expect(existsSync(path.join(root, 'np/p.json'))).toBe(true)
    },
    TIMEOUT,
  )
})

// vercel/turborepo#1774: a task's shell starts in its own project, from
// wherever vx was started, never in the caller's cwd.
it(
  'a task runs in its own project, started from inside another',
  async () => {
    const b = await addProject(root, 'b', {
      config: `export default { tasks: { build: { exec: { command: 'pwd -P > where.txt' } } } }`,
    })
    const inA = path.join(root, 'packages', 'a', 'deep')
    await mkdir(inA)
    expect(vxIn(inA)).toEqual({ code: 0, err: '' })
    expect(readFileSync(path.join(b, 'where.txt'), 'utf8')).toBe(`${realpathSync(b)}\n`)
  },
  TIMEOUT,
)
