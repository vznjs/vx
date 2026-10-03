// A path inside a submodule makes `git check-ignore` refuse the whole
// batch (exit 128, "is in submodule"), and the judgement read that as
// nothing ignored: a pid file a task rewrites, judged in the same window
// as a write under the submodule, started cycles again — the loop the
// filter exists to stop. The paths around the refused one still answer.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { gitIgnored } from '../src/cli/watch-filter.js'
import { gitIn, gitInit } from './helpers/workspace.js'

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

async function repoWithSubmodule(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-ignore-sub-'))
  gitInit(root)
  await writeFile(path.join(root, '.gitignore'), '*.pid\n!keep.pid\n')
  await mkdir(path.join(root, 'proj', 'nested'), { recursive: true })
  for (const f of ['proj/x.pid', 'proj/y.pid', 'proj/keep.pid', 'proj/a.txt', 'proj/nested/f'])
    await writeFile(path.join(root, f), '')
  gitIn(root)('update-index', '--add', '--cacheinfo', `160000,${'f'.repeat(40)},proj/nested`)
  return root
}

it('a path inside a submodule leaves the rest of the batch answered', async () => {
  dir = await repoWithSubmodule()
  const at = (rel: string) => path.join(dir!, rel)
  const asked = ['proj/nested/f', 'proj/x.pid', 'proj/a.txt', 'proj/keep.pid', 'proj/y.pid'].map(at)
  expect([...gitIgnored(dir, asked)].sort()).toEqual([at('proj/x.pid'), at('proj/y.pid')])
})

it('two submodule paths first refuse nothing after them', async () => {
  dir = await repoWithSubmodule()
  const at = (rel: string) => path.join(dir!, rel)
  const asked = ['proj/nested/f', 'proj/nested/g', 'proj/x.pid', 'proj/a.txt'].map(at)
  expect([...gitIgnored(dir, asked)]).toEqual([at('proj/x.pid')])
})

it('a submodule path last refuses nothing before it', async () => {
  dir = await repoWithSubmodule()
  const at = (rel: string) => path.join(dir!, rel)
  const asked = ['proj/x.pid', 'proj/a.txt', 'proj/keep.pid', 'proj/y.pid', 'proj/nested/f'].map(at)
  expect([...gitIgnored(dir, asked)].sort()).toEqual([at('proj/x.pid'), at('proj/y.pid')])
})

// Controls: the batch without the submodule path (a negation is not
// ignored), and no repository at all (nothing is).
it('without the submodule path the batch answers as git does', async () => {
  dir = await repoWithSubmodule()
  const at = (rel: string) => path.join(dir!, rel)
  const asked = ['proj/x.pid', 'proj/a.txt', 'proj/keep.pid', 'proj/y.pid'].map(at)
  expect([...gitIgnored(dir, asked)].sort()).toEqual([at('proj/x.pid'), at('proj/y.pid')])
})

it('outside a repository nothing is ignored', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-ignore-sub-'))
  await writeFile(path.join(dir, '.gitignore'), '*.pid\n')
  expect([...gitIgnored(dir, [path.join(dir, 'x.pid'), path.join(dir, 'y.pid')])]).toEqual([])
})
