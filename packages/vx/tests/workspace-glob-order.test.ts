// Member globs with negations and nested manifests, probed against npm 10,
// bun 1.4 and pnpm 9 (D-147). A negation applies wherever it sits, as
// pnpm reads it; `**` reaches a manifest nested in a member (a fixture),
// as npm does, and never one under `node_modules`.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { listProjects, loadWorkspace } from '../src/workspace/workspace.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

const DIRS = ['packages/a', 'packages/b', 'packages/a/c', 'packages/a/node_modules/x']
const FIXTURE = 'packages/a/test/fixtures/f'

/** The member dirs `globs` finds over `dirs`, sorted. */
const members = async (globs: string[], dirs = DIRS, yaml = false) => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-glob-order-')))
  const ws = yaml ? {} : { workspaces: globs }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', ...ws }))
  if (yaml) {
    const list = globs.map((g) => `  - "${g}"`).join('\n')
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), `packages:\n${list}\n`)
  }
  for (const d of dirs) {
    await mkdir(path.join(root, d), { recursive: true })
    await writeFile(
      path.join(root, d, 'package.json'),
      JSON.stringify({ name: d.replaceAll('/', '-') }),
    )
  }
  const found = await listProjects(await loadWorkspace(root))
  return found.map((p) => p.dir.slice(root!.length + 1)).sort()
}

it('a negation listed first still excludes (npm and pnpm agree)', async () => {
  expect(await members(['!packages/b', 'packages/*'])).toEqual(['packages/a'])
})

it('a later positive glob does not re-include what a negation excluded', async () => {
  // npm 10 and bun 1.4 list `packages/b` here; pnpm 9 does not.
  expect(await members(['packages/*', '!packages/b', 'packages/b'])).toEqual(['packages/a'])
  expect(await members(['packages/*', '!packages/b', 'packages/b'], DIRS, true)).toEqual([
    'packages/a',
  ])
})

it('`**` finds a manifest nested in a member, never one under node_modules', async () => {
  expect(await members(['packages/**'], [...DIRS, FIXTURE])).toEqual([
    'packages/a',
    'packages/a/c',
    'packages/a/test/fixtures/f',
    'packages/b',
  ])
})

it('a wildcard negation takes the nested manifests back, in both manifests', async () => {
  const globs = ['packages/**', '!**/fixtures/**']
  const want = ['packages/a', 'packages/a/c', 'packages/b']
  expect(await members(globs, [...DIRS, FIXTURE])).toEqual(want)
  expect(await members(globs, [...DIRS, FIXTURE], true)).toEqual(want)
})

it('a `/**` negation excludes the directory itself, its tree with it', async () => {
  expect(await members(['packages/**', '!packages/a/**'])).toEqual(['packages/b'])
})

it('CONTROL: no negation finds every member', async () => {
  expect(await members(['packages/*'])).toEqual(['packages/a', 'packages/b'])
})
