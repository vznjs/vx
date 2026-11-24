// A task whose command changed is a new task to history (taskDefinition):
// `vx last` reads its timings as the run and `--dry` do, never the old
// command's.
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root: string
const vx = (...args: string[]) => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const config = (command: string) => `export default { tasks: {
  work: { exec: { command: ${JSON.stringify(command)} } },
} }
`

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-last-definition-' })
  await addProject(root, 'a', config('sleep 0.6'))
  expect(vx('run', 'a#work').code).toBe(0)
  expect(vx('run', 'a#work').code).toBe(0)
  await addProject(
    root,
    'b',
    `export default { tasks: {
  moved: { exec: { command: 'true' } },
  gone: { exec: { command: 'true' } },
} }
`,
  )
  expect(vx('run', 'b#moved', 'b#gone').code).toBe(0)
  await writeFile(
    path.join(root, 'packages', 'b', 'vx.config.mjs'),
    `export default { tasks: {
  moved: { exec: { command: 'echo moved' } },
} }
`,
  )
  await writeFile(path.join(root, 'packages', 'a', 'vx.config.mjs'), config('true'))
  expect(vx('run', 'a#work').code).toBe(0)
}, 60_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it("--stats reads the task's timings of its command now, as --dry does", () => {
  const stats = JSON.parse(vx('last', '--stats', 'a#work', '--format', 'json').out) as {
    stats: { taskId: string; runs: number; p50DurationMs: number }[]
  }
  const dry = JSON.parse(vx('run', 'a#work', '--dry', '--format', 'json').out) as {
    tasks: { p50Ms?: number }[]
  }
  const [row] = stats.stats
  // The two `sleep 0.6` runs are another task's: one run, not three.
  expect(row?.runs).toBe(1)
  expect(row?.p50DurationMs).toBe(dry.tasks[0]!.p50Ms!)
})

it("the replay's ±usual knows no usual for a command timed only by this run", () => {
  const r = vx('last')
  expect(r.code).toBe(0)
  expect(r.out).toMatch(/^ {12}success no-cache +— +\d\S* .* a#work$/m)
})

it('--stats of a task with runs only of another definition says so, not that none ran', () => {
  expect([vx('last', '--stats', 'b#moved'), vx('last', '--stats', 'b#gone')]).toEqual([
    {
      code: 1,
      out: '',
      err: '✗ vx last  b#moved has no run since its command or env.define changed; the last 50 runs hold 1 of the old one\n',
    },
    {
      code: 1,
      out: '',
      err: '✗ vx last  b#gone is no task now (removed or renamed); the last 50 runs hold 1 of it\n',
    },
  ])
})
