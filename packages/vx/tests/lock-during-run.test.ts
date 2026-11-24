// `vx lock` beside a running `vx run`: the lock does not wait for the run,
// and the run keeps the lock it read at its start, so a task it starts after
// the new lock landed runs, and is saved under, the config it was keyed on.
// The next run reads the new lock and misses.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const LOCKED = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

let root: string
const config = (word: string) => `export default { tasks: {
  slow: { exec: { command: 'echo $$ > pid.txt; sleep 2' } },
  build: {
    dependsOn: ['slow'],
    exec: { command: 'echo ${word} > out.txt' },
    inputs: { files: ['vx.config.mjs'] }, outputs: { files: ['out.txt'] }, cache: true,
  },
} }
`

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-lock-during-run-' })
  await addProject(root, 'a', config('old'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a vx lock during a run does not wait for it, and the run keeps the lock it read', async () => {
  const dir = path.join(root, 'packages', 'a')
  const run = Bun.spawn([process.execPath, LOCKED, 'run', 'a#build'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const pid = path.join(dir, 'pid.txt')
  for (let i = 0; i < 200 && !(await Bun.file(pid).exists()); i++) await Bun.sleep(50)
  await Bun.write(path.join(dir, 'vx.config.mjs'), config('new'))
  const lock = Bun.spawn([process.execPath, BIN, 'lock'], { cwd: root, stderr: 'pipe' })
  expect(await lock.exited).toBe(0)
  // Written while the run still holds its run lock: it did not wait.
  expect(run.exitCode).toBeNull()
  expect(await run.exited).toBe(0)
  expect(await Bun.file(path.join(dir, 'out.txt')).text()).toBe('old\n')
  const next = Bun.spawnSync([process.execPath, BIN, 'run', 'a#build'], { cwd: root })
  expect(next.exitCode).toBe(0)
  expect(await Bun.file(path.join(dir, 'out.txt')).text()).toBe('new\n')
}, 30_000)
