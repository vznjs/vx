// nx() drops an input under another target's output git ignores, as Nx's file
// map skips it. Which outputs git ignores went into the committed lock, and
// git also reads `.git/info/exclude` and `core.excludesFile`, neither
// committed: a lock made where they ignored `gen` refused a fresh clone.
// Only committed `.gitignore` files decide now.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'
import { trackedFiles, trackedKinds } from '../src/tracked-outputs.js'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'vx-nx-ignored-machine-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const git = (...args: string[]) =>
  expect(Bun.spawnSync(['git', ...args], { cwd: root, stderr: 'pipe' }).exitCode).toBe(0)

async function mapped() {
  const dir = path.join(root, 'packages', 'lib')
  const targets = {
    codegen: {
      command: 'gen',
      cache: true,
      inputs: ['{projectRoot}/src/**/*'],
      outputs: ['{projectRoot}/gen'],
    },
    build: {
      command: 'build',
      cache: true,
      inputs: ['{projectRoot}/src/**/*', '{projectRoot}/gen/**/*'],
      outputs: ['{projectRoot}/out'],
      dependsOn: ['codegen'],
    },
  }
  const graph = {
    nodes: { lib: { data: { root: 'packages/lib', targets } } },
    dependencies: { lib: [] },
  } as unknown as NxGraph
  const meta = { name: 'lib', dir, packageJson: { name: 'lib' } as never, configPath: null }
  const tracked = trackedKinds((await trackedFiles(root))!)
  const m = await mapNxWorkspace(root, [meta], graph, { cacheable: new Set(), tracked })
  return JSON.stringify(m.projects.map((p) => p.tasks.map((t) => t.task)))
}

it('maps the same with or without uncommitted ignore rules', async () => {
  await mkdir(path.join(root, 'packages', 'lib', 'src'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'lib', 'package.json'), '{"name":"lib"}')
  await writeFile(path.join(root, 'packages', 'lib', 'src', 'a.ts'), '')
  git('init', '-q')
  git('add', '-A')
  const clone = await mapped()
  expect(clone).toContain('gen/**/*')
  await writeFile(path.join(root, '.git', 'info', 'exclude'), 'gen\n')
  expect(await mapped()).toBe(clone)
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '')
  await writeFile(path.join(root, 'global-ignore'), 'gen\n')
  git('config', 'core.excludesFile', path.join(root, 'global-ignore'))
  expect(await mapped()).toBe(clone)
  // A committed rule still counts, whatever is on disk where it runs.
  await writeFile(path.join(root, 'packages', 'lib', '.gitignore'), 'gen/\n')
  git('add', '-A')
  const ignored = await mapped()
  expect(ignored).not.toContain('gen/**/*')
  await writeFile(path.join(root, 'packages', 'lib', 'gen'), '')
  expect(await mapped()).toBe(ignored)
})
