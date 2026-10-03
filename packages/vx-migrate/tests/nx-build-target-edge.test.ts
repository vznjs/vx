// A server executor Nx built first (`@nx/js:node`, `@nx/vite:preview-server`)
// depends on that build in the migrated config (P2-24): it was a TODO, and
// `node dist/apps/api/main.cjs` failed on a clean checkout.

import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'

const graph = {
  nodes: {
    api: {
      name: 'api',
      data: {
        root: 'apps/api',
        targets: {
          build: {
            executor: '@nx/esbuild:esbuild',
            options: { main: 'apps/api/src/main.ts', outputPath: 'dist/apps/api', format: ['cjs'] },
            configurations: { production: {}, development: { minify: false } },
            defaultConfiguration: 'production',
          },
          serve: {
            continuous: true,
            executor: '@nx/js:node',
            options: { buildTarget: 'api:build' },
          },
          'serve-dev': {
            continuous: true,
            executor: '@nx/js:node',
            options: { buildTarget: 'api:build:development', watch: false },
          },
          'serve-ghost': {
            continuous: true,
            executor: '@nx/js:node',
            options: {
              buildTarget: 'gone:build',
              buildTargetOptions: { outputPath: 'dist/x', main: 'x.ts' },
            },
          },
        },
      },
    },
    web: {
      name: 'web',
      data: {
        root: 'apps/web',
        targets: {
          build: { executor: '@nx/vite:build', options: { outputPath: 'dist/apps/web' } },
          preview: {
            continuous: true,
            executor: '@nx/vite:preview-server',
            options: { buildTarget: 'web:build' },
          },
        },
      },
    },
  },
  dependencies: { api: [], web: [] },
}

const meta = (name: string): ProjectMeta => ({
  name,
  dir: `/w/apps/${name}`,
  packageJson: { name },
  configPath: null,
})

describe('a server executor’s build target', () => {
  it('is an edge, its configuration resolved as Nx resolves it', async () => {
    const mapped = await mapNxWorkspace(
      '/w',
      [meta('api'), meta('web')],
      parseNxGraph(JSON.stringify(graph), 'g'),
      { persistentTodo: 'p', cacheable: new Set(), nativeExecutors: true },
    )
    const tasks = new Map(
      mapped.projects.flatMap((p) =>
        p.tasks.map((t) => [`${p.name}#${t.name}` as string, t] as const),
      ),
    )
    const dependsOn = (id: string) => tasks.get(id)!.task!['dependsOn']
    expect(dependsOn('api#serve')).toEqual(['build'])
    expect(dependsOn('api#serve-dev')).toEqual(['build:development'])
    expect(dependsOn('web#preview')).toEqual(['build'])
    // A build target the graph lacks stays a TODO, with no edge.
    expect(dependsOn('api#serve-ghost')).toBeUndefined()
    expect(tasks.get('api#serve-ghost')!.todos).toEqual([
      '@nx/js:node built "gone:build" first and rebuilt and restarted on change — add its build task to dependsOn',
    ])
    expect(tasks.get('api#serve-dev')!.todos).toEqual([])
  })
})
