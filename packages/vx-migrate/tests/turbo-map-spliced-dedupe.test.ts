// A name both a global list and the task's own list carry is listed once.
// The written configs splice the globals as an opaque preset spread, which
// hid them from the dedupe: a migrated config listed the name twice and
// keyed apart from the live `turbo()` run.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-dedupe-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('turbo-map: a global name the task repeats', () => {
  it('is listed once whether the globals are spliced as values or as a spread', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        globalDependencies: ['g.json'],
        globalEnv: ['A'],
        globalPassThroughEnv: ['C'],
        tasks: {
          build: {
            env: ['A', 'B'],
            passThroughEnv: ['C', 'D'],
            inputs: ['src/**', '$TURBO_ROOT$/g.json'],
            outputs: [],
          },
        },
      }),
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    const metas: ProjectMeta[] = [
      {
        name: 'a',
        dir,
        packageJson: { name: 'a', scripts: { build: 'tsc' } } as never,
        configPath: null,
      },
    ]
    const inputsOf = async (splice: (k: string, v: readonly string[]) => readonly unknown[]) => {
      const m = await mapTurboWorkspace(root, metas, { splice, persistentTodo: 'P' })
      const t = m.projects[0]!.tasks[0]!.task as {
        cache: { inputs: { env: unknown[]; workspaceFiles: unknown[] } }
        exec: { env: { passThrough: unknown[] } }
      }
      return [t.cache.inputs.env, t.exec.env.passThrough, t.cache.inputs.workspaceFiles]
    }
    expect([await inputsOf((_k, v) => v), await inputsOf((k) => [{ raw: `...${k}` }])]).toEqual([
      [['A', 'B'], ['A', 'C', 'B', 'D'], ['g.json']],
      [
        [{ raw: '...env' }, 'B'],
        [{ raw: '...env' }, { raw: '...pass' }, 'B', 'D'],
        [{ raw: '...inputs' }],
      ],
    ])
  })
})
