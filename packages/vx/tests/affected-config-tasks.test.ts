// `--affected` after a config edit selects only the tasks whose locked config
// moved. The config file re-keyed every task of its project, so changing
// one task's command re-ran its siblings too. The lock holds each task's
// final config: diffed at the base and now, the tasks whose entry is the same
// are unchanged by the edit. A project-level field or a task added or removed
// still reaches the whole project.
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { addProject, gitIn, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const config = (build: string, more = '') => `export default {
  tasks: {
    build: { exec: { command: '${build}' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true },
    test: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true },${more}
  },
}
`
let root = ''
const vx = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', CI: '' },
  })
  if (p.exitCode !== 0) throw new Error(`vx ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString()
}
const kept = (): Record<string, unknown> => {
  const plan = JSON.parse(
    vx('run', 'build', 'test', '--affected=HEAD', '--dry', '--format', 'json'),
  ) as {
    tasks: Array<{ id: string; affected?: unknown }>
  }
  return Object.fromEntries(plan.tasks.map((t) => [t.id, t.affected]))
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-affected-config-', git: false })
  await addProject(root, 'app', { config: config('true'), files: { 'src/a.js': 'export {}\n' } })
  await addProject(root, 'other', { config: config('true'), files: { 'src/a.js': 'export {}\n' } })
  vx('lock')
  gitInitCommit(root)
})
afterEach(() => rm(root, { recursive: true, force: true }))

const edit = async (source: string): Promise<void> => {
  await writeFile(path.join(root, 'packages/app/vx.config.mjs'), source)
  vx('lock')
}

it('one task’s command edited selects that task alone', async () => {
  await edit(config('echo built'))
  expect(kept()).toEqual({
    'app#build': { kind: 'input', file: 'packages/app/vx.config.mjs' },
  })
})

it('an edit that leaves every locked task the same selects none', async () => {
  await edit(`// a comment\n${config('true')}`)
  expect(kept()).toEqual({})
})

it('a task added still reaches the whole project', async () => {
  await edit(config('true', "\n    lint: { exec: { command: 'true' } },"))
  expect(Object.keys(kept()).sort()).toEqual(['app#build', 'app#test'])
})

it('CONTROL: committed, the same diff against the parent', async () => {
  await edit(config('echo built'))
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-qm', 'edit')
  const plan = JSON.parse(
    vx('run', 'build', 'test', '--affected=HEAD~1', '--dry', '--format', 'json'),
  ) as {
    tasks: Array<{ id: string }>
  }
  expect(plan.tasks.map((t) => t.id)).toEqual(['app#build'])
})

it('a group whose edges moved selects nothing itself: it runs nothing', async () => {
  const git = gitIn(root)
  await edit(config('true', "\n    ci: { dependsOn: ['build'] },"))
  git('add', '-A')
  git('commit', '-qm', 'ci')
  await edit(config('true', "\n    ci: { dependsOn: ['build', 'test'] },"))
  const plan = JSON.parse(vx('run', 'ci', '--affected=HEAD', '--dry', '--format', 'json')) as {
    tasks: Array<{ id: string }>
  }
  expect(plan.tasks.map((t) => t.id)).toEqual([])
})
