// Turbo caches the outputs a run wrote; vx fails a task that writes none of
// its outputs. Turbo's `test.outputs ["coverage/**"]` is written only with
// coverage on: where an earlier coverage run left `coverage/` in every
// package, the migration said nothing and `vitest run` failed under vx.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-coverage-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function todos(test: string): Promise<string[]> {
  const dir = path.join(root, 'packages', 'a')
  await mkdir(path.join(dir, 'coverage'), { recursive: true })
  await writeFile(path.join(dir, 'coverage', 'index.html'), '')
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({ tasks: { test: { outputs: ['coverage/**'] } } }),
  )
  const packageJson = { name: 'a', scripts: { test } } as never
  const plan = await migrateTurbo(root, [{ name: 'a', dir, packageJson, configPath: null }])
  return plan.projects[0]!.tasks.find((t) => t.name === 'test')!.todos
}

it('names a coverage output its command may not write', async () => {
  expect(await todos('vitest run')).toEqual([
    "Turbo treats outputs as optional; vx fails a task that writes none of its declared outputs: drop `coverage/**` from test's outputs or run it with coverage",
  ])
})

it('says nothing where the command turns coverage on', async () => {
  expect(await todos('vitest run --coverage')).toEqual([])
})
