// A script or target named `lint#fix` or `^up` became a task the schema
// refuses (`#` separates a project from its task), so the written config,
// or the one nx() handed the project stage, failed every later command.
// The scripts migrator skips such a name with a todo (item 1033); the
// Vite Task and Nx mappers wrote it, and reported the migration clean.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'
import { mapViteTaskWorkspace } from '../src/vite-task/vite-task-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-adoption-names-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const scripts = { 'lint#fix': 'eslint --fix', '^up': 'x', build: 'tsc' }

async function member(): Promise<PackageMeta> {
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  const packageJson = { name: 'a', scripts }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson))
  return { name: 'a', dir, packageJson: packageJson as never, configPath: null }
}

const shape = (tasks: readonly { name: string; task: unknown; todos: string[] }[]) =>
  Object.fromEntries(tasks.map((t) => [t.name, t.task === null ? t.todos : 'task']))

it('Vite Task: a script name the schema refuses is no task, with a todo', async () => {
  const m = await mapViteTaskWorkspace(root, [await member()])
  expect(shape(m.projects[0]!.tasks)).toEqual({
    'lint#fix': [
      `task "lint#fix" not migrated: its name holds '#', which separates a project from its task — rename it, or add it by hand under another name`,
    ],
    '^up': [
      `task "^up" not migrated: its name starts with '^', which names dependencies' tasks or negates — rename it, or add it by hand under another name`,
    ],
    build: 'task',
  })
})

it('Nx: a target name the schema refuses is no task, with a todo', async () => {
  const meta = await member()
  const targets = Object.fromEntries(
    Object.keys(scripts).map((s) => [s, { executor: 'nx:run-script', options: { script: s } }]),
  )
  const nodes = { a: { data: { root: 'packages/a', targets } } }
  const m = await mapNxWorkspace(root, [meta], { nodes, dependencies: {} } as NxGraph, {
    cacheable: new Set(),
  })
  expect(shape(m.projects[0]!.tasks)).toEqual({
    'lint#fix': [
      `target "lint#fix" not migrated: its name holds '#', which separates a project from its task — rename it, or add it by hand under another name`,
    ],
    '^up': [
      `target "^up" not migrated: its name starts with '^', which names dependencies' tasks or negates — rename it, or add it by hand under another name`,
    ],
    build: 'task',
  })
})
