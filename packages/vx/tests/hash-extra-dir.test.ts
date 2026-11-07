// A `file:` directory a lockfile names is hashed file by file, its
// `node_modules` and `.git` aside. The scan listed every file under them
// and dropped them after: a 30k-file node_modules cost a warm run 120 ms.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { hashExtra } from '../src/orchestrator/lockfile-claim.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-hash-dir-'))
  await mkdir(path.join(root, 'dep/src'), { recursive: true })
  await writeFile(path.join(root, 'dep/index.js'), '1')
  await writeFile(path.join(root, 'dep/src/a.js'), '2')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('the walk never enters node_modules or .git', async () => {
  const before = await hashExtra(root, 'dep')
  // A link to the filesystem's root: a walk that entered either one listed
  // the whole machine before dropping it.
  for (const skipped of ['node_modules', 'src/node_modules', '.git']) {
    await mkdir(path.join(root, 'dep', skipped), { recursive: true })
    await symlink('/', path.join(root, 'dep', skipped, 'up'))
  }
  expect(await hashExtra(root, 'dep')).toBe(before)
})

it('a linked file and a linked directory are hashed by their content', async () => {
  await mkdir(path.join(root, 'other'))
  await writeFile(path.join(root, 'other/o.js'), '3')
  await symlink('../other', path.join(root, 'dep/lnk'))
  await symlink('index.js', path.join(root, 'dep/fl'))
  const before = await hashExtra(root, 'dep')
  await writeFile(path.join(root, 'other/o.js'), '4')
  const afterDir = await hashExtra(root, 'dep')
  expect(afterDir).not.toBe(before)
  await writeFile(path.join(root, 'dep/index.js'), '5')
  expect(await hashExtra(root, 'dep')).not.toBe(afterDir)
})

it('a link back to an ancestor is not walked again, and a dangling one is no file', async () => {
  const before = await hashExtra(root, 'dep')
  await symlink('..', path.join(root, 'dep/src/loop'))
  await symlink('nowhere', path.join(root, 'dep/broken'))
  expect(await hashExtra(root, 'dep')).toBe(before)
})
