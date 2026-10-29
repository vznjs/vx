// `{ input, projects, dependencies: true }`: Nx 24 hashes the listed
// projects' dependencies' input (`InputDefinition`, "not the projects
// themselves"); Nx 23 read it as this project's `^input`. Mapped as the
// latter alone, a listed project's dependency edit was a hit under Nx 24.
// Both are keyed.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-input-projects-deps-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function meta(name: string): Promise<PackageMeta> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  return { name, dir, packageJson: { name } as never, configPath: null }
}

it('keys the listed projects’ dependencies and this project’s', async () => {
  const names = ['app', 'own-dep', 'lib', 'lib-dep']
  const metas = await Promise.all(names.map(meta))
  const input = { input: 'production', projects: ['lib'], dependencies: true }
  const nodes = Object.fromEntries(
    names.map((n) => [
      n,
      {
        data: {
          root: `packages/${n}`,
          targets:
            n === 'app'
              ? { test: { command: 't', cache: true, inputs: ['{projectRoot}/**/*', input] } }
              : {},
        },
      },
    ]),
  )
  const dependencies = {
    app: [{ source: 'app', target: 'own-dep', type: 'static' }],
    lib: [{ source: 'lib', target: 'lib-dep', type: 'static' }],
  }
  const m = await mapNxWorkspace(root, metas, { nodes, dependencies } as NxGraph, {
    cacheable: new Set(),
  })
  const test = m.projects.find((p) => p.name === 'app')!.tasks.find((t) => t.name === 'test')!
  expect([test.task!['dependsOn'], test.todos]).toEqual([
    ['own-dep#inputs:production', 'lib-dep#inputs:production'],
    [],
  ])
})
