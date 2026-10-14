// `vx last --stats [<task>]`: per-task numbers over the recent history
// window, the ones the scheduler and `--dry` read, from the terminal.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

let root: string
const vx = (...args: string[]) => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-last-stats-' })
  const config = `const cache = { inputs: { files: ['package.json'] }, outputs: { files: [] } }
export default { tasks: {
  build: { exec: { command: 'echo built' }, cache },
  bad: { exec: { command: 'exit 3' } },
} }
`
  await addProject(root, 'a', config)
  await addProject(root, 'b', config)
  expect(vx('run', 'build', '--all').code).toBe(0)
  expect(vx('run', 'build', '--all').code).toBe(0)
  expect(vx('run', 'a#bad').code).toBe(1)
}, 60_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const row = (taskId: string, over: Record<string, unknown>) => ({
  taskId,
  runs: 2,
  p50DurationMs: expect.any(Number),
  p99DurationMs: expect.any(Number),
  successRate: 1,
  hitRate: 0.5,
  failureMode: 'stable',
  ...over,
})
// What a task used depends on the host (a task lighter than vx shows no
// peak): a number or null, checked apart from the rest.
const unhosted = ({ maxPeakRssBytes, maxCpuParallelism, ...s }: Record<string, unknown>) => {
  for (const v of [maxPeakRssBytes, maxCpuParallelism]) {
    expect(v === null || typeof v === 'number').toBe(true)
  }
  return s
}

it('--stats --format json lists every task in the window, sorted by id', () => {
  const r = vx('last', '--stats', '--format', 'json')
  expect(r.code).toBe(0)
  const out = JSON.parse(r.out) as { window: number; stats: Record<string, unknown>[] }
  expect({ ...out, stats: out.stats.map(unhosted) }).toEqual({
    window: 50,
    stats: [
      row('a#bad', {
        runs: 1,
        p50DurationMs: null,
        p99DurationMs: null,
        successRate: 0,
        hitRate: 0,
      }),
      row('a#build', {}),
      row('b#build', {}),
    ],
  })
})

it('a task id narrows to that task, a task name to it in every project', () => {
  const ids = (target: string) =>
    (
      JSON.parse(vx('last', '--stats', target, '--format', 'json').out) as {
        stats: { taskId: string }[]
      }
    ).stats.map((s) => s.taskId)
  expect([ids('a#build'), ids('build')]).toEqual([['a#build'], ['a#build', 'b#build']])
})

it('the text view is one table, a row per task', () => {
  const r = vx('last', '--stats', 'build')
  expect(r.code).toBe(0)
  const lines = r.out.trimEnd().split('\n')
  expect(lines[0]).toMatch(/^task\s+runs\s+p50\s+p99\s+pass\s+hit\s+failure mode\s+peak rss\s+cpu$/)
  expect(lines.slice(1).map((l) => l.split(/\s+/).slice(0, 2))).toEqual([
    ['a#build', '2'],
    ['b#build', '2'],
  ])
  expect(lines[1]).toContain('100%')
  expect(lines[1]).toContain('50%')
  expect(lines[1]).toContain('stable')
})

it('a task nothing recorded is refused; --stats combines with no run selector', () => {
  expect(vx('last', '--stats', 'a#nope')).toEqual({
    code: 1,
    out: '',
    err: 'vx last: no recorded run of a#nope in the last 50 runs\n',
  })
  expect(vx('last', '--stats', '--list').err).toContain('--stats does not combine')
  expect(vx('last', '--stats', '--failed').err).toContain('--stats does not combine')
  expect(vx('last', '--stats', '--log', 'a#bad').err).toContain('--stats does not combine')
})
