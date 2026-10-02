// A task's env, stated once in the root turbo.json, was written inline in
// every package's config: vercel/ai's 63 `build` names twice in each of
// ~100 files. A list two or more configs share is one preset export.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-env-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function plan() {
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({
      globalEnv: ['G'],
      tasks: {
        build: { env: ['A', 'B', 'C'], passThroughEnv: ['P'], outputs: [] },
        test: { env: ['X', 'Y'], outputs: [] },
      },
    }),
  )
  const metas: ProjectMeta[] = []
  for (const name of ['a', 'b', 'c']) {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    const scripts = { build: 'tsc', test: 'vitest' }
    metas.push({ name, dir, packageJson: { name, scripts } as never, configPath: null })
  }
  await writeFile(
    path.join(root, 'packages', 'c', 'turbo.json'),
    JSON.stringify({ extends: ['//'], tasks: { build: { env: ['D', 'E', 'F'] } } }),
  )
  return migrateTurbo(root, metas)
}

describe('migrateTurbo: a task env several configs share', () => {
  it('is one preset export, spread where the names stood; a list of its own stays inline', async () => {
    const p = await plan()
    const env = (name: string) => {
      const task = p.projects.find((x) => x.name === name)!.tasks.find((t) => t.name === 'build')!
        .task as {
        cache: { inputs: { env: unknown[] } }
        exec: { env: { passThrough: unknown[] } }
      }
      return [task.cache.inputs.env, task.exec.env.passThrough]
    }
    const preset = p.extraFiles.find((f) => f.relPath === 'vx-preset.ts')!.contents
    expect({
      exports: preset.split('\n').filter((l) => l.startsWith('export const')),
      a: env('a'),
      c: env('c'),
      imports: p.projects.map((x) => x.importLines),
    }).toEqual({
      exports: ["export const globalEnvInputs = ['G']", "export const buildEnv = ['A', 'B', 'C']"],
      a: [
        [{ raw: '...globalEnvInputs' }, { raw: '...buildEnv' }],
        [{ raw: '...globalEnvInputs' }, { raw: '...buildEnv' }, 'P'],
      ],
      c: [
        [{ raw: '...globalEnvInputs' }, 'D', 'E', 'F'],
        [{ raw: '...globalEnvInputs' }, 'D', 'E', 'F', 'P'],
      ],
      imports: [
        ["import { buildEnv, globalEnvInputs } from '../../vx-preset.js'"],
        ["import { buildEnv, globalEnvInputs } from '../../vx-preset.js'"],
        ["import { globalEnvInputs } from '../../vx-preset.js'"],
      ],
    })
  })
})
