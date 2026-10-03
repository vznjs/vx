// A `dependsOn` `projects` list matches directories too, as Nx's
// `findMatchingProjects` does: the mapper hands each node's root to the
// matcher, or `libs/*` named no project and the edge was dropped.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-deps-projects-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a directory pattern in `projects` reaches the projects under it', async () => {
  const at = { app: 'apps/app', ui: 'libs/ui', util: 'libs/util' } as const
  const metas: ProjectMeta[] = []
  for (const [name, rel] of Object.entries(at)) {
    const dir = path.join(root, rel)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
    metas.push({ name, dir, packageJson: { name } as never, configPath: null })
  }
  const nodes = Object.fromEntries(
    Object.entries(at).map(([name, rel]) => [
      name,
      {
        name,
        data: {
          root: rel,
          targets:
            name === 'app'
              ? { gen: { command: 'g', dependsOn: [{ target: 'gen', projects: ['libs/*'] }] } }
              : { gen: { command: 'g' } },
        },
      },
    ]),
  )
  const m = await mapNxWorkspace(root, metas, { nodes, dependencies: {} } as NxGraph, {
    cacheable: new Set(),
  })
  const app = m.projects.find((p) => p.name === 'app')!.tasks.find((t) => t.name === 'gen')!
  expect([app.task!['dependsOn'], app.todos]).toEqual([['ui#gen', 'util#gen'], []])
})
