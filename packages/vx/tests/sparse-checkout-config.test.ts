// A sparse checkout leaves a locked project's config out of the worktree
// (skip-worktree in the index). It is not a deleted config: `vx lock`
// dropped the project from the committed lock, and a dependant ran or
// hit without its dependency. A run that needs it names the sparse
// checkout; one that does not proceeds; `vx lock` and `--check` refuse.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const BUILD = `export default { tasks: { build: { exec: { command: 'echo built' }, dependsOn: ['^build'] } } }\n`

async function vx(root: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

const REFUSAL =
  '✗ vx run  packages/lib ("lib") is outside this sparse checkout, but this run needs its vx.config.mjs — run `git sparse-checkout add packages/lib`'

let root: string
beforeEach(async () => {
  // With no manifest left, the excluded project is named by its path, as
  // core names it; a lockfile plugin gives the edge by directory.
  root = await makeWorkspace({ prefix: 'vx-sparse-', edges: { app: ['lib', 'packages/lib'] } })
  for (const name of ['app', 'lib', 'other']) await addProject(root, name, { config: BUILD })
  const lock = await vx(root, ['lock'])
  expect(`${lock.code}\n${lock.err}`).toStartWith('0\n')
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  git('sparse-checkout', 'set', '--no-cone', '/*', '!/packages/lib/')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

it('a run that selects the excluded project names the sparse checkout', async () => {
  expect(await Bun.file(path.join(root, 'packages/lib/vx.config.mjs')).exists()).toBe(false)
  const r = await vx(root, ['run', 'build', '--all'])
  expect([r.code, r.err.trim()]).toEqual([1, REFUSAL])
}, 30_000)

it('a run whose task depends on the excluded project is refused', async () => {
  const r = await vx(root, ['run', 'build', '--filter', 'app'])
  expect([r.code, r.out.includes('built'), r.err.trim()]).toEqual([1, false, REFUSAL])
}, 30_000)

it('a run that does not need the excluded project proceeds', async () => {
  const r = await vx(root, ['run', 'build', '--filter', 'other', '--output-logs=full'])
  expect(`${r.code}\n${r.err}`).toStartWith('0\n')
  expect(r.out).toContain('built')
}, 30_000)

it('vx lock and its --check refuse what the sparse checkout left out, the lock untouched', async () => {
  const lockFile = path.join(root, '.vx/projects.lock.json')
  const before = await Bun.file(lockFile).text()
  const said =
    'packages/lib is outside this sparse checkout, so vx lock cannot read its vx.config.mjs — run `git sparse-checkout add packages/lib`'
  for (const args of [['lock'], ['lock', '--check']]) {
    const r = await vx(root, args)
    expect([r.code, r.err.includes(said)]).toEqual([1, true])
  }
  expect(await Bun.file(lockFile).text()).toBe(before)
}, 30_000)
