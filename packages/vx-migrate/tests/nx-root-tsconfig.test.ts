// Nx folds the root TypeScript config into every task's hash (its
// TsConfiguration input), so a compilerOptions edit re-runs every test.
// vx-migrate listed it nowhere unless a named input did: an edit to
// `useDefineForClassFields` replayed lerna's passing test (Growth round 2).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-root-tsconfig-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function mapped(): Promise<Record<string, unknown>> {
  const dir = path.join(root, 'packages', 'core')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'core' }))
  const metas: PackageMeta[] = [
    { name: 'core', dir, packageJson: { name: 'core' } as never, configPath: null },
  ]
  const nodes = {
    core: {
      data: {
        root: 'packages/core',
        targets: { test: { command: 'vitest run', cache: true, inputs: ['{projectRoot}/**/*'] } },
      },
    },
  }
  const m = await mapNxWorkspace(root, metas, { nodes, dependencies: {} } as NxGraph, {
    cacheable: new Set(),
  })
  return m.projects[0]!.tasks.find((t) => t.name === 'test')!.task!['inputs'] as Record<
    string,
    unknown
  >
}

it('keys every task on the root tsconfig.base.json, as Nx does', async () => {
  await writeFile(path.join(root, 'tsconfig.base.json'), '{}')
  expect((await mapped())['workspaceFiles']).toEqual(['tsconfig.base.json'])
})

it('falls back to the root tsconfig.json, and keys on none when there is neither', async () => {
  expect((await mapped())['workspaceFiles']).toBeUndefined()
  await writeFile(path.join(root, 'tsconfig.json'), '{}')
  expect((await mapped())['workspaceFiles']).toEqual(['tsconfig.json'])
})
