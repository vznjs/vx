// Nx tags a package `npm:public` / `npm:private` itself, and a dependsOn
// may select by them (`projects: "tag:npm:public"`). The mapper matched
// patterns against the tags vx writes, which leave those two out, so the
// edge and its key fold were lost with no todo (nx-upstream.ts, which
// matches the raw tags, kept them: the two disagreed).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-npm-tag-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function meta(name: string): Promise<PackageMeta> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  return { name, dir, packageJson: { name } as never, configPath: null }
}

it('a dependsOn on tag:npm:public reaches the packages Nx tags so, and vx writes no such tag', async () => {
  const metas = [await meta('a'), await meta('b')]
  const m = await mapNxWorkspace(
    root,
    metas,
    {
      nodes: {
        a: {
          data: { root: 'packages/a', tags: ['npm:public'], targets: { build: { command: 'x' } } },
        },
        b: {
          data: {
            root: 'packages/b',
            targets: {
              pack: { command: 'y', dependsOn: [{ projects: 'tag:npm:public', target: 'build' }] },
            },
          },
        },
      },
      dependencies: {},
    } as NxGraph,
    { cacheable: new Set<string>() },
  )
  const project = (n: string) => m.projects.find((p) => p.name === n)!
  expect([
    project('b').tasks.find((t) => t.name === 'pack')!.task!['dependsOn'],
    project('a').tags ?? [],
  ]).toEqual([['a#build'], []])
})
