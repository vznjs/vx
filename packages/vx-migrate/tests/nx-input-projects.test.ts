// `{ input, projects }` reads its list as Nx's `findMatchingProjects` does:
// a name, a `*` pattern, `tag:` and `!` exclusions. Looked up as names, a
// `tag:` or pattern reader was a todo and its input left the key.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-input-projects-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function meta(name: string): Promise<ProjectMeta> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  return { name, dir, packageJson: { name } as never, configPath: null }
}

it('a pattern, a tag and an exclusion name the graph’s projects; an unknown name says so', async () => {
  const names = ['app', 'lib-a', 'lib-b', 'shared']
  const metas = await Promise.all(names.map(meta))
  const nodes = Object.fromEntries(
    names.map((n) => [
      n,
      {
        data: {
          root: `packages/${n}`,
          tags: n === 'shared' ? ['scope:shared'] : [],
          targets:
            n === 'app'
              ? {
                  test: {
                    command: 't',
                    cache: true,
                    inputs: [
                      '{projectRoot}/**/*',
                      {
                        input: 'production',
                        projects: ['lib-*', '!lib-b', 'tag:scope:*', 'ghost', 'packages/app'],
                      },
                    ],
                  },
                }
              : {},
        },
      },
    ]),
  )
  const m = await mapNxWorkspace(root, metas, { nodes, dependencies: {} } as NxGraph, {
    persistentTodo: 'PERSIST',
    cacheable: new Set(),
  })
  const test = m.projects.find((p) => p.name === 'app')!.tasks.find((t) => t.name === 'test')!
  expect([test.task!['dependsOn'], test.todos]).toEqual([
    ['lib-a#nx-input:production', 'shared#nx-input:production', 'app#nx-input:production'],
    ['input project "ghost" is not a graph node — map manually'],
  ])
})
