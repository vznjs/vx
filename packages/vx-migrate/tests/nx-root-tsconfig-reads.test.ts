// Nx hashes the root tsconfig into every task, and the mapping keys it
// where the file exists. nx() keeps its mapping between runs, so whether
// tsconfig.base.json / tsconfig.json exist is one of its reads: an untracked
// new tsconfig.base.json left the git index unchanged, the old mapping
// stood, and every edit to the file replayed a hit (Nx re-ran).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { type Logger } from '@vzn/vx'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-root-tsconfig-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const silent = (): Logger => new Proxy({}, { get: () => () => {} }) as Logger

async function workspace() {
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
  )
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(
    path.join(root, 'packages', 'a', 'package.json'),
    JSON.stringify({ name: 'a', scripts: { build: 'tsc' } }),
  )
  const build = { executor: 'nx:run-script', options: { script: 'build' }, cache: true }
  const nodes = { a: { name: 'a', data: { root: 'packages/a', targets: { build } } } }
  await writeFile(
    path.join(root, 'graph.json'),
    JSON.stringify({ graph: { nodes, dependencies: { a: [] } } }),
  )
  const index = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(
      [`nx({ graph: 'graph.json' })`],
      `import { nx } from ${JSON.stringify(index)}\n`,
    ),
  )
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
  const git = (...cmd: string[]) =>
    Bun.spawnSync({ cmd: ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...cmd], cwd: root })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'i', '--no-verify')
}

const planned = async () =>
  (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!.node.config

it('nx() re-maps when an untracked root tsconfig appears or goes', async () => {
  await workspace()
  const wsFiles = async () => (await planned()).inputs?.workspaceFiles
  expect(await wsFiles()).toBeUndefined()
  await writeFile(path.join(root, 'tsconfig.base.json'), '{}')
  expect(await wsFiles()).toEqual(['tsconfig.base.json'])
  await rm(path.join(root, 'tsconfig.base.json'))
  await writeFile(path.join(root, 'tsconfig.json'), '{}')
  expect(await wsFiles()).toEqual(['tsconfig.json'])
}, 30_000)
