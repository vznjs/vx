// Inside git the manifest walk never goes above the top-level. A
// submodule's `.git` points into its superproject's `.git/modules`, and the
// walk goes on; a worktree of that submodule points there too, and is a
// top-level of its own.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { findManifestRoot } from '../src/packages.js'

let shared: string

const file = async (rel: string, body: string): Promise<void> => {
  await mkdir(path.dirname(path.join(shared, rel)), { recursive: true })
  await writeFile(path.join(shared, rel), body)
}

beforeEach(async () => {
  shared = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-git-top-')))
  // Claims every directory below it; read only from outside git.
  await file('package.json', JSON.stringify({ name: 'above', private: true, workspaces: ['*'] }))
  await file('wt/package.json', JSON.stringify({ name: 'wt' }))
})

afterEach(async () => {
  await rm(shared, { recursive: true, force: true })
})

const found = async (dir: string): Promise<string> =>
  path.relative(shared, await findManifestRoot(path.join(shared, dir))) || '.'

it("a submodule's worktree never reads the manifest above it", async () => {
  await file('wt/.git', `gitdir: ${shared}/super/.git/modules/sub/worktrees/wt\n`)
  await file('super/.git/modules/sub/worktrees/wt/commondir', '../..\n')
  expect(await found('wt')).toBe('wt')
})

it('CONTROL: a submodule walks on to the manifest above', async () => {
  await file('wt/.git', `gitdir: ${shared}/super/.git/modules/sub\n`)
  await mkdir(path.join(shared, 'super/.git/modules/sub'), { recursive: true })
  expect(await found('wt')).toBe('.')
})
