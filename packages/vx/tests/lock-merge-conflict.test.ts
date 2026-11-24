// The locks have no merge driver (M 2026-11-22): git's text merge marks a
// clash, a run refuses it, and `vx lock` rewrites both. A driver runs before
// theirs' configs reach disk, so one running `vx lock` would lock only ours.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { BIN, vxSync } from './helpers/vx.js'
import { readLockfile } from '../src/workspace/index.js'

const config = (cmd: string) =>
  `export default { tasks: { build: { exec: { command: '${cmd}' } } } }\n`

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

const vx = (cwd: string, ...args: string[]) => vxSync(cwd, args, { bin: BIN })

const LOCK = '.vx/projects.lock'

it('registers no merge driver; a clashing merge refuses runs until vx lock rewrites it', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-clash-' }))
  const git = gitIn(r)
  await addProject(r, 'a', config('echo base'))
  expect(vx(r, 'lock').code).toBe(0)
  expect(git('config', '--local', '--list')).not.toContain('merge.vx-lock')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'theirs')
  await addProject(r, 'a', config('echo theirs'))
  expect(vx(r, 'lock').code).toBe(0)
  git('commit', '-qam', 'theirs')
  git('checkout', '-q', '-')
  await addProject(r, 'a', { files: { 'other.txt': 'x' } })
  await Bun.write(path.join(r, 'packages/a/vx.config.mjs'), config('echo ours'))
  expect(vx(r, 'lock').code).toBe(0)
  git('add', '-A')
  git('commit', '-qm', 'ours')
  const merge = Bun.spawnSync({
    cmd: ['git', 'merge', '-q', 'theirs'],
    cwd: r,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(merge.exitCode).not.toBe(0)
  expect(await Bun.file(path.join(r, LOCK)).text()).toContain('<<<<<<<')
  const refused = vx(r, 'run', '--all', 'build')
  expect(refused.code).not.toBe(0)
  expect(refused.err).toContain('vx lock')
  // The config is the user's to settle; then `vx lock` writes both locks whole.
  await Bun.write(path.join(r, 'packages/a/vx.config.mjs'), config('echo merged'))
  expect(vx(r, 'lock').code).toBe(0)
  expect(await Bun.file(path.join(r, LOCK)).text()).not.toContain('<<<<<<<')
  expect(await Bun.file(path.join(r, '.vx/dependencies.lock')).text()).not.toContain('<<<<<<<')
  expect(await Bun.file(path.join(r, LOCK)).text()).toContain('echo merged')
  expect(vx(r, 'run', '--all', 'build').code).toBe(0)
})

it('vx lock --check names a conflicted dependencies lock as a conflict', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-clash-' }))
  await addProject(r, 'a', config('echo a'))
  expect(vx(r, 'lock').code).toBe(0)
  const deps = path.join(r, '.vx/dependencies.lock')
  const text = await Bun.file(deps).text()
  await Bun.write(deps, `<<<<<<< HEAD\n${text}=======\n${text}>>>>>>> theirs\n`)
  const check = vx(r, 'lock', '--check')
  expect(check.code).toBe(1)
  expect(check.err).toContain('.vx/dependencies.lock holds a git merge conflict: run `vx lock`')
})

// Two branches each edited a different project and the merge still
// clashed: every task's JSON sat in one pool at the top, side by side, so
// both branches' pool edits touched. Each project's lines merge alone.
it('git merges two branches that each edit a different project, and the lock checks', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-merge-' }))
  const git = gitIn(r)
  const two = (cmd: string) =>
    `export default { tasks: { build: { exec: { command: '${cmd}' } }, lint: { exec: { command: 'oxlint' } } } }\n`
  await addProject(r, 'a', two('echo a'))
  await addProject(r, 'b', two('echo b'))
  expect(vx(r, 'lock').code).toBe(0)
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'theirs')
  await Bun.write(path.join(r, 'packages/a/vx.config.mjs'), two('echo a2'))
  expect(vx(r, 'lock').code).toBe(0)
  git('commit', '-qam', 'theirs')
  git('checkout', '-q', '-')
  await Bun.write(path.join(r, 'packages/b/vx.config.mjs'), two('echo b2'))
  expect(vx(r, 'lock').code).toBe(0)
  git('commit', '-qam', 'ours')
  const merge = Bun.spawnSync({
    cmd: ['git', 'merge', '-q', '--no-edit', 'theirs'],
    cwd: r,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(`${merge.exitCode} ${merge.stdout.toString()}`).not.toContain('CONFLICT')
  expect(merge.exitCode).toBe(0)
  const check = vx(r, 'lock', '--check')
  expect(`${check.code} ${check.err}`).toBe('0 ')
  const text = await Bun.file(path.join(r, LOCK)).text()
  expect([text.includes('echo a2'), text.includes('echo b2')]).toEqual([true, true])
})

// More two-branch merges, each a real `git merge`: it merges clean to a
// lock `--check` accepts, or a run refuses with "run `vx lock`" and
// `vx lock` settles it. A lock that reads as some other projects is the
// one outcome never allowed.
const tasksConfig = (tasks: Record<string, string>) =>
  `export default {\n  tasks: {\n${Object.entries(tasks)
    .map(([t, c]) => `    ${t}: { exec: { command: '${c}' } },`)
    .join('\n')}\n  },\n}\n`
const configOf = (r: string, p: string) => path.join(r, 'packages', p, 'vx.config.mjs')
type Side = (r: string) => Promise<unknown>

