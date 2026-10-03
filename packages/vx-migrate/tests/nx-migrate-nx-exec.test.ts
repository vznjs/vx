// Owner, 2026-10-03: the migrator translates only `nx:run-commands` (and
// its shorthand `command`), `nx:run-script` and `nx:noop`. Every other
// executor runs as itself through this package's `nx-exec` bin, as the
// `nx()` plugin runs it: the per-executor translations (jest, file-server,
// js:node, esbuild, …) are gone, and with them their placeholders.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { migrateNx } from '../src/migrate-nx.js'

const graph = {
  nodes: {
    a: {
      name: 'a',
      data: {
        root: 'libs/a',
        targets: {
          test: { executor: '@nx/jest:jest', options: { jestConfig: 'libs/a/jest.config.ts' } },
          pack: { executor: '@nx/angular:package', options: {} },
          lint: { command: 'eslint .', options: { cwd: 'libs/a' } },
          ci: { executor: 'nx:noop', dependsOn: ['test', 'lint'] },
        },
      },
    },
    web: {
      name: 'web',
      data: {
        root: 'apps/web',
        targets: {
          build: {
            executor: '@nx/vite:build',
            options: { outputPath: 'dist/apps/web' },
            configurations: { production: { mode: 'production' } },
          },
          'serve-static': {
            continuous: true,
            executor: '@nx/web:file-server',
            options: { buildTarget: 'build', spa: true },
          },
          serve: { executor: '@nx/js:node', options: { buildTarget: 'web:build' } },
        },
      },
    },
  },
  dependencies: {},
}

describe('the migration writes every executor as an nx-exec line', () => {
  it('executors are nx-exec; run-commands is its shell line; noop is a group', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-exec-'))
    try {
      await writeFile(path.join(root, 'package.json'), '{"name":"root","private":true}')
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
      const metas: ProjectMeta[] = [
        ['a', 'libs/a'],
        ['web', 'apps/web'],
      ].map(([name, rel]) => ({
        name: name!,
        dir: path.join(root, rel!),
        packageJson: { name: name! },
        configPath: null,
      }))
      const plan = await migrateNx(root, metas, 'ts', path.join(root, 'graph.json'))
      const tasks = Object.fromEntries(
        plan.projects.flatMap((p) => p.tasks.map((t) => [`${p.name}#${t.name}`, t])),
      )
      const exec = (id: string) =>
        tasks[id]!.task!['exec'] as { command: string; persistent?: unknown }
      expect(exec('a#test').command).toBe(
        `nx-exec @nx/jest:jest --project a --target test --options '{"jestConfig":"libs/a/jest.config.ts"}'`,
      )
      expect(exec('a#pack').command).toBe('nx-exec @nx/angular:package --project a --target pack')
      expect(exec('a#lint').command).toBe('eslint .')
      expect(tasks['a#ci']!.task).toEqual({ dependsOn: ['test', 'lint'] })
      expect(exec('web#build:production').command).toBe(
        `nx-exec @nx/vite:build --project web --target build --configuration production --options '{"outputPath":"dist/apps/web","mode":"production"}'`,
      )
      expect(exec('web#serve-static').command).toBe(
        `nx-exec @nx/web:file-server --project web --target serve-static --options '{"buildTarget":"build","spa":true}'`,
      )
      // A known server stays persistent; nx-exec builds what the executor builds.
      expect(exec('web#serve').persistent).toEqual({})
      expect(tasks['web#serve']!.task!['dependsOn']).toBeUndefined()
      // No placeholder and no "no plain command" TODO anywhere.
      for (const t of Object.values(tasks)) {
        expect(JSON.stringify(t.task)).not.toContain('TODO(vx-migrate)')
        expect(t.todos.filter((todo) => todo.includes('no plain command'))).toEqual([])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
