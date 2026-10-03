// `@nx/js:node` on an inferred build target (a Nest app's `webpack-cli
// build`, no `outputPath`) runs the file Nx's `getFileToRun` names (P2-28):
// the target's first `outputs` entry, glob stripped, then `main.js`. It was
// a failing placeholder, and its build no edge.

import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'
import { nativeExecutorCommand } from '../src/nx/nx-native.js'

const outputs: Record<string, string[]> = {
  'api:build': ['{workspaceRoot}/dist/{projectRoot}'],
  'api:build-ts': ['{projectRoot}/dist/**/*.{js,cjs,mjs}'],
}
const api = {
  projectRel: 'apps/api',
  projectName: 'api',
  targetOptions: () => undefined,
  targetExecutor: () => 'nx:run-commands',
  targetOutputs: (spec: string) => outputs[spec],
}
const todo = (file: string) =>
  `@nx/js:node ran ${file}, Nx's default for a build target with no outputPath, or its .cjs/.mjs twin when missing — check the build's output file`

describe('@nx/js:node on a build target with no output options', () => {
  it('its first output, then main.js; the build is an edge', () => {
    expect(
      nativeExecutorCommand('@nx/js:node', { buildTarget: 'api:build', inspect: false }, api),
    ).toEqual({
      command: 'cd ../.. && node dist/apps/api/main.js',
      env: {},
      todos: [
        todo('dist/apps/api/main.js'),
        '@nx/js:node rebuilt "api:build" and restarted on change — vx builds it once, first',
      ],
      deps: ['api:build'],
    })
  })

  it('a glob output is cut back to its base dir', () => {
    expect(
      nativeExecutorCommand(
        '@nx/js:node',
        { buildTarget: 'api:build-ts', inspect: false, watch: false },
        api,
      ),
    ).toEqual({
      command: 'cd ../.. && node apps/api/dist/main.js',
      env: {},
      todos: [todo('apps/api/dist/main.js')],
      deps: ['api:build-ts'],
    })
  })

  it('the written serve task runs the file and depends on the inferred build', async () => {
    const graph = {
      nodes: {
        api: {
          name: 'api',
          data: {
            root: 'apps/api',
            targets: {
              build: {
                command: 'webpack-cli build',
                options: { cwd: 'apps/api', args: ['--node-env=production'] },
                outputs: ['{workspaceRoot}/dist/{projectRoot}'],
                cache: true,
              },
              serve: {
                continuous: true,
                executor: '@nx/js:node',
                options: { buildTarget: 'api:build', runBuildTargetDependencies: false },
              },
            },
          },
        },
      },
      dependencies: { api: [] },
    }
    const meta: ProjectMeta = {
      name: 'api',
      dir: '/w/apps/api',
      packageJson: { name: 'api' },
      configPath: null,
    }
    const mapped = await mapNxWorkspace('/w', [meta], parseNxGraph(JSON.stringify(graph), 'g'), {
      persistentTodo: 'p',
      cacheable: new Set(),
      nativeExecutors: true,
    })
    const serve = mapped.projects[0]!.tasks.find((t) => t.name === 'serve')!
    expect((serve.task!['exec'] as { command: string }).command).toBe(
      'cd ../.. && node --inspect=localhost:9229 dist/apps/api/main.js',
    )
    expect(serve.task!['dependsOn']).toEqual(['api#build'])
  })
})
