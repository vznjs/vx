// Turbo 2 hashes the files of the packages the root depends on into every
// task; Turbo 1.13.4 does not. On trigger.dev (a `pipeline` turbo.json
// whose root depends on its database package) an edit to a Prisma
// migration re-keyed every vx task, Turbo only the database's dependents.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vx-turbo-v1-root-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function globals(field: 'pipeline' | 'tasks'): Promise<readonly string[]> {
  await writeFile(path.join(dir, 'turbo.json'), JSON.stringify({ [field]: { build: {} } }))
  const db = path.join(dir, 'packages', 'db')
  await mkdir(db, { recursive: true })
  const metas: ProjectMeta[] = [
    {
      name: 'ws',
      dir,
      packageJson: { name: 'ws', dependencies: { db: 'workspace:*' } } as never,
      configPath: null,
    },
    {
      name: 'db',
      dir: db,
      packageJson: { name: 'db', scripts: { build: 'b' } } as never,
      configPath: null,
    },
  ]
  const m = await mapTurboWorkspace(dir, metas, {
    splice: (_k, v) => v,
    persistentTodo: 'PERSIST',
    ignored: async () => new Set(),
  })
  return m.globals.inputs
}

it("keys the root's dependencies under Turbo 2 only", async () => {
  expect({ v1: await globals('pipeline'), v2: await globals('tasks') }).toEqual({
    v1: [],
    v2: ['packages/db/**'],
  })
})
