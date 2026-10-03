// A configuration task's name can be another target's: `vite`'s `build`
// configuration is `vite:build`, which the inferred target `vite:build`
// names (P2-23). The written object kept the last key, and the real build
// became `vite --x`, uncached. The target keeps its name, as Nx resolves
// `a:vite:build` to it, and an edge to the configuration reaches its base.

import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'

const graph = {
  nodes: {
    a: {
      name: 'a',
      data: {
        root: 'libs/a',
        targets: {
          vite: {
            command: 'vite',
            configurations: { build: { args: '--x' }, dev: { args: '--d' } },
          },
          'vite:build': { command: 'vite build', cache: true, outputs: ['{projectRoot}/dist'] },
          deploy: {
            command: 'deploy',
            dependsOn: ['vite'],
            configurations: { build: { args: '--b' } },
          },
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

describe('a configuration task named like another target', () => {
  it('is not written; the target keeps its name, an edge to it reaches the base', async () => {
    const mapped = await mapNxWorkspace('/w', [meta], parseNxGraph(JSON.stringify(graph), 'g'), {
      persistentTodo: 'p',
      cacheable: new Set(),
      nativeExecutors: true,
    })
    const tasks = new Map(mapped.projects[0]!.tasks.map((t) => [t.name, t]))
    expect([...tasks.keys()].sort()).toEqual([
      'deploy',
      'deploy:build',
      'vite',
      'vite:build',
      'vite:dev',
    ])
    const exec = (name: string) => tasks.get(name)!.task!['exec'] as { command: string }
    expect(exec('vite:build').command).toBe('cd ../.. && vite build')
    expect(tasks.get('vite:build')!.task!['cache']).toBeDefined()
    expect(tasks.get('vite')!.todos).toEqual([
      'configuration "build" would be task "vite:build", which another target names — not written; give it a task of its own name',
    ])
    // `deploy:build` asks `vite` for its `build` configuration: that is no task, so the base.
    expect(tasks.get('deploy:build')!.task!['dependsOn']).toEqual(['vite'])
  })
})
