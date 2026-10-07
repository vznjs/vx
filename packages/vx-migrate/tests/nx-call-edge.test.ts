// A run-commands line that opens with `nx <target> <project>` ran Nx
// inside the task (ngrx's `build` runs `nx build-package <project>`, then
// copies files into its output). Under a serial line the call is the
// edge Nx's run order gives it: the target runs first, and the line keeps
// the rest.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'

const rc = (options: Record<string, unknown>) => ({ executor: 'nx:run-commands', options })
const graph = {
  nodes: {
    a: {
      name: 'a',
      data: {
        root: 'libs/a',
        targets: {
          'build-package': { command: 'tsc' },
          build: rc({
            parallel: false,
            commands: [{ command: 'nx build-package a' }, { command: 'cpy LICENSE dist' }],
          }),
          other: rc({ command: 'npx nx run b:build' }),
          only: rc({ commands: ['nx build-package a', 'pnpm nx build b'], parallel: false }),
          // Controls: Nx runs these beside the rest, hands them options, or
          // after a command; `nx build a` names this target; `c` is no project.
          parallel: rc({ commands: ['nx build-package a', 'cpy LICENSE dist'] }),
          forwarded: rc({ command: 'nx build-package a', verbose: true, 'out-dir': 'x' }),
          later: rc({ parallel: false, commands: ['echo hi', 'nx build-package a'] }),
          self: rc({ command: 'nx self a' }),
          missing: rc({ command: 'nx build c' }),
        },
      },
    },
    b: { name: 'b', data: { root: 'libs/b', targets: { build: { command: 'tsc' } } } },
  },
  dependencies: {},
}

async function tasks(): Promise<Record<string, unknown>> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-call-'))
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"root","private":true}')
    const metas: ProjectMeta[] = ['a', 'b'].map((n) => ({
      name: `@s/${n}`,
      dir: path.join(root, 'libs', n),
      packageJson: { name: `@s/${n}` },
      configPath: null,
    }))
    const mapped = await mapNxWorkspace(root, metas, parseNxGraph(JSON.stringify(graph), 'g'), {
      cacheable: new Set(),
      migration: true,
    })
    const a = mapped.projects.find((p) => p.name === '@s/a')!
    return Object.fromEntries(
      a.tasks.map((t) => {
        const task = t.task as { exec: { command: string }; dependsOn?: string[] }
        return [t.name, [task.exec.command, task.dependsOn ?? [], t.todos.length]]
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('a leading nx call in a serial run-commands line', () => {
  it('is a dependency edge; one Nx runs beside, after, or with options stays', async () => {
    const got = await tasks()
    expect(got).toMatchObject({
      build: ['cd ../.. && cpy LICENSE dist', ['build-package'], 0],
      other: ['true', ['@s/b#build'], 0],
      only: ['true', ['build-package', '@s/b#build'], 0],
      parallel: [expect.stringContaining('nx build-package a'), [], 1],
      forwarded: [expect.stringContaining('nx build-package a'), [], 1],
      later: [expect.stringContaining('nx build-package a'), [], 1],
      self: ['cd ../.. && nx self a', [], 1],
      missing: ['cd ../.. && nx build c', [], 1],
    })
  })
})
