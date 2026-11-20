// payload: the root depends on @payloadcms/typescript-plugin, so its files
// are a global input glob, and its `prepare` builds it before `vx init`.
// The glob's gitignored `dist/` was named outright in every task's inputs:
// in the plugin's own build that keyed its own output, which core refuses
// (lock not written), and in the others it re-added the `!` that took the
// sibling's output back.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'
import { ownSplice } from './helpers/turbo-own.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vx-turbo-ignored-out-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('a gitignored output directory under a global glob is named in no task', async () => {
  await writeFile(
    path.join(dir, 'turbo.json'),
    JSON.stringify({
      globalDependencies: ['packages/plugin/**'],
      tasks: { build: { dependsOn: ['^build'], outputs: ['./dist/**'] } },
    }),
  )
  const metas: PackageMeta[] = []
  for (const name of ['plugin', 'app']) {
    const pkgDir = path.join(dir, 'packages', name)
    await mkdir(pkgDir, { recursive: true })
    const packageJson = { name, scripts: { build: 'tsc' } } as never
    metas.push({ name, dir: pkgDir, packageJson, configPath: null })
  }
  const m = await mapTurboWorkspace(dir, metas, {
    splice: ownSplice,
    persistentTodo: 'PERSIST',
    ignoredUnder: async () => ['packages/plugin/dist/', 'packages/plugin/tsconfig.tsbuildinfo'],
  })
  const ws = Object.fromEntries(
    m.projects.map((p) => [
      p.name,
      (p.tasks[0]!.task as { inputs: { workspaceFiles: string[] } }).inputs.workspaceFiles,
    ]),
  )
  expect(ws['plugin']).not.toContain('packages/plugin/dist/**')
  expect(ws['app']).not.toContain('packages/plugin/dist/**')
  expect(ws['app']).toContain('!packages/plugin/dist/**')
  expect(ws['app']).toContain('packages/plugin/tsconfig.tsbuildinfo')
})
