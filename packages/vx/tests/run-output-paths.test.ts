// Where `vx run` writes the file a flag names, end to end: the output path
// makes its directory (item 993).

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
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
  const r = Bun.spawnSync([process.execPath, BIN, 'run', 'build', '--all', ...args], {
    cwd: root,
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
