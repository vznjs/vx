// The migration wrote a root vx-preset that every config imported, carrying
// turbo.json's global block onto every task. A written config now holds
// only what its tasks declare, and each task that lost a global says so.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { GLOBAL_TODO, migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-own-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function plan(globals: Record<string, unknown>) {
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'root', engines: { node: '>=22' } }),
  )
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({
      ...globals,
      tasks: { build: { env: ['A'], outputs: ['dist/**'] }, dev: { cache: false } },
    }),
  )
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  const scripts = { build: 'tsc', dev: 'vite' }
  const metas: PackageMeta[] = [
    { name: 'a', dir, packageJson: { name: 'a', scripts } as never, configPath: null },
  ]
  return migrateTurbo(root, metas)
}

describe('migrateTurbo: no global block', () => {
  it('writes no preset and keys each task on its own fields alone', async () => {
    const p = await plan({
      globalDependencies: ['tsconfig.json', '.env'],
      globalEnv: ['G'],
      globalPassThroughEnv: ['GP'],
    })
    const tasks = p.projects[0]!.tasks
    const build = tasks.find((t) => t.name === 'build')!
    expect({
      extraFiles: p.extraFiles,
      imports: p.projects[0]!.importLines,
      build: build.task,
      todos: tasks.map((t) => [t.name, t.todos.includes(GLOBAL_TODO)]),
      note: p.notes.find((n) => n.startsWith("turbo.json's global block")),
    }).toEqual({
      extraFiles: [],
      imports: [],
      build: {
        exec: { command: 'tsc', env: { passThrough: ['A'] } },
        inputs: { files: ['**/*'], env: ['A'] },
        outputs: { files: ['dist/**'] },
        cache: true,
      },
      todos: [
        ['build', true],
        ['dev', true],
      ],
      note:
        `turbo.json's global block (globalDependencies ["tsconfig.json",".env"], ` +
        'globalEnv ["G"], globalPassThroughEnv ["GP"]) is carried onto no task: list what ' +
        'each task reads in its own inputs and exec.env.passThrough',
    })
  })

  it('names nothing when turbo.json writes no global field', async () => {
    const p = await plan({})
    expect({
      todos: p.projects[0]!.tasks.flatMap((t) => t.todos.filter((x) => x === GLOBAL_TODO)),
      note: p.notes.some((n) => n.startsWith("turbo.json's global block")),
    }).toEqual({ todos: [], note: false })
  })
})
