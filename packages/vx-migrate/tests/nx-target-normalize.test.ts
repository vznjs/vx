// A target with neither an executor nor a command is what Nx's own
// normalization makes it (P2-31): `nx:noop` when it has dependencies (the
// `build-deps` the TypeScript plugin adds), dropped when it has none. A
// graph that skipped it wrote a failing placeholder.

import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'

describe('a target with neither executor nor command', () => {
  it('is a group when it has dependencies, and nothing when it has none', async () => {
    const graph = {
      nodes: {
        a: {
          name: 'a',
          data: {
            root: 'libs/a',
            targets: {
              build: { command: 'tsc -b' },
              'build-deps': { dependsOn: ['^build'] },
              empty: { options: { x: 1 } },
            },
          },
        },
      },
      dependencies: { a: [] },
    }
    const meta: ProjectMeta = {
      name: 'a',
      dir: '/w/libs/a',
      packageJson: { name: 'a' },
      configPath: null,
    }
    const mapped = await mapNxWorkspace('/w', [meta], parseNxGraph(JSON.stringify(graph), 'g'), {
      cacheable: new Set(),
      migration: true,
    })
    const tasks = Object.fromEntries(mapped.projects[0]!.tasks.map((t) => [t.name, t]))
    expect(Object.keys(tasks).sort()).toEqual(['build', 'build-deps'])
    expect(tasks['build-deps']!.task).toEqual({ dependsOn: ['^build'] })
    expect(tasks['build-deps']!.todos).toEqual([])
  })
})
