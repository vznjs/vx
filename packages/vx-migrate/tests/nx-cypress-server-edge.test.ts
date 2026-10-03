// `@nx/cypress:cypress` started its `devServerTarget` before testing; the
// migrated e2e task depends on that server (P2-25), and only the URL Nx
// passed as `baseUrl` is left to the cypress config.

import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'
import { nativeExecutorCommand } from '../src/nx/nx-native.js'

const e2e = {
  projectRel: 'apps/web-e2e',
  projectName: 'web-e2e',
  // The server is a plain `command` target: no options, an executor.
  targetOptions: () => undefined,
  targetExecutor: (spec: string) => (spec === 'web:serve' ? 'nx:run-commands' : undefined),
}
const cfg = { cypressConfig: 'apps/web-e2e/cypress.config.ts', devServerTarget: 'web:serve' }
const line = 'cd ../.. && cypress run --project=apps/web-e2e --config-file=cypress.config.ts --e2e'

describe('a cypress dev server', () => {
  it('is an edge; the URL Nx passed as baseUrl is a TODO', () => {
    expect(nativeExecutorCommand('@nx/cypress:cypress', cfg, e2e)).toEqual({
      command: line,
      env: {},
      todos: [
        '@nx/cypress:cypress tested the URL "web:serve" printed as baseUrl — set baseUrl in the cypress config',
      ],
      deps: ['web:serve'],
    })
  })

  it('a baseUrl in the options leaves nothing to do', () => {
    expect(
      nativeExecutorCommand(
        '@nx/cypress:cypress',
        { ...cfg, baseUrl: 'http://localhost:4200' },
        e2e,
      ),
    ).toEqual({
      command: `${line} --config=baseUrl=http://localhost:4200`,
      env: {},
      todos: [],
      deps: ['web:serve'],
    })
  })

  it('skipServe starts nothing, so no edge', () => {
    expect(nativeExecutorCommand('@nx/cypress:cypress', { ...cfg, skipServe: true }, e2e)).toEqual({
      command: line,
      env: {},
      todos: [],
    })
  })

  it('the written e2e task depends on the server task', async () => {
    const graph = {
      nodes: {
        web: {
          name: 'web',
          data: { root: 'apps/web', targets: { serve: { continuous: true, command: 'vite' } } },
        },
        'web-e2e': {
          name: 'web-e2e',
          data: {
            root: 'apps/web-e2e',
            targets: { e2e: { executor: '@nx/cypress:cypress', options: cfg } },
          },
        },
      },
      dependencies: { web: [], 'web-e2e': [] },
    }
    const metas: ProjectMeta[] = ['web', 'web-e2e'].map((n) => ({
      name: n,
      dir: `/w/apps/${n}`,
      packageJson: { name: n },
      configPath: null,
    }))
    const mapped = await mapNxWorkspace('/w', metas, parseNxGraph(JSON.stringify(graph), 'g'), {
      persistentTodo: 'p',
      cacheable: new Set(),
      nativeExecutors: true,
    })
    const task = mapped.projects.find((p) => p.name === 'web-e2e')!.tasks[0]!
    expect(task.task!['dependsOn']).toEqual(['web#serve'])
  })
})
