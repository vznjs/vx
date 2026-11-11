// An input inside the target's own output (`{projectRoot}/gen/**` beside
// output `{projectRoot}/gen`, not gitignored) was kept, and core refused
// the whole `vx lock`: vx cleans a task's outputs before it runs, so it
// would delete what it reads. Nx runs it, hashing the last run's files.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'
import { trackedKinds } from '../src/tracked-outputs.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-own-out-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function build(outputs: string[]) {
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  const dir = path.join(root, 'libs', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), '{"name":"a"}')
  const meta: PackageMeta = {
    name: 'a',
    dir,
    packageJson: { name: 'a' } as never,
    configPath: null,
  }
  const targets = {
    build: {
      command: 'cp src/f.txt gen/f.txt',
      cache: true,
      inputs: ['{projectRoot}/src/**', '{projectRoot}/gen/**'],
      outputs,
    },
  }
  const m = await mapNxWorkspace(
    root,
    [meta],
    { nodes: { a: { data: { root: 'libs/a', targets } } }, dependencies: {} } as NxGraph,
    { cacheable: new Set<string>(), tracked: trackedKinds(['libs/a/package.json']) },
  )
  const t = m.projects[0]!.tasks.find((x) => x.name === 'build')!
  return { files: (t.task!['inputs'] as { files: unknown }).files, todos: t.todos }
}

it('an input inside the task’s own output is dropped with a todo', async () => {
  const { files, todos } = await build(['{projectRoot}/gen'])
  expect(files).toEqual(['src/**'])
  expect(todos).toContainEqual(expect.stringContaining('"{projectRoot}/gen/**"'))
})

it('an output that takes the input back keeps it', async () => {
  const { files } = await build(['{projectRoot}/gen', '!{projectRoot}/gen/keep'])
  expect(files).toEqual(['src/**', 'gen/**'])
})
