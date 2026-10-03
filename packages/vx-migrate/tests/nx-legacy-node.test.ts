// Nx 15–16's `@nrwl/node:node` and `@nx/node:node` wrapped `@nx/js:node`
// (the executor forwarded its options to the js one; gone in Nx 17). A
// graph from such a repo kept the old name, and each serve target was a
// failing placeholder. They are `@nx/js:node`: its line, its build edge,
// a server.

import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'

const graphWith = (executor: string) => ({
  nodes: {
    api: {
      name: 'api',
      data: {
        root: 'apps/api',
        targets: {
          build: {
            executor: '@nrwl/js:tsc',
            options: {
              outputPath: 'dist/apps/api',
              main: 'apps/api/src/main.ts',
              tsConfig: 'apps/api/tsconfig.app.json',
            },
          },
          serve: { executor, options: { buildTarget: 'api:build', inspect: false } },
        },
      },
    },
  },
  dependencies: { api: [] },
})
const meta: ProjectMeta = {
  name: 'api',
  dir: '/w/apps/api',
  packageJson: { name: 'api' },
  configPath: null,
}

describe('the Nx 15–16 node executors', () => {
  for (const executor of ['@nrwl/node:node', '@nx/node:node']) {
    it(`${executor} is @nx/js:node`, async () => {
      const mapped = await mapNxWorkspace(
        '/w',
        [meta],
        parseNxGraph(JSON.stringify(graphWith(executor)), 'g'),
        { persistentTodo: 'p', cacheable: new Set(), nativeExecutors: true },
      )
      const serve = mapped.projects[0]!.tasks.find((t) => t.name === 'serve')!
      const exec = serve.task!['exec'] as { command: string; persistent?: unknown }
      expect(exec.command).toBe('cd ../.. && node dist/apps/api/src/main.js')
      expect(exec.persistent).toEqual({})
      // One edge to the build; its spelling moves to the bare name with P2-35.
      expect([['build'], ['api#build']]).toContainEqual(serve.task!['dependsOn'] as string[])
    })
  }
})
