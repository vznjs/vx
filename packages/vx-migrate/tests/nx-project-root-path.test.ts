// An Nx output or input of exactly `{projectRoot}` (or `{projectRoot}/`) is
// the project's whole tree: Nx reads a path with no pattern as that path or
// everything under it (`path_or_everything_under`) and `dir/` as `dir/**`.
// The first mapped to the workspace literal `packages/a`, the second to the
// empty path, which core drops: a hit restored nothing, a key read nothing.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-project-root-path-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function mapped(target: Record<string, unknown>): Promise<unknown> {
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), '{"name":"a"}')
  const meta: PackageMeta = {
    name: 'a',
    dir,
    packageJson: { name: 'a' } as never,
    configPath: null,
  }
  const nodes = {
    a: {
      name: 'a',
      data: { root: 'packages/a', targets: { gen: { command: 'g', cache: true, ...target } } },
    },
  }
  const m = await mapNxWorkspace(root, [meta], { nodes, dependencies: {} } as NxGraph, {
    cacheable: new Set(),
    tracked: () => ({
      files: ['src/a.ts'],
      exts: new Set(['ts']),
      dirs: new Set(['src']),
      tops: new Set(['src', 'package.json']),
    }),
  })
  const t = m.projects[0]!.tasks.find((x) => x.name === 'gen')!
  return { task: t.task, todos: t.todos }
}

it('an output of the project dir is its whole tree', async () => {
  const tree = await mapped({ outputs: ['{projectRoot}/**'] })
  const files = (tree as { task: { cache: { outputs: { files: string[] } } } }).task.cache.outputs
    .files
  expect(files.slice(0, 2)).toEqual(['**', '!package.json'])
  for (const o of ['{projectRoot}', '{projectRoot}/', 'packages/a', 'packages/a/'])
    expect(await mapped({ outputs: [o] })).toEqual(tree)
})

it('an input of the project dir is its whole tree', async () => {
  const tree = await mapped({ inputs: ['{projectRoot}/**/*'], outputs: [] })
  expect((tree as { task: { inputs: { files: string[] } } }).task.inputs.files).toEqual(['**/*'])
  for (const i of ['{projectRoot}', '{projectRoot}/'])
    expect(await mapped({ inputs: [i], outputs: [] })).toEqual(tree)
})
