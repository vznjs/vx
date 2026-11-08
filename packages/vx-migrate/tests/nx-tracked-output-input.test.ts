// An input under another target's output was dropped: the mapper took
// every output for gitignored, as Nx's file map skips gitignored files.
// A generator that writes into a TRACKED `src` left `build` keyed on no
// file, and a committed source change replayed the old `dist` (stale hit).
// Then an untracked `src` git does not ignore was taken for ignored: Nx's
// file map lists it, so it hashes the input, and the edit replayed.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'
import { trackedKinds } from '../src/tracked-outputs.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-tracked-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function inputsOfBuild(
  tracked: readonly string[] | undefined,
  gitignore = '',
): Promise<unknown> {
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  await writeFile(path.join(root, '.gitignore'), gitignore)
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), '{"name":"a"}')
  const meta: PackageMeta = {
    name: 'a',
    dir,
    packageJson: { name: 'a' } as never,
    configPath: null,
  }
  const targets = {
    gen: { command: 'gen', cache: true, outputs: ['{projectRoot}/src'] },
    build: {
      command: 'tsc',
      cache: true,
      inputs: ['{projectRoot}/src/**/*'],
      outputs: ['{projectRoot}/dist'],
    },
  }
  const m = await mapNxWorkspace(
    root,
    [meta],
    { nodes: { a: { data: { root: 'packages/a', targets } } }, dependencies: {} } as NxGraph,
    {
      cacheable: new Set<string>(),
      ...(tracked === undefined ? {} : { tracked: trackedKinds(tracked) }),
    },
  )
  const build = m.projects[0]!.tasks.find((t) => t.name === 'build')!
  return (build.task!['inputs'] as { files: unknown }).files
}

// Kept, the input meets gen's output in the sibling and tracked passes,
// which leave `build` uncached with a todo rather than keyed on nothing.
it('an input under a tracked or unignored output stays an input; under an ignored one it is dropped', async () => {
  expect(await inputsOfBuild(['packages/a/package.json', 'packages/a/src/i.ts'])).toContain(
    'src/**/*',
  )
  expect(await inputsOfBuild(['packages/a/package.json'])).toContain('src/**/*')
  expect(await inputsOfBuild(['packages/a/package.json'], 'src/\n')).toEqual([])
  expect(await inputsOfBuild(['packages/a/package.json'], 'packages/a/src\n')).toEqual([])
})
