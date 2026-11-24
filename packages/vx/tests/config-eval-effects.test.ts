// What evaluating a config does, and when: only `vx lock` and
// `vx lock --check` evaluate one, so a file a config writes is written then
// and never by a run or `vx show`; a default export that is a Promise is
// awaited, as top-level await is.
import { existsSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root = ''
const vx = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, BIN, ...args], { cwd: root })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-config-eval-' })
  await addProject(
    root,
    'side',
    `import { writeFileSync } from 'node:fs'
writeFileSync(import.meta.dir + '/side.txt', 'x')
export default { tasks: { build: { exec: { command: 'echo side' } } } }
`,
  )
  await addProject(
    root,
    'later',
    `export default Promise.resolve({ tasks: { build: { exec: { command: 'echo later' } } } })\n`,
  )
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a config runs at vx lock and --check only, and a Promise default is awaited', () => {
  const side = path.join(root, 'packages', 'side', 'side.txt')
  expect(vx('lock').code).toBe(0)
  expect(existsSync(side)).toBe(true)
  rmSync(side)
  const ran = vx('run', 'build', '--all')
  expect(ran.code).toBe(0)
  expect(ran.out).toContain('later')
  expect(vx('show').code).toBe(0)
  expect(existsSync(side)).toBe(false)
  expect(vx('lock', '--check').code).toBe(0)
  expect(existsSync(side)).toBe(true)
}, 60_000)
