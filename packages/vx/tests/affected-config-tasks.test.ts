// `--affected` after a config edit selects only the tasks whose locked config
// moved. The config file re-keyed every task of its project, so changing
// one task's command re-ran its siblings too. The lock holds each task's
// final config: diffed at the base and now, the tasks whose entry is the same
// are unchanged by the edit. A task added is one moved; a project-level
// field or a task removed still reaches the whole project.
import { mkdir, rm, writeFile } from 'node:fs/promises'
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

// The lock keeps each task's JSON as the config wrote it: reordered tasks
// or keys move every line of the project's lock entry and no locked value.
it('tasks or keys reordered in the config select none', async () => {
  await edit(`export default {
  tasks: {
    test: { cache: true, outputs: { files: [] }, inputs: { files: ['src/**'] }, exec: { command: 'true' } },
    build: { inputs: { files: ['src/**'] }, exec: { command: 'true' }, cache: true, outputs: { files: [] } },
  },
}
`)
  expect(kept()).toEqual({})
})

it('a task added selects itself, not its siblings', async () => {
  await edit(config('true', "\n    lint: { exec: { command: 'true' }, inputs: { files: [] } },"))
  expect(kept()).toEqual({})
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

// Its definition moved, so it is a new task (M, 2026-11-25), and what it
// stands for runs.
it('a group whose edges moved is selected', async () => {
  const git = gitIn(root)
  await edit(config('true', "\n    ci: { dependsOn: ['build'] },"))
  git('add', '-A')
  git('commit', '-qm', 'ci')
  await edit(config('true', "\n    ci: { dependsOn: ['build', 'test'] },"))
  const plan = JSON.parse(vx('run', 'ci', '--affected=HEAD', '--dry', '--format', 'json')) as {
    tasks: Array<{ id: string }>
  }
  expect(plan.tasks.map((t) => t.id).sort()).toEqual(['app#build', 'app#ci', 'app#test'])
})

it('an imported file that moves one task names the lock as that task’s input', async () => {
  // The label read "(every task in its project)" of a change that reached
  // one task: the config did not change, so the lock is the input shown.
  const git = gitIn(root)
  await mkdir(path.join(root, 'shared'))
  await writeFile(path.join(root, 'shared/cmd.mjs'), "export const cmd = 'true'\n")
  await edit(`import { cmd } from '../../shared/cmd.mjs'\n${config("' + cmd + '")}`)
  git('add', '-A')
  git('commit', '-qm', 'import')
  await writeFile(path.join(root, 'shared/cmd.mjs'), "export const cmd = 'echo built'\n")
  vx('lock')
  expect(kept()).toEqual({ 'app#build': { kind: 'input', file: '.vx/projects.lock' } })
  expect(vx('run', 'build', 'test', '--affected=HEAD', '--dry')).toContain(
    'app#build  affected: .vx/projects.lock changed (an input)',
  )
})

// A file two configs import: the lock says per project which tasks moved, so
// an importer whose entry stayed the same is selected for none of its tasks.
// It selected every task of every importer, labelled "its key changed".
const shared = async (cmd: string, other: string): Promise<void> => {
  await writeFile(path.join(root, 'shared/cmd.mjs'), `export const cmd = '${cmd}'\n${other}`)
  vx('lock')
}
const importBoth = async (): Promise<void> => {
  const git = gitIn(root)
  await mkdir(path.join(root, 'shared'))
  await writeFile(path.join(root, 'shared/cmd.mjs'), "export const cmd = 'true'\n")
  const using = `import { cmd } from '../../shared/cmd.mjs'\n${config("' + cmd + '")}`
  await writeFile(path.join(root, 'packages/app/vx.config.mjs'), using)
  await writeFile(
    path.join(root, 'packages/other/vx.config.mjs'),
    `import { cmd as unused } from '../../shared/cmd.mjs'\nvoid unused\n${config('true')}`,
  )
  vx('lock')
  git('add', '-A')
  git('commit', '-qm', 'import')
}

it('an imported file another config also imports moves only the task it changed', async () => {
  await importBoth()
  await shared('echo built', '')
  expect(kept()).toEqual({ 'app#build': { kind: 'input', file: '.vx/projects.lock' } })
})

it('an imported file edited with no locked task moved selects none', async () => {
  await importBoth()
  await shared('true', '// a comment\n')
  expect(kept()).toEqual({})
})
