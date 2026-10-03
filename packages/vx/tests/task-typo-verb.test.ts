// `vx biuld` is a typo of a task typed where the verb goes, and it read
// "unknown command: biuld" with nothing to try. A word a few edits from a
// task now names the task and its `vx run`; a verb that is as close or
// closer (`vx rnu`) keeps its own hint.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TASKS = `export default { tasks: { build: { exec: { command: 'true' } }, typecheck: { exec: { command: 'true' } } } }`

let root: string
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-task-typo-' })
  await addProject(root, 'app', TASKS)
  await addProject(root, 'lib', TASKS)
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function vx(cwd: string, ...args: string[]): [number, string] {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd })
  return [p.exitCode, p.stderr.toString().split('\n')[0] ?? '']
}

it('a typo of a task names the task and the vx run that runs it', () => {
  expect(vx(root, 'biuld')).toEqual([
    1,
    'vx: unknown command: biuld; did you mean the task `build`? vx run build --all',
  ])
  expect(vx(root, 'typechek', 'lib')).toEqual([
    1,
    'vx: unknown command: typechek; did you mean the task `typecheck`? vx run typecheck --filter lib',
  ])
  expect(vx(path.join(root, 'packages', 'app'), 'buidl')).toEqual([
    1,
    'vx: unknown command: buidl; did you mean the task `build`? vx run build',
  ])
})

it('a closer verb, a far word and a flag keep their own lines (controls)', () => {
  expect(vx(root, 'rnu')).toEqual([
    1,
    'vx: unknown command: rnu. Did you mean run? (see `vx help`)',
  ])
  expect(vx(root, 'deploy')).toEqual([1, 'vx: unknown command: deploy (see `vx help`)'])
  expect(vx(root, '--biuld')[1]).toStartWith('vx: unknown flag: --biuld')
})
