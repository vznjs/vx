// Which manager `vx init` reads a package's scripts under (D-96).
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-pm-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const todos = async (packageManager: string): Promise<string[]> => {
  const app = path.join(root, 'packages', 'app')
  await mkdir(app, { recursive: true })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ private: true, packageManager }),
  )
  const scripts = { build: 'tsc', postbuild: 'echo done' }
  const plan = migrateScripts([
    { name: 'app', dir: app, packageJson: { name: 'app', scripts } as never, configPath: null },
  ])
  return plan.projects[0]!.tasks.flatMap((t) => t.todos.filter((d) => !d.startsWith('cache:')))
}

it('an unknown packageManager defers to the lockfile beside it (D-96)', async () => {
  // zod's `nub@0.8.3` beside a pnpm-lock.yaml: "nub ran `postbuild`" was
  // a claim nothing had checked; pnpm's own rule decides.
  await writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  expect(await todos('nub@0.8.3')).toEqual([
    'pnpm ran `postbuild` around this script without being asked; folded into the command in that order',
  ])
  // CONTROL: a known one is read as it says.
  expect(await todos('bun@1.4.2')).toEqual([
    'bun ran `postbuild` around this script without being asked; folded into the command in that order',
  ])
})
