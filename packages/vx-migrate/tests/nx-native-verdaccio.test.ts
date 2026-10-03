// A migrated `@nx/js:verdaccio` target is the registry Nx forked (P2-18):
// from the workspace root, its config and listen address, the storage
// cleared first, and the npm/yarn registry Nx set while it ran a TODO.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'
import { nativeExecutorCommand } from '../src/nx/nx-native.js'

const root = { projectRel: '.', projectName: 'acme' }
const lib = { projectRel: 'libs/a', projectName: 'a' }
const registry = 'set `npm_config_registry` on the tasks that use it'

describe('@nx/js:verdaccio', () => {
  const rows: Array<[string, Record<string, unknown>, object, string, string[]]> = [
    [
      'the target `setup-verdaccio` writes: config, port, Nx’s default location',
      { port: 4873, config: '.verdaccio/config.yml', storage: 'tmp/local-registry/storage' },
      root,
      'rm -rf tmp/local-registry/storage && VERDACCIO_STORAGE_PATH="$PWD"/tmp/local-registry/storage verdaccio --config .verdaccio/config.yml --listen localhost:4873',
      [
        `@nx/js:verdaccio pointed npm and yarn at the registry (\`--location user\`) while it ran, and reset them after — verdaccio does not; ${registry}`,
      ],
    ],
    [
      'no config: port 4873; a project target cds to the root; location none',
      { location: 'none', listenAddress: '0.0.0.0' },
      lib,
      'cd ../.. && verdaccio --listen 0.0.0.0:4873',
      [],
    ],
    [
      'a config and no port: no --listen; clear false keeps storage; scopes named',
      {
        config: '{workspaceRoot}/.verdaccio/config.yml',
        storage: '{projectRoot}/storage',
        clear: false,
        location: 'project',
        scopes: ['@acme'],
      },
      lib,
      'cd ../.. && VERDACCIO_STORAGE_PATH="$PWD"/libs/a/storage verdaccio --config .verdaccio/config.yml',
      [
        `@nx/js:verdaccio pointed npm and yarn (and scopes @acme) at the registry (\`--location project\`) while it ran, and reset them after — verdaccio does not; ${registry}`,
      ],
    ],
  ]
  for (const [title, options, ctx, command, todos] of rows) {
    it(title, () => {
      expect(
        nativeExecutorCommand(
          '@nx/js:verdaccio',
          options,
          ctx as Parameters<typeof nativeExecutorCommand>[2],
        ),
      ).toEqual({ command, env: { VERDACCIO_HANDLE_KILL_SIGNALS: 'true' }, todos })
    })
  }

  it('the @nrwl scope is the same executor', () => {
    expect(nativeExecutorCommand('@nrwl/js:verdaccio', { location: 'none' }, root)?.command).toBe(
      'verdaccio --listen localhost:4873',
    )
  })

  it('a registry is a server even where the graph says no `continuous`', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-verdaccio-'))
    try {
      await writeFile(path.join(dir, 'package.json'), '{"name":"acme","private":true}')
      const graph = {
        nodes: {
          acme: {
            name: 'acme',
            data: {
              root: '.',
              targets: {
                'local-registry': {
                  executor: '@nx/js:verdaccio',
                  options: { port: 4873, config: '.verdaccio/config.yml', location: 'none' },
                },
              },
            },
          },
        },
        dependencies: {},
      }
      const mapped = await mapNxWorkspace(
        dir,
        [{ name: 'acme', dir, packageJson: { name: 'acme' }, configPath: null }],
        parseNxGraph(JSON.stringify(graph), 'g'),
        { persistentTodo: 'p', cacheable: new Set(), nativeExecutors: true },
      )
      const exec = mapped.projects[0]!.tasks[0]!.task!['exec'] as Record<string, unknown>
      expect(exec['command']).toBe(
        'verdaccio --config .verdaccio/config.yml --listen localhost:4873',
      )
      expect(exec['persistent']).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
