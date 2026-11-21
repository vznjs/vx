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
import { lockedEdges, parseDependenciesLock } from '../src/workspace/dependencies-lock.js'

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

// The project's edges went with it, so selection reads them from the base
// commit's `.vx/dependencies.lock`, which `vx lock` writes.
async function dropLib(lockedAtBase: boolean): Promise<string> {
  const root = await makeWorkspace({ prefix: 'vx-affected-projdel-lock-', edges: { app: ['lib'] } })
  made.push(root)
  for (const name of ['app', 'lib', 'other'])
    await addProject(root, name, { config: config(['src/**']), files: { 'src/x': '1\n' } })
  if (lockedAtBase) await lock(root)
  else await rm(path.join(root, '.vx/dependencies.lock'), { force: true })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  await rm(path.join(root, 'packages/lib'), { recursive: true })
  await lock(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'drop lib')
  return root
}

it('a deleted project selects only the dependants the base dependencies lock records', async () => {
  const root = await dropLib(true)
  const shown = Bun.spawnSync(['git', 'show', 'HEAD~1:.vx/dependencies.lock'], { cwd: root })
  const recorded = parseDependenciesLock(new Uint8Array(shown.stdout))!
  expect(lockedEdges(recorded)[recorded.dirs.indexOf('packages/app')]!.deps).toEqual([
    'packages/lib',
  ])
  const tasks = await dry(root, ['build', '--affected=HEAD~1'])
  expect(tasks.map((t) => t.id)).toEqual(['app#build'])
  expect(tasks[0]!.affected).toMatchObject({ file: 'packages/lib/vx.config.mjs' })
})

it('a deleted project with no dependencies lock at the base selects every project', async () => {
  const root = await dropLib(false)
  const tasks = await dry(root, ['build', '--affected=HEAD~1'])
  expect(tasks.map((t) => t.id).sort()).toEqual(['app#build', 'other#build'])
})

// A changed claimed file: the base side's digests are the ones `vx lock`
// recorded for those bytes, so the claimant digests only the head side.
// `affected` names `other` to prove it was not asked.
it('a claimed file change reads the base digests from the dependencies lock', async () => {
  const root = await makeWorkspace({ prefix: 'vx-affected-recorded-', edges: {} })
  made.push(root)
  const claim = pluginSource(
    'vx-test-deps',
    `{ fingerprint: { files: ['deps.lock'], affected: () => ['other'],
      digests: async (file, ctx) => {
        const text = await Bun.file(ctx.workspaceRoot + '/deps.lock').text()
        return { hash: Bun.hash.xxHash3(text).toString(16).padStart(16, '0'),
          projects: Object.fromEntries(ctx.projects.map((p) =>
            [p.name, text.split('\\n').find((l) => l.startsWith(p.name + ' ')) ?? ''])) }
      } } }`,
  )
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([edgesSource(), claim]),
  )
  await Bun.write(path.join(root, 'deps.lock'), 'app 1\nlib 1\nother 1\n')
  for (const name of ['app', 'lib', 'other'])
    await addProject(root, name, { config: config(['src/**']), files: { 'src/x': '1\n' } })
  await lock(root)
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  await Bun.write(path.join(root, 'deps.lock'), 'app 2\nlib 1\nother 1\n')
  git('commit', '-qam', 'bump app')
  const tasks = await dry(root, ['build', '--affected=HEAD~1'])
  expect(tasks.map((t) => t.id)).toEqual(['app#build'])
})

// `vx lock` rewrites the record on every dependency change; the key folds
// the digests already, so the file itself selects nothing, not the root
// project whose `**` lists it.
it('a rewritten dependencies lock alone selects nothing', async () => {
  const root = await makeWorkspace({ prefix: 'vx-affected-depslock-', edges: {} })
  made.push(root)
  await Bun.write(path.join(root, 'vx.config.mjs'), config(['**']))
  await addProject(root, 'app', { config: config(['src/**']), files: { 'src/x': '1\n' } })
  await lock(root)
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  const file = path.join(root, '.vx/dependencies.lock')
  // The same record, its tail JSON spaced: other bytes, still valid.
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  const tailAt = bytes.length - new DataView(bytes.buffer).getUint32(24, true)
  const tail = new TextEncoder().encode(' ' + new TextDecoder().decode(bytes.subarray(tailAt)))
  const out = new Uint8Array(tailAt + tail.length)
  out.set(bytes.subarray(0, tailAt))
  out.set(tail, tailAt)
  new DataView(out.buffer).setUint32(24, tail.length, true)
  expect(parseDependenciesLock(out)).not.toBeNull()
  await Bun.write(file, out)
  git('commit', '-qam', 'relock')
  const tasks = await dry(root, ['build', '--affected=HEAD~1'])
  expect(tasks.map((t) => t.id)).toEqual([])
})

// The base lock wrote the two alike tasks once, in its pool; the head lock,
// with one project left, writes it inline. The entry is the same.
it('a deleted project leaves the alike task it pooled with unselected', async () => {
  const root = await makeWorkspace({ prefix: 'vx-affected-pooled-', edges: {} })
  made.push(root)
  for (const name of ['a', 'b'])
    await addProject(root, name, { config: config(['src/**']), files: { 'src/x': '1\n' } })
  await lock(root)
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  expect(JSON.parse(git('show', 'HEAD:.vx/projects.lock.jsonl')).pool.task).toHaveLength(1)
  await rm(path.join(root, 'packages/a'), { recursive: true })
  await lock(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'drop a')
  expect(await dry(root, ['build', '--affected=HEAD~1'])).toEqual([])
})

// The base commit's dependencies lock is only read, never written: one a
// newer vx wrote reads as no record, as before. The newer-lock refusal is
// for the working tree's, which `vx lock` would write over; it fired on the
// base and named the working tree's file.
it('a base whose dependencies lock a newer vx wrote is read, not refused', async () => {
  const root = await makeWorkspace({ prefix: 'vx-affected-newer-base-', edges: { p: [] } })
  made.push(root)
  await addProject(root, 'p', { config: config(['src/**']), files: { 'src/x': '1\n' } })
  await addProject(root, 'q', { config: config(['src/**']), files: { 'src/x': '1\n' } })
  await lock(root)
  const file = path.join(root, '.vx', 'dependencies.lock')
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  new DataView(bytes.buffer).setUint32(4, 6, true)
  await Bun.write(file, bytes)
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  // A deleted project's edges are read from the base's lock.
  await rm(path.join(root, 'packages/q'), { recursive: true })
  await Bun.write(path.join(root, 'packages/p/src/x'), '2\n')
  await lock(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'head')
  const tasks = await dry(root, ['build', '--affected=HEAD~1'])
  expect(tasks.map((t) => t.id)).toContain('p#build')
})
