// A project whose own config is deleted is affected, and so is every task
// that depends on it: Nx widens to every project (its "project config
// deleted" rows), Turbo selects the package and its dependants. vx selects
// the dependant and names the deleted file as the reason (Growth's
// affected-config-deleted run, 2026-10-16); a project with no change stays out.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { lock } from './helpers/orchestrator.js'
import { dry } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { edgesSource, pluginSource } from './helpers/plugin.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

const config = (inputs: string[]) => `export default { tasks: { build: {
  exec: { command: 'true' }, dependsOn: ['^build'], inputs: { files: ${JSON.stringify(inputs)} },
} } }`

it('deleting a project config selects its dependants and names the file', async () => {
  const root = await makeWorkspace({ prefix: 'vx-affected-cfgdel-', edges: { app: ['lib'] } })
  made.push(root)
  await addProject(root, 'app', { config: config(['src/**']), files: { 'src/x': '1\n' } })
  await addProject(root, 'lib', {
    config: config(['src/**', 'extra/**']),
    files: { 'src/x': '1\n' },
  })
  await addProject(root, 'other', { config: config(['src/**']), files: { 'src/x': '1\n' } })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  git('rm', '-q', 'packages/lib/vx.config.mjs')
  git('commit', '-q', '-m', 'drop lib config')
  // lib, left with no config, keeps a `^build` placeholder that runs nothing.
  const tasks = await dry(root, ['build', '--affected=HEAD~1'])
  expect(tasks.map((t) => [t.id, t.cacheStatus])).toEqual([
    ['app#build', 'no-cache'],
    ['lib#build', 'group'],
  ])
  expect(tasks[0]!.affected).toEqual({
    kind: 'project',
    file: 'packages/lib/vx.config.mjs',
    via: ['lib#build'],
  })
})

// A deleted project leaves no node to walk from: its dependents' keys lost
// an upstream, and the edge that said so went with it. Selection cannot
// tell which projects held it, so it takes every project, as a workspace
// config edit does.
it('deleting a whole project selects its dependants', async () => {
  const root = await makeWorkspace({ prefix: 'vx-affected-projdel-', edges: { app: ['lib'] } })
  made.push(root)
  await addProject(root, 'app', { config: config(['src/**']), files: { 'src/x': '1\n' } })
  await addProject(root, 'lib', { config: config(['src/**']), files: { 'src/x': '1\n' } })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  await rm(path.join(root, 'packages/lib'), { recursive: true })
  await lock(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'drop lib')
  const tasks = await dry(root, ['build', '--affected=HEAD~1'])
  expect(tasks.map((t) => t.id)).toEqual(['app#build'])
  expect(tasks[0]!.affected).toMatchObject({ file: 'packages/lib/vx.config.mjs' })
})

// The project's edges went with it, so core asks the claimant that keeps
// them: `FingerprintClaim.removed`, with the claimed file as of the base.
const depsClaim = (removed: string) =>
  pluginSource(
    'vx-test-deps',
    `{ fingerprint: { files: ['deps.lock'], affected: () => [], ${removed} } }`,
  )

async function dropLibWith(claim: string): Promise<string> {
  const root = await makeWorkspace({ prefix: 'vx-affected-projdel-claim-', edges: {} })
  made.push(root)
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([edgesSource({ app: ['lib'] }), claim]),
  )
  await Bun.write(path.join(root, 'deps.lock'), 'app -> lib\n')
  for (const name of ['app', 'lib', 'other'])
    await addProject(root, name, { config: config(['src/**']), files: { 'src/x': '1\n' } })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  await rm(path.join(root, 'packages/lib'), { recursive: true })
  await lock(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'drop lib')
  return root
}

it('a deleted project selects only the dependants its claimant names', async () => {
  const root = await dropLibWith(
    depsClaim(
      `removed: (gone) => gone.file === 'deps.lock' && gone.dir === 'packages/lib' &&
        new TextDecoder().decode(gone.before).includes('app -> lib') ? ['app'] : undefined`,
    ),
  )
  const tasks = await dry(root, ['build', '--affected=HEAD~1'])
  expect(tasks.map((t) => t.id)).toEqual(['app#build'])
  expect(tasks[0]!.affected).toMatchObject({ file: 'packages/lib/vx.config.mjs' })
})

it('a deleted project no claimant answers for selects every project', async () => {
  for (const removed of ['', 'removed: () => undefined']) {
    const root = await dropLibWith(depsClaim(removed))
    const tasks = await dry(root, ['build', '--affected=HEAD~1'])
    expect(tasks.map((t) => t.id).sort()).toEqual(['app#build', 'other#build'])
  }
})
