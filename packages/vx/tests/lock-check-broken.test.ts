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

it('a lock that is not valid JSON is a drift the audit names, in its own shape', async () => {
  const ws = await makeWorkspace({ prefix: 'vx-lock-check-corrupt-' })
  await addProject(ws, 'a', CONFIG)
  await writeFile(path.join(ws, '.vx', 'projects.lock.json'), '{bad')
  const json = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'lock', '--check', '--format', 'json'],
    cwd: ws,
  })
  const pretty = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock', '--check'], cwd: ws })
  await rm(ws, { recursive: true, force: true })
  expect(json.exitCode).toBe(1)
  expect(JSON.parse(json.stdout.toString())).toEqual({
    upToDate: false,
    audited: 1,
    notAudited: 0,
    problems: ['.vx/projects.lock.json is not valid JSON — re-run `vx lock` or delete it'],
  })
  expect(pretty.exitCode).toBe(1)
  expect(pretty.stderr.toString()).toContain(
    '✗ vx lock --check  .vx/projects.lock.json is not valid JSON',
  )
})

it('every config that does not load is named, root-relative, with its frame', async () => {
  const ws = await makeWorkspace({ prefix: 'vx-lock-check-two-broken-' })
  const BAD = `export default { tasks: { b: { bad: 1 } } }\n`
  const a = await addProject(ws, 'a', CONFIG)
  const b = await addProject(ws, 'b', CONFIG)
  await addProject(ws, 'c', CONFIG)
  expect(Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: ws }).exitCode).toBe(0)
  for (const dir of [a, b]) await writeFile(path.join(dir, 'vx.config.mjs'), BAD)
  const json = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'lock', '--check', '--format', 'json'],
    cwd: ws,
  })
  const pretty = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock', '--check'], cwd: ws })
  await rm(ws, { recursive: true, force: true })
  const { problems } = JSON.parse(json.stdout.toString()) as { problems: string[] }
  expect(problems.filter((p) => p.includes('unknown field "bad"'))).toEqual([
    'packages/a/vx.config.mjs: tasks.b has unknown field "bad" (allowed: cache, dependsOn, description, exec, inputs)',
    'packages/b/vx.config.mjs: tasks.b has unknown field "bad" (allowed: cache, dependsOn, description, exec, inputs)',
  ])
  const err = pretty.stderr.toString()
  expect(pretty.exitCode).toBe(1)
  expect(err).toContain('packages/a/vx.config.mjs:1:')
  expect(err).toContain('packages/b/vx.config.mjs:1:')
  expect(err).toContain('> 1 | export default { tasks: { b: { bad: 1 } } }')
  expect(err).not.toContain(ws)
})
