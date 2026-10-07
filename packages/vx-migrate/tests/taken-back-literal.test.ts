// A literal input after an exclusion that covers it: Turbo, Nx and vx all
// subtract an exclusion wherever it sits, so the file was never an input.
// vx refuses the shape at load, and the adapters drop the literal so an
// unchanged repo still runs.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { withoutTakenBack } from '../src/glob-grammar.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

describe('withoutTakenBack', () => {
  it.each([
    [
      ['src/**', '!src/gen/**', 'src/gen/keep.ts'],
      ['src/**', '!src/gen/**'],
    ],
    [
      ['!src/gen', './src/gen/keep.ts', 'src/a.ts'],
      ['!src/gen', 'src/a.ts'],
    ],
    [['package.json', '!*.json'], ['!*.json']],
    // A repeat once, with an exclusion and without (TanStack Query's
    // `eslint.config.js`, from `sharedGlobals` and the target's own).
    [
      ['eslint.config.js', 'tsconfig.json', 'eslint.config.js'],
      ['eslint.config.js', 'tsconfig.json'],
    ],
    [
      ['src/**', '!src/gen/**', 'src/**', '!src/gen/**'],
      ['src/**', '!src/gen/**'],
    ],
    // Controls: a glob, a file the exclusion leaves, no exclusion.
    [
      ['src/**', '!src/gen/**'],
      ['src/**', '!src/gen/**'],
    ],
    [
      ['src/gen/keep.ts', '!src/gen/other.ts'],
      ['src/gen/keep.ts', '!src/gen/other.ts'],
    ],
    [
      ['a.ts', 'b.ts'],
      ['a.ts', 'b.ts'],
    ],
  ])('%j → %j', (list, kept) => {
    expect(withoutTakenBack(list)).toEqual(kept)
  })
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-taken-back-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('turbo(): a task whose literal input an exclusion covers maps without it', async () => {
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({
      tasks: { build: { inputs: ['src/**', '!src/gen/**', 'src/gen/keep.ts'], outputs: [] } },
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
  const m = await mapTurboWorkspace(root, metas, { splice: (_k, v) => v, persistentTodo: 'P' })
  const t = m.projects[0]!.tasks[0]!.task as { cache: { inputs: { files: unknown[] } } }
  expect(t.cache.inputs.files).toEqual(['src/**', '!src/gen/**'])
})
