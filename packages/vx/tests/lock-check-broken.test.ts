// `vx lock --check` with one config that no longer loads: it named every
// locked project as having "no vx.config now", the healthy ones too, since
// the broken audit evaluated none. A graph rule's refusal evaluated them
// all, so it hides no other problem.
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CONFIG = `export default { tasks: { build: { exec: { command: 'true' } } } }\n`

let root: string
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-lock-check-broken-' })
  await addProject(root, 'a', CONFIG)
  await addProject(root, 'b', CONFIG)
  expect(Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: root }).exitCode).toBe(0)
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a config that no longer loads is the one problem, not every locked project', async () => {
  await writeFile(path.join(root, 'packages', 'a', 'vx.config.mjs'), 'export default {\n')
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'lock', '--check', '--format', 'json'],
    cwd: root,
  })
  const { problems } = JSON.parse(r.stdout.toString()) as { problems: string[] }
  expect(r.exitCode).toBe(1)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain('packages/a/vx.config.mjs')
})

const T = `{ exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } } }`

it('a graph-rule refusal still names a gone project and a stray review copy', async () => {
  const ws = await makeWorkspace({ prefix: 'vx-lock-check-rule-' })
  const a = await addProject(ws, 'a', CONFIG)
  await addProject(ws, 'c', CONFIG)
  expect(Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: ws }).exitCode).toBe(0)
  await rm(path.join(ws, 'packages', 'c'), { recursive: true, force: true })
  await mkdir(path.join(ws, 'packages', 'e'))
  await writeFile(path.join(ws, 'packages', 'e', 'vx.lock.json'), '{}\n')
  await writeFile(path.join(a, 'vx.config.mjs'), `export default { tasks: { x: ${T}, y: ${T} } }\n`)
  const r = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock', '--check'], cwd: ws })
  const err = r.stderr.toString()
  await rm(ws, { recursive: true, force: true })
  expect(r.exitCode).toBe(1)
  expect(err).toContain('both declare the output')
  expect(err).toContain('the lock holds packages/c')
  expect(err).toContain('packages/e/vx.lock.json has no vx.config beside it')
})
