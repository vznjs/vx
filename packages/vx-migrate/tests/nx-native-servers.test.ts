// A migrated Vite dev/preview server and Storybook target are the command
// their Nx executor runs (P2-2), the server reading its `buildTarget`'s
// config file and mode as Nx's executor does, through the graph.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'
import { nativeExecutorCommand } from '../src/nx/nx-native.js'

const build = {
  configFile: 'apps/web/vite.config.ts',
  outputPath: 'dist/apps/web',
  mode: 'staging',
}
const web = {
  projectRel: 'apps/web',
  projectName: 'web',
  targetOptions: (spec: string) => (spec.startsWith('web:build') ? build : undefined),
}
const lib = { projectRel: 'libs/a', projectName: 'a' }

describe('server and Storybook executors', () => {
  const rows: Array<[string, string, Record<string, unknown>, object, string, string[]]> = [
    [
      'vite dev-server: the build target’s config and mode, its own server flags',
      '@nx/vite:dev-server',
      { buildTarget: 'web:build', port: 4200, host: true, hmr: { overlay: false } },
      web,
      'vite --config=vite.config.ts --port=4200 --host --mode=staging',
      [`@nx/vite:dev-server option "hmr" has no vite flag — set it in vite's config`],
    ],
    [
      'vite dev-server: its own mode wins, and proxyConfig is named',
      '@nx/vite:dev-server',
      { buildTarget: 'web:build', mode: 'dev', proxyConfig: 'apps/web/proxy.conf.json' },
      web,
      'vite --config=vite.config.ts --mode=dev',
      ['@nx/vite:dev-server loaded `proxyConfig` as server.proxy — move it into the vite config'],
    ],
    [
      'vite dev-server: a build target the graph lacks is named',
      '@nx/vite:dev-server',
      { buildTarget: 'gone:build' },
      web,
      'vite',
      [
        '@nx/vite:dev-server: buildTarget "gone:build" is not in the graph — its configFile and mode are not read',
      ],
    ],
    [
      'vite preview-server: the build output as --outDir, and the build it ran first',
      '@nx/vite:preview-server',
      { buildTarget: 'web:build:production', port: 4300 },
      web,
      'vite preview --config=vite.config.ts --outDir=../../dist/apps/web --port=4300 --mode=staging',
      [
        '@nx/vite:preview-server rebuilt the app in watch mode while serving — vx builds it once, first',
      ],
    ],
    [
      'vite preview-server: staticFilePath is read from the project dir',
      '@nx/vite:preview-server',
      { buildTarget: 'web:build', staticFilePath: 'out', watch: false, mode: 'x' },
      web,
      'vite preview --config=vite.config.ts --outDir=out --mode=x',
      [],
    ],
    [
      'storybook dev from the workspace root on Nx’s port 9009',
      '@nx/storybook:storybook',
      { configDir: 'libs/a/.storybook', ci: true, uiFramework: '@storybook/react' },
      lib,
      'cd ../.. && storybook dev --port=9009 --config-dir=libs/a/.storybook --ci',
      [],
    ],
    [
      'storybook dev: open false is --no-open, a given port wins',
      '@nx/storybook:storybook',
      { configDir: '{projectRoot}/.storybook', port: 4400, open: false },
      lib,
      'cd ../.. && storybook dev --port=4400 --config-dir=libs/a/.storybook --no-open',
      [],
    ],
    [
      'storybook build into outputDir; an Angular-only option is named',
      '@nx/storybook:build',
      {
        configDir: '{projectRoot}/.storybook',
        outputDir: '{workspaceRoot}/dist/storybook/a',
        styles: ['a.css'],
      },
      lib,
      'cd ../.. && storybook build --config-dir=libs/a/.storybook --output-dir=dist/storybook/a',
      [`@nx/storybook:build option "styles" has no storybook flag — set it in storybook's config`],
    ],
  ]
  for (const [title, executor, options, ctx, command, todos] of rows) {
    it(title, () => {
      expect(
        nativeExecutorCommand(
          executor,
          options,
          ctx as Parameters<typeof nativeExecutorCommand>[2],
        ),
      ).toEqual({
        command,
        env: {},
        todos,
        // A preview server's build target is an edge, as Nx built it first.
        ...(executor === '@nx/vite:preview-server'
          ? { deps: [String(options['buildTarget'])] }
          : {}),
      })
    })
  }
})

describe('a server reads its build target through the graph', () => {
  const graph = {
    nodes: {
      web: {
        name: 'web',
        data: {
          root: 'apps/web',
          targets: {
            build: {
              executor: '@nx/vite:build',
              options: { configFile: 'apps/web/vite.config.ts', outputPath: 'dist/apps/web' },
              configurations: {
                production: { mode: 'production' },
                development: { mode: 'development' },
              },
              defaultConfiguration: 'production',
            },
            serve: {
              executor: '@nx/vite:dev-server',
              options: { buildTarget: 'web:build' },
              configurations: { development: { buildTarget: 'web:build:development' } },
            },
          },
        },
      },
    },
    dependencies: {},
  }

  it('a configuration’s buildTarget reads that configuration, the bare one the default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-servers-'))
    try {
      await writeFile(path.join(root, 'package.json'), '{"name":"root","private":true}')
      const metas: ProjectMeta[] = [
        {
          name: 'web',
          dir: path.join(root, 'apps', 'web'),
          packageJson: { name: 'web' },
          configPath: null,
        },
      ]
      const mapped = await mapNxWorkspace(root, metas, parseNxGraph(JSON.stringify(graph), 'g'), {
        persistentTodo: 'p',
        cacheable: new Set(),
        nativeExecutors: true,
      })
      const command = (name: string) =>
        (
          mapped.projects[0]!.tasks.find((t) => t.name === name)!.task!['exec'] as {
            command: string
          }
        ).command
      expect(command('serve')).toBe('vite --config=vite.config.ts --mode=production')
      expect(command('serve:development')).toBe('vite --config=vite.config.ts --mode=development')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
