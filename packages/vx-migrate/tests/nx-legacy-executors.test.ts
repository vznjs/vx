// Nx 15–16's `@nrwl/workspace:` / `@nx/workspace:` run-commands and
// run-script are `nx:`'s (P2-20): the migration wrote each as a failing
// placeholder, and `nx()` ran them through nx-exec. Each maps exactly as
// its `nx:` twin does.

import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'

const rc = { commands: ['tsc', 'node x.js'], cwd: 'libs/a', parallel: false }
const rs = { script: 'build' }
const targets = {
  rc: { executor: 'nx:run-commands', options: rc },
  'rc-nrwl': { executor: '@nrwl/workspace:run-commands', options: rc },
  'rc-nx': { executor: '@nx/workspace:run-commands', options: rc },
  rs: { executor: 'nx:run-script', options: rs },
  'rs-nrwl': { executor: '@nrwl/workspace:run-script', options: rs },
  'rs-nx': { executor: '@nx/workspace:run-script', options: rs },
}
const graph = { nodes: { a: { name: 'a', data: { root: 'libs/a', targets } } }, dependencies: {} }

const meta: ProjectMeta = {
  name: 'a',
  dir: '/w/libs/a',
  packageJson: { name: 'a', scripts: { build: 'tsc -b' } } as ProjectMeta['packageJson'],
  configPath: null,
}

describe('legacy run-commands and run-script executors', () => {
  for (const migration of [true, false]) {
    it(`map as their nx: twin (${migration ? 'migration' : 'nx()'})`, async () => {
      const mapped = await mapNxWorkspace('/w', [meta], parseNxGraph(JSON.stringify(graph), 'g'), {
        persistentTodo: 'p',
        cacheable: new Set(),
        migration,
      })
      const exec = Object.fromEntries(
        mapped.projects[0]!.tasks.map((t) => [t.name, t.task!['exec'] as Record<string, unknown>]),
      )
      const command = (name: string) => exec[name]!['command']
      expect(command('rs')).toBe('tsc -b')
      for (const twin of ['rc', 'rs'])
        for (const alias of [`${twin}-nrwl`, `${twin}-nx`])
          expect({ alias, command: command(alias) }).toEqual({ alias, command: command(twin) })
      expect(mapped.projects[0]!.tasks.flatMap((t) => t.todos)).toEqual([])
    })
  }
})
