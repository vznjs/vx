// `--affected` reaches a task through a dependency only when its key folds
// that dependency. `inputs.tasks: []` (or a filter leaving the dep out) keeps
// the upstream hash out of the key, yet a change in lib selected app#test
// behind `^build` all the same: a run it could not move (nx task-level
// affected leaves it out).
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { writeEdges } from './helpers/plugin.js'
import { addProject, gitIn, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const app = (folds: string) => `export default { tasks: {
  build: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true },
  lint: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true },
  test: {
    dependsOn: ['^build', 'lint'],
    exec: { command: 'true' }, inputs: { files: ['src/**']${folds} }, outputs: { files: [] }, cache: true,
  },
} }
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
const appTestAffected = (): boolean =>
  (
    JSON.parse(vx('run', 'test', '--all', '--affected=HEAD~1', '--dry=json')) as {
      tasks: Array<{ id: string }>
    }
  ).tasks.some((t) => t.id === 'app#test')

const setUp = async (tasks: string): Promise<void> => {
  root = await makeWorkspace({ prefix: 'vx-affected-key-deps-', git: false })
  await addProject(root, 'lib', { config: app(''), files: { 'src/a.js': 'export {}\n' } })
  await addProject(root, 'app', {
    config: app(tasks),
    files: { 'src/a.js': 'export {}\n' },
  })
  await writeEdges(root, { app: ['lib'] })
  vx('lock')
  gitInitCommit(root)
  await writeFile(path.join(root, 'packages/lib/src/a.js'), 'export const a = 1\n')
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-qm', 'lib')
}
afterEach(() => rm(root, { recursive: true, force: true }))

it('a change upstream leaves out a task whose key folds no upstream', async () => {
  await setUp(', tasks: []')
  expect(appTestAffected()).toBe(false)
}, 30_000)

it('a filter that keeps only a same-project dep leaves it out too', async () => {
  await setUp(", tasks: ['lint']")
  expect(appTestAffected()).toBe(false)
}, 30_000)

it('CONTROL: a key that folds the dependency is reached through it', async () => {
  await setUp('')
  expect(appTestAffected()).toBe(true)
}, 30_000)