/** Base, then theirs and ours on branches, each locked; then the merge and how it settles. */
async function merged(base: Side, ours: Side, theirs: Side): Promise<'clean' | 'relocked'> {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-merge-' }))
  const git = gitIn(r)
  const step = async (side: Side, msg: string) => {
    await side(r)
    expect(vx(r, 'lock').code).toBe(0)
    git('add', '-A')
    git('commit', '-qm', msg)
  }
  await step(base, 'base')
  git('checkout', '-qb', 'theirs')
  await step(theirs, 'theirs')
  git('checkout', '-q', '-')
  await step(ours, 'ours')
  Bun.spawnSync({ cmd: ['git', 'merge', '-q', '--no-edit', 'theirs'], cwd: r })
  // The configs are the user's to merge; each case edits them apart.
  const unmerged = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)
  expect(unmerged.filter((f) => !f.startsWith('.vx/'))).toEqual([])
  const check = vx(r, 'lock', '--check')
  if (unmerged.length === 0 && check.code === 0) return 'clean'
  expect(check.err).toContain('run `vx lock`')
  const run = vx(r, 'run', '--all', 'build')
  expect(run.code).not.toBe(0)
  expect(run.err).toContain('vx lock')
  expect(vx(r, 'lock').code).toBe(0)
  expect(vx(r, 'lock', '--check').code).toBe(0)
  return 'relocked'
}

const lockText = () => Bun.file(path.join(root!, LOCK)).text()
const readLock = async () => (await readLockfile(root!))!.projects

it('merges two branches that edit different tasks of the same project', async () => {
  const tasks = { build: 'echo b', lint: 'echo l', test: 'echo t' }
  const outcome = await merged(
    (r) => addProject(r, 'a', tasksConfig(tasks)),
    (r) => Bun.write(configOf(r, 'a'), tasksConfig({ ...tasks, build: 'echo b2' })),
    (r) => Bun.write(configOf(r, 'a'), tasksConfig({ ...tasks, test: 'echo t2' })),
  )
  expect(outcome).toBe('clean')
  const text = await lockText()
  expect([text.includes('echo b2'), text.includes('echo t2')]).toEqual([true, true])
})

// The commonest merge in a busy workspace: one branch adds a project, the
// other edits the project its lines land next to, before or after it.
const h = (n: string) => Bun.hash.xxHash3(n)
// In name-hash order: d, b, c, a.
const fourProjects = ['a', 'b', 'c', 'd']
// A name that hashes between b and c.
const between = Array.from({ length: 500 }, (_, i) => `p${i}`).find(
  (n) => h(n) > h('b') && h(n) < h('c'),
)!
for (const edited of ['b', 'c'])
  it(`merges a new project on one branch with an edit to its neighbour ${edited}`, async () => {
    const outcome = await merged(
      async (r) => {
        for (const n of fourProjects) await addProject(r, n, config(`echo ${n}`))
      },
      (r) => Bun.write(configOf(r, edited), config(`echo ${edited}2`)),
      (r) => addProject(r, between, config('echo added')),
    )
    expect(outcome).toBe('clean')
    const text = await lockText()
    expect([text.includes(`echo ${edited}2`), text.includes('echo added')]).toEqual([true, true])
  })

it('merges two branches that each rename a task', async () => {
  const tasks = { build: 'echo b', lint: 'echo l', test: 'echo t' }
  const outcome = await merged(
    async (r) => {
      await addProject(r, 'a', tasksConfig(tasks))
      await addProject(r, 'b', tasksConfig(tasks))
    },
    // Ours renames a task in a and one in b; theirs another in a.
    async (r) => {
      await Bun.write(
        configOf(r, 'a'),
        tasksConfig({ zbuild: 'echo b', lint: 'echo l', test: 'echo t' }),
      )
      await Bun.write(
        configOf(r, 'b'),
        tasksConfig({ build: 'echo b', check: 'echo l', test: 'echo t' }),
      )
    },
    (r) =>
      Bun.write(
        configOf(r, 'a'),
        tasksConfig({ build: 'echo b', lint: 'echo l', atest: 'echo t' }),
      ),
  )
  // Both moved a's task lines: one hunk, which `vx lock` settles.
  expect(outcome).toBe('relocked')
  const a = (await readLock())['packages/a']!.config!.tasks!
  expect(Object.keys(a).sort()).toEqual(['atest', 'lint', 'zbuild'])
})

// c is removed; b sits right before it and a right after.
for (const edited of ['b', 'a'])
  it(`merges a project removed on one branch with an edit to its neighbour ${edited}`, async () => {
    const outcome = await merged(
      async (r) => {
        for (const n of fourProjects) await addProject(r, n, config(`echo ${n}`))
      },
      (r) => rm(path.join(r, 'packages/c'), { recursive: true }),
      (r) => Bun.write(configOf(r, edited), config(`echo ${edited}2`)),
    )
    expect(outcome).toBe('clean')
    const projects = await readLock()
    expect(Object.keys(projects).sort()).toEqual(['packages/a', 'packages/b', 'packages/d'])
    expect(JSON.stringify(projects[`packages/${edited}`])).toContain(`echo ${edited}2`)
  })

it('merges an edit to a task another project shares with a project that adds it', async () => {
  const outcome = await merged(
    async (r) => {
      for (const n of ['a', 'b']) await addProject(r, n, config('echo same'))
    },
    async (r) => {
      for (const n of ['a', 'b']) await Bun.write(configOf(r, n), config('echo edited'))
    },
    (r) => addProject(r, 'c', config('echo same')),
  )
  // Ours moves the shared JSON off a's line; theirs keeps it there.
  expect(outcome).toBe('relocked')
  const text = await lockText()
  expect([text.includes('echo edited'), text.includes('echo same')]).toEqual([true, true])
})
