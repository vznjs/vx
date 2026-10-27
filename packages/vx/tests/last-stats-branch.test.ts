// `vx last --stats` reports the p50 a run forecasts: the median of the
// task's last five timings on the run's branch, else on any branch, so an
// agent's numbers match the live estimate (EA for 2026-10-14).
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root: string
const vx = (env: Record<string, string>, ...args: string[]) => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', ...env },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const stats = (env: Record<string, string>, ...args: string[]) =>
  JSON.parse(vx(env, 'last', '--stats', 'a#nap', '--format', 'json', ...args).out) as {
    branch: string | null
    stats: { p50DurationMs: number }[]
  }

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-last-branch-' })
  const dir = await addProject(
    root,
    'a',
    `export default { tasks: { nap: { exec: { command: 'sleep "$(cat nap)"' } } } }\n`,
  )
  await writeFile(path.join(dir, 'nap'), '0.6')
  expect(vx({ VX_RUN_BRANCH: 'slow' }, 'run', 'a#nap').code).toBe(0)
  await writeFile(path.join(dir, 'nap'), '0')
  expect(vx({}, 'run', 'a#nap', '--branch', 'fast').code).toBe(0)
}, 60_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('--branch picks the branch p50 forecasts from, and the JSON names it', () => {
  const slow = stats({}, '--branch', 'slow')
  const fast = stats({}, '--branch=fast')
  expect([slow.branch, fast.branch]).toEqual(['slow', 'fast'])
  expect(slow.stats[0]!.p50DurationMs).toBeGreaterThanOrEqual(600)
  expect(fast.stats[0]!.p50DurationMs).toBeLessThan(600)
})

it('VX_RUN_BRANCH is the default, and the flag beats it', () => {
  expect(stats({ VX_RUN_BRANCH: 'slow' }).stats[0]!.p50DurationMs).toBeGreaterThanOrEqual(600)
  expect(stats({ VX_RUN_BRANCH: 'slow' }, '--branch', 'fast').branch).toBe('fast')
})

it('a branch with no timings forecasts from any branch', () => {
  const r = stats({}, '--branch', 'other')
  expect(r.branch).toBe('other')
  expect(r.stats[0]!.p50DurationMs).toEqual(expect.any(Number))
})

it('--branch needs a name and combines only with --stats', () => {
  expect(vx({}, 'last', '--stats', '--branch').err).toContain('--branch requires a branch name')
  expect(vx({}, 'last', '--branch', 'x').err).toContain('--branch combines only with --stats')
})
