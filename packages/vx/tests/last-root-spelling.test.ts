// `//#task` is the root project's task (D-39): `vx run`, `vx show` and
// `vx why` read it so, but `vx last --log //#fmt` and `--stats //#fmt`
// answered "no recorded run of //#fmt" for a task that had just run.
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root: string
const vx = (...args: string[]) => {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: root })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-last-root-', rootName: 'top' })
  await writeFile(
    path.join(root, 'vx.config.mjs'),
    `export default { tasks: { fmt: { exec: { command: 'echo formatted; exit 2' } } } }\n`,
  )
  expect(vx('run', '//#fmt').code).toBe(1)
}, 30_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('--log reads //#task as the root project’s task', () => {
  const log = (target: string) =>
    JSON.parse(vx('last', '--log', target, '--format', 'json').out) as {
      taskId: string
      output: string
    }
  expect(log('//#fmt')).toEqual(log('top#fmt'))
  expect(log('//#fmt').taskId).toBe('top#fmt')
})

it('--stats reads //#task as the root project’s task', () => {
  const stats = (target: string) =>
    (
      JSON.parse(vx('last', '--stats', target, '--format', 'json').out) as {
        stats: { taskId: string }[]
      }
    ).stats.map((s) => s.taskId)
  expect(stats('//#fmt')).toEqual(['top#fmt'])
})
