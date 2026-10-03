// A migrated `@nx/js:node` target is `node` on its build's output file
// (P2-6), as Nx's `getFileToRun` names it, with Nx's default inspector;
// and the server it starts is a persistent task even in a graph that does
// not say `continuous`.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'
import { nativeExecutorCommand } from '../src/nx/nx-native.js'

const builds: Record<string, { executor: string; options: Record<string, unknown> }> = {
  'api:build': {
    executor: '@nx/esbuild:esbuild',
    options: { main: 'apps/api/src/main.ts', outputPath: 'dist/apps/api', format: ['cjs'] },
  },
  'api:build-tsc': {
    executor: '@nx/js:tsc',
    options: { main: 'apps/api/src/main.ts', outputPath: 'dist/apps/api' },
  },
  'api:build-named': {
    executor: '@nx/webpack:webpack',
    options: {
      main: 'apps/api/src/main.ts',
      outputPath: 'dist/apps/api',
      outputFileName: 'server.js',
    },
  },
  'api:build-inferred': { executor: 'nx:run-commands', options: { command: 'webpack-cli build' } },
}
const api = {
  projectRel: 'apps/api',
  projectName: 'api',
  targetOptions: (spec: string) => builds[spec]?.options,
  targetExecutor: (spec: string) => builds[spec]?.executor,
}
const todo = (spec: string) =>
  `@nx/js:node rebuilt "${spec}" and restarted on change — vx builds it once, first`

describe('@nx/js:node', () => {
  it('an esbuild cjs build: main.cjs, inspector on by default', () => {
    expect(nativeExecutorCommand('@nx/js:node', { buildTarget: 'api:build' }, api)).toEqual({
      command: 'cd ../.. && node --inspect=localhost:9229 dist/apps/api/main.cjs',
      env: {},
      todos: [todo('api:build')],
      deps: ['api:build'],
    })
  })

  it('a tsc build keeps the main’s directory under the project root', () => {
    expect(
      nativeExecutorCommand(
        '@nx/js:node',
        { buildTarget: 'api:build-tsc', inspect: false, args: ['--port', '3000'], watch: false },
        api,
      ),
    ).toEqual({
      command: 'cd ../.. && node dist/apps/api/src/main.js --port 3000',
      env: {},
      todos: [],
      deps: ['api:build-tsc'],
    })
  })

  it('outputFileName names the file; runtimeArgs and inspect-brk come first', () => {
    expect(
      nativeExecutorCommand(
        '@nx/js:node',
        {
          buildTarget: 'api:build-named',
          inspect: 'inspect-brk',
          port: 9300,
          runtimeArgs: ['--enable-source-maps'],
        },
        api,
      )?.command,
    ).toBe(
      'cd ../.. && node --enable-source-maps --inspect-brk=localhost:9300 dist/apps/api/server.js',
    )
  })

  // Nx's own fallback (P2-28): no outputs to read, so `dist/<projectRoot>/main.js`.
  it('a build target with no outputPath runs Nx’s fallback file', () => {
    expect(
      nativeExecutorCommand('@nx/js:node', { buildTarget: 'api:build-inferred' }, api)?.command,
    ).toBe('cd ../.. && node --inspect=localhost:9229 dist/apps/api/main.js')
  })
})

describe('an @nx/js:node target is persistent', () => {
  it('in a graph with no `continuous`', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-node-'))
    try {
      await writeFile(path.join(root, 'package.json'), '{"name":"root","private":true}')
      const graph = {
        nodes: {
          api: {
            name: 'api',
            data: {
              root: 'apps/api',
              targets: {
                build: builds['api:build'],
                serve: { executor: '@nx/js:node', options: { buildTarget: 'api:build' } },
              },
            },
          },
        },
        dependencies: {},
      }
      const metas: ProjectMeta[] = [
        {
          name: 'api',
          dir: path.join(root, 'apps', 'api'),
          packageJson: { name: 'api' },
          configPath: null,
        },
      ]
      const mapped = await mapNxWorkspace(root, metas, parseNxGraph(JSON.stringify(graph), 'g'), {
        persistentTodo: 'p',
        cacheable: new Set(),
        nativeExecutors: true,
      })
      const serve = mapped.projects[0]!.tasks.find((t) => t.name === 'serve')!
      expect((serve.task!['exec'] as { persistent?: unknown }).persistent).toEqual({})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
